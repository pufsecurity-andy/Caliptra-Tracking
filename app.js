/* Caliptra 更新儀表板 — 純前端，無相依套件。 */
(function () {
  'use strict';

  var CFG = Object.assign({
    org: 'chipsalliance',
    keyword: 'caliptra',
    extraRepos: [],
    excludeRepos: [],
    commitsShown: 5,
    releasesShown: 4,
    weeks: 8,
    freshDays: 7,
    staleDays: 30
  }, window.TRACKER_CONFIG || {});

  var API = 'https://api.github.com';
  var RAW = 'https://raw.githubusercontent.com';
  var WEEK = 7 * 86400000;
  var COMMITS_KEPT = 40;      // 每個 repo 留幾筆 commit 在快取裡
  var DIFF_KEPT = 120;        // 最多快取幾筆 commit 的 diff
  var PATCH_MAX_LINES = 400;  // 單一檔案 diff 超過就截斷

  var KEY = {
    cache: 'caliptra-tracker.cache',
    diffs: 'caliptra-tracker.diffs',
    deps: 'caliptra-tracker.deps',
    depsView: 'caliptra-tracker.depsview',
    refs: 'caliptra-tracker.refs',
    seen: 'caliptra-tracker.seen',
    token: 'caliptra-tracker.token',
    theme: 'caliptra-tracker.theme'
  };

  var state = {
    repos: [],
    data: {},        // full_name -> { pushed_at, commits, commitDates, releases, tags }
    diffs: {},       // sha -> { files, stats, seq }
    deps: null,      // { analysedAt, edges, external, calls }
    depsRendered: null,
    depsView: 'graph',
    depsRoot: '',
    depsRef: '',
    depsHidden: {},
    refCache: {},
    refError: {},
    refLoading: '',
    diffSeq: 0,
    expandedList: {},// full_name -> true（commit 清單已展開全部）
    fetchedAt: null,
    seenAt: null,
    rate: null,
    calls: 0,
    busy: false,
    drawer: null
  };

  /* ---------- localStorage（無痕或擋 cookie 時要能不炸） ---------- */

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); return true; }
    catch (e) {
      // 空間不足時先丟掉最占空間的 diff 快取再試一次
      try { localStorage.removeItem(KEY.diffs); localStorage.setItem(k, v); state.diffs = {}; return true; }
      catch (e2) { return false; }
    }
  }

  /* ---------- 小工具 ---------- */

  var $ = function (sel) { return document.querySelector(sel); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function safeUrl(u) {
    return /^https?:\/\//i.test(String(u || '')) ? String(u) : '';
  }

  function daysSince(iso) {
    if (!iso) return Infinity;
    return (Date.now() - new Date(iso).getTime()) / 86400000;
  }

  function relTime(iso) {
    if (!iso) return '—';
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return '剛剛';
    if (s < 3600) return Math.floor(s / 60) + ' 分前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小時前';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
    if (s < 86400 * 365) return Math.floor(s / 2592000) + ' 個月前';
    return Math.floor(s / 31536000) + ' 年前';
  }

  function fullTime(iso) {
    return iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false }) : '';
  }

  function freshness(iso) {
    var d = daysSince(iso);
    if (d <= CFG.freshDays) return 'fresh';
    if (d <= CFG.staleDays) return 'warm';
    return 'stale';
  }

  function isNew(iso) {
    return !!(state.seenAt && iso && new Date(iso) > new Date(state.seenAt));
  }

  /* ---------- GitHub API ---------- */

  function getToken() { return lsGet(KEY.token) || ''; }

  function ApiError(status, message, resetAt) {
    this.status = status; this.message = message; this.resetAt = resetAt;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function gh(path, params) {
    var url = new URL(API + path);
    Object.keys(params || {}).forEach(function (k) { url.searchParams.set(k, params[k]); });

    var headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    var token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    state.calls++;
    return fetch(url.toString(), { headers: headers }).then(function (res) {
      var remaining = res.headers.get('x-ratelimit-remaining');
      var reset = res.headers.get('x-ratelimit-reset');
      if (remaining !== null) {
        state.rate = { remaining: Number(remaining), reset: reset ? Number(reset) * 1000 : null };
        renderRate();
      }
      if (res.ok) return res.json();

      if ((res.status === 403 || res.status === 429) && state.rate && state.rate.remaining === 0) {
        throw new ApiError(res.status, 'GitHub API 額度已用完', state.rate.reset);
      }
      return res.text().then(function (body) {
        var msg = '';
        try { msg = JSON.parse(body).message || ''; } catch (e) { msg = ''; }
        throw new ApiError(res.status, msg || ('HTTP ' + res.status));
      });
    });
  }

  function errText(err) {
    if (err instanceof ApiError && err.resetAt) {
      var when = new Date(err.resetAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
      return 'GitHub API 額度已用完，' + when + ' 才會重置。到「設定」填入 Personal Access Token 可提高到 5000 次／小時。';
    }
    if (err instanceof ApiError && err.status === 404) return '找不到這個資源（可能已改名或是私有的）。';
    return err && err.message ? err.message : '發生未知錯誤。';
  }

  /* ---------- 抓 repo 清單 ---------- */

  function normalizeRepo(r) {
    if (!r || !r.full_name) return null;
    return {
      full_name: r.full_name,
      name: r.name,
      html_url: r.html_url || ('https://github.com/' + r.full_name),
      description: r.description || '',
      default_branch: r.default_branch,
      pushed_at: r.pushed_at,
      archived: !!r.archived
    };
  }

  function isExcluded(fullName) {
    var name = String(fullName || '').split('/')[1];
    return (CFG.excludeRepos || []).some(function (x) { return x === fullName || x === name; });
  }

  function loadRepoList() {
    var collected = [];

    function page(n) {
      return gh('/orgs/' + CFG.org + '/repos', { per_page: 100, page: n, type: 'public' })
        .then(function (batch) {
          collected = collected.concat(batch);
          if (batch.length === 100 && n < 5) return page(n + 1);
          return collected;
        });
    }

    return page(1).then(function (all) {
      var kw = (CFG.keyword || '').toLowerCase();
      var picked = all.filter(function (r) {
        return !kw || r.name.toLowerCase().indexOf(kw) !== -1;
      }).map(normalizeRepo);

      var seen = {};
      picked.forEach(function (r) { seen[r.full_name] = true; });

      // 手動補充的 repo：同一個 org 的直接從剛才的清單撈，省一次 API
      var inOrg = {};
      all.forEach(function (r) { inOrg[r.full_name] = r; });

      var extras = [];
      (CFG.extraRepos || []).forEach(function (fn) {
        if (fn.indexOf('/') === -1 || seen[fn]) return;
        if (inOrg[fn]) { picked.push(normalizeRepo(inOrg[fn])); seen[fn] = true; }
        else extras.push(fn);
      });

      return Promise.all(extras.map(function (fn) {
        return gh('/repos/' + fn).then(normalizeRepo, function () { return null; });
      })).then(function (results) {
        results.forEach(function (r) { if (r) picked.push(r); });
        // 回應長得不對就整筆丟掉，不要讓一筆壞資料打斷整次更新
        return picked.filter(function (r) {
          return r && r.full_name && r.name && !isExcluded(r.full_name);
        });
      });
    });
  }

  /* ---------- 抓單一 repo 的內容 ---------- */

  function loadRepoData(repo) {
    var since = new Date(Date.now() - CFG.weeks * WEEK).toISOString();

    var commits = gh('/repos/' + repo.full_name + '/commits', {
      sha: repo.default_branch, since: since, per_page: 100
    }).then(function (list) {
      return list.map(function (c) {
        var msg = c.commit.message || '';
        var nl = msg.indexOf('\n');
        return {
          sha: c.sha,
          url: c.html_url,
          title: nl === -1 ? msg : msg.slice(0, nl),
          body: nl === -1 ? '' : msg.slice(nl + 1).replace(/^\s+|\s+$/g, ''),
          author: (c.author && c.author.login) || (c.commit.author && c.commit.author.name) || 'unknown',
          date: (c.commit.author && c.commit.author.date) || (c.commit.committer && c.commit.committer.date)
        };
      });
    });

    var releases = gh('/repos/' + repo.full_name + '/releases', { per_page: CFG.releasesShown })
      .then(function (list) {
        return list.map(function (r) {
          return {
            name: r.name || r.tag_name,
            tag: r.tag_name,
            url: r.html_url,
            date: r.published_at || r.created_at,
            body: r.body || '',
            prerelease: !!r.prerelease
          };
        });
      }, function () { return []; });

    return Promise.all([commits, releases]).then(function (out) {
      var data = {
        pushed_at: repo.pushed_at,
        commits: out[0].slice(0, COMMITS_KEPT),
        commitDates: out[0].map(function (c) { return c.date; }),
        truncated: out[0].length >= 100,
        releases: out[1],
        tags: []
      };
      // 沒有發 release 的 repo，退而抓 tag 當作版本
      if (data.releases.length) return data;
      return gh('/repos/' + repo.full_name + '/tags', { per_page: CFG.releasesShown })
        .then(function (list) {
          data.tags = list.map(function (t) {
            return { name: t.name, url: 'https://github.com/' + repo.full_name + '/releases/tag/' + t.name };
          });
          return data;
        }, function () { return data; });
    });
  }

  // 單一 commit 的完整內容：改了哪些檔案、每個檔案的 diff
  function loadCommitDetail(fullName, sha) {
    return gh('/repos/' + fullName + '/commits/' + sha).then(function (c) {
      var files = (c.files || []).map(function (f) {
        var patch = f.patch || '';
        var lines = patch ? patch.split('\n') : [];
        var cut = lines.length > PATCH_MAX_LINES;
        return {
          filename: f.filename,
          previous: f.previous_filename || '',
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: cut ? lines.slice(0, PATCH_MAX_LINES).join('\n') : patch,
          cut: cut,
          binary: !patch && f.status !== 'removed'
        };
      });
      return {
        files: files,
        stats: c.stats || { additions: 0, deletions: 0 },
        parents: (c.parents || []).length,
        seq: ++state.diffSeq
      };
    });
  }

  /* ---------- 活躍度 ---------- */

  function weeklyBuckets(dates) {
    var n = CFG.weeks;
    var buckets = new Array(n).fill(0);
    var now = Date.now();
    (dates || []).forEach(function (d) {
      var age = now - new Date(d).getTime();
      if (age < 0) age = 0;
      var idx = n - 1 - Math.floor(age / WEEK);
      if (idx >= 0 && idx < n) buckets[idx]++;
    });
    return buckets;
  }

  function sparkline(buckets) {
    var w = 7, gap = 3, h = 30, max = Math.max.apply(null, buckets.concat([1]));
    var total = w * buckets.length + gap * (buckets.length - 1);
    var svg = '<svg class="spark" width="' + total + '" height="' + h + '" viewBox="0 0 ' + total + ' ' + h +
              '" role="img" aria-label="近 ' + buckets.length + ' 週每週 commit 數">';
    buckets.forEach(function (v, i) {
      var x = i * (w + gap);
      var bh = v === 0 ? 2 : Math.max(3, Math.round(v / max * (h - 2)));
      var cls = v === 0 ? 'b-zero' : (i === buckets.length - 1 ? 'b-now' : 'b');
      var ago = buckets.length - 1 - i;
      var label = (ago === 0 ? '本週' : ago + ' 週前') + '：' + v + ' 個 commit';
      svg += '<rect class="' + cls + '" x="' + x + '" y="' + (h - bh) + '" width="' + w +
             '" height="' + bh + '" rx="2"><title>' + esc(label) + '</title></rect>';
    });
    return svg + '</svg>';
  }

  /* ---------- release notes 的簡易 Markdown ---------- */

  function markdown(src) {
    var lines = String(src || '').split('\n');
    var html = '', inList = false, inCode = false;

    function inline(t) {
      t = esc(t);
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>');
      t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
        '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
      return t;
    }
    function closeList() { if (inList) { html += '</ul>'; inList = false; } }

    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      if (/^```/.test(line)) {
        closeList();
        html += inCode ? '</pre>' : '<pre class="md-code">';
        inCode = !inCode;
        return;
      }
      if (inCode) { html += esc(raw) + '\n'; return; }
      if (!line.trim()) { closeList(); return; }

      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeList(); html += '<h4>' + inline(h[2]) + '</h4>'; return; }

      var li = line.match(/^\s*[-*+]\s+(.*)$/);
      if (li) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += '<li>' + inline(li[1]) + '</li>';
        return;
      }
      closeList();
      html += '<p>' + inline(line) + '</p>';
    });
    closeList();
    if (inCode) html += '</pre>';
    return html || '<p class="muted">這個版本沒有附說明。</p>';
  }

  /* ---------- diff 呈現 ---------- */

  function patchHtml(patch) {
    return patch.split('\n').map(function (line) {
      var cls = 'ctx';
      if (/^\+\+\+|^---/.test(line)) cls = 'meta';
      else if (line[0] === '+') cls = 'add';
      else if (line[0] === '-') cls = 'del';
      else if (line[0] === '@') cls = 'hunk';
      return '<span class="l ' + cls + '">' + esc(line || ' ') + '</span>';
    }).join('');   // 每行已經是 block，<pre> 裡再加換行會變成兩倍行距
  }

  function fileHtml(f, open) {
    var head = '<summary><span class="f-name">' +
      (f.previous ? esc(f.previous) + ' → ' : '') + esc(f.filename) + '</span>' +
      '<span class="f-stat">' +
        (f.additions ? '<span class="add">+' + f.additions + '</span>' : '') +
        (f.deletions ? '<span class="del">−' + f.deletions + '</span>' : '') +
        '<span class="f-status">' + esc(fileStatus(f.status)) + '</span>' +
      '</span></summary>';

    var body;
    if (f.binary) body = '<p class="muted pad">二進位檔或內容過大，GitHub 沒有回傳 diff。</p>';
    else if (!f.patch) body = '<p class="muted pad">這個檔案沒有內容變更（可能只是改名或權限）。</p>';
    else body = '<pre class="patch">' + patchHtml(f.patch) + '</pre>' +
      (f.cut ? '<p class="muted pad">diff 太長，只顯示前 ' + PATCH_MAX_LINES + ' 行。</p>' : '');

    return '<details class="file"' + (open ? ' open' : '') + '>' + head + body + '</details>';
  }

  function fileStatus(s) {
    return { added: '新增', removed: '刪除', modified: '修改', renamed: '改名', copied: '複製', changed: '變更' }[s] || s || '';
  }

  /* ---------- 快取 ---------- */

  function saveCache() {
    lsSet(KEY.cache, JSON.stringify({ fetchedAt: state.fetchedAt, repos: state.repos, data: state.data }));
  }

  function saveDiffs() {
    // 只留最近用到的幾筆，避免把 localStorage 塞爆
    var keys = Object.keys(state.diffs);
    if (keys.length > DIFF_KEPT) {
      keys.sort(function (a, b) { return state.diffs[a].seq - state.diffs[b].seq; })
          .slice(0, keys.length - DIFF_KEPT)
          .forEach(function (k) { delete state.diffs[k]; });
    }
    lsSet(KEY.diffs, JSON.stringify({ seq: state.diffSeq, diffs: state.diffs }));
  }

  function loadCache() {
    try {
      var d = JSON.parse(lsGet(KEY.diffs) || '{}');
      state.diffs = d.diffs || {};
      state.diffSeq = d.seq || 0;
    } catch (e) { state.diffs = {}; }

    try { state.deps = JSON.parse(lsGet(KEY.deps) || 'null'); } catch (e) { state.deps = null; }
    try {
      var v = JSON.parse(lsGet(KEY.depsView) || '{}');
      state.depsRoot = v.root || '';
      state.depsRef = v.ref || '';
      state.depsHidden = v.hidden || {};
    } catch (e) { /* 用預設值 */ }
    try { state.refCache = JSON.parse(lsGet(KEY.refs) || '{}'); } catch (e) { state.refCache = {}; }
    // 之前版本可能存進失敗的空清單，開檔時先清掉
    Object.keys(state.refCache).forEach(function (k) {
      if (!refsUsable(k)) delete state.refCache[k];
    });

    var cached = lsGet(KEY.cache);
    if (!cached) return false;
    try {
      var c = JSON.parse(cached);
      state.repos = c.repos || [];
      state.data = c.data || {};
      state.fetchedAt = c.fetchedAt || null;
      return state.repos.length > 0;
    } catch (e) { return false; }
  }

  /* ---------- 畫面：頂部 ---------- */

  function banner(msg, kind) {
    var el = $('#banner');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.className = 'banner ' + (kind || 'info');
    el.textContent = msg;
  }

  function renderRate() {
    if (!state.rate) { $('#rate-line').textContent = ''; return; }
    var suffix = getToken() ? '（已使用 token）' : '（未使用 token，上限 60／小時）';
    $('#rate-line').textContent = 'API 剩餘 ' + state.rate.remaining + ' 次' + suffix;
  }

  function renderMeta() {
    var line = $('#meta-line');
    if (!state.fetchedAt) { line.textContent = '尚未抓取資料，按右上角「更新」開始。'; return; }
    var shown = visibleRepos().length;
    var count = shown === state.repos.length
      ? ('追蹤 ' + state.repos.length + ' 個 repo')
      : ('顯示 ' + shown + ' / 共 ' + state.repos.length + ' 個 repo');
    line.textContent = count + ' · 資料時間 ' + relTime(state.fetchedAt);
  }

  function tile(label, value, sub, kind) {
    return '<div class="tile ' + (kind || '') + '">' +
      '<div class="t-label">' + esc(label) + '</div>' +
      '<div class="t-value">' + esc(value) + '</div>' +
      '<div class="t-sub">' + esc(sub) + '</div></div>';
  }

  function renderStats() {
    var el = $('#stats');
    if (!state.repos.length) { el.innerHTML = ''; return; }

    var live = state.repos.filter(function (r) { return !r.archived; });
    var week = Date.now() - WEEK;
    var commits7 = 0, unread = 0;
    live.forEach(function (r) {
      var d = state.data[r.full_name];
      if (!d) return;
      (d.commitDates || []).forEach(function (x) {
        var t = new Date(x).getTime();
        if (t >= week) commits7++;
        if (state.seenAt && t > new Date(state.seenAt).getTime()) unread++;
      });
    });
    var active = live.filter(function (r) { return freshness(r.pushed_at) === 'fresh'; }).length;
    var newVer = live.filter(function (r) {
      var d = state.data[r.full_name];
      return d && d.releases && d.releases[0] && isNew(d.releases[0].date);
    }).length;

    el.innerHTML =
      tile('近 7 天 commit', commits7, '所有追蹤 repo 加總', 'hero') +
      tile('自上次查看以來', unread, unread ? '個新 commit' : '沒有新的', unread ? 'accent' : '') +
      tile('活躍 repo', active + ' / ' + live.length, CFG.freshDays + ' 天內有更新', '') +
      tile('新版本', newVer, newVer ? '個 repo 發了新 release' : '沒有新的 release', newVer ? 'accent' : '');
  }

  /* ---------- 畫面：卡片 ---------- */

  function visibleRepos() {
    var q = $('#search').value.trim().toLowerCase();
    var onlyNew = $('#only-new').checked;
    var showArchived = $('#show-archived').checked;

    var rows = state.repos.filter(function (r) {
      if (r.archived && !showArchived) return false;
      if (onlyNew && !isNew(r.pushed_at)) return false;
      if (!q) return true;
      var d = state.data[r.full_name];
      var hay = r.full_name + ' ' + r.description + ' ' +
        (d && d.commits ? d.commits.map(function (c) { return c.title + ' ' + c.body; }).join(' ') : '');
      return hay.toLowerCase().indexOf(q) !== -1;
    });

    var sort = $('#sort').value;
    rows.sort(function (a, b) {
      if (sort === 'name') return a.full_name.localeCompare(b.full_name);
      if (sort === 'active') {
        var ca = (state.data[a.full_name] || {}).commitDates || [];
        var cb = (state.data[b.full_name] || {}).commitDates || [];
        return cb.length - ca.length;
      }
      return new Date(b.pushed_at || 0) - new Date(a.pushed_at || 0);
    });
    return rows;
  }

  function versionHtml(repo) {
    var d = state.data[repo.full_name] || {};
    var rel = (d.releases || [])[0];

    if (rel) {
      var older = (d.releases || []).slice(1);
      return '<div class="version">' +
        '<div class="v-row">' +
          '<span class="v-label">最新版本</span>' +
          '<button class="v-tag" type="button" data-rel="0" data-repo="' + esc(repo.full_name) + '">' +
            esc(rel.tag) + (rel.prerelease ? ' <span class="v-pre">pre</span>' : '') + '</button>' +
          '<span class="v-when' + (isNew(rel.date) ? ' is-new' : '') + '">' +
            (isNew(rel.date) ? '新 · ' : '') + esc(relTime(rel.date)) + '</span>' +
        '</div>' +
        (older.length
          ? '<div class="v-older"><span class="v-label">更早</span>' + older.map(function (r, i) {
              return '<button class="v-old" type="button" data-rel="' + (i + 1) +
                     '" data-repo="' + esc(repo.full_name) + '">' + esc(r.tag) + '</button>';
            }).join('') + '</div>'
          : '') +
      '</div>';
    }

    if ((d.tags || []).length) {
      return '<div class="version">' +
        '<div class="v-row"><span class="v-label">最新 tag</span>' +
          '<a class="v-tag" href="' + esc(d.tags[0].url) + '" target="_blank" rel="noopener">' +
            esc(d.tags[0].name) + '</a>' +
          '<span class="v-when muted">沒有發佈 release</span>' +
        '</div>' +
        (d.tags.length > 1
          ? '<div class="v-older"><span class="v-label">更早</span>' + d.tags.slice(1).map(function (t) {
              return '<a class="v-old" href="' + esc(t.url) + '" target="_blank" rel="noopener">' +
                     esc(t.name) + '</a>';
            }).join('') + '</div>'
          : '') +
      '</div>';
    }

    return '<div class="version empty-v"><span class="v-label">版本</span>' +
           '<span class="muted">還沒有 release 或 tag</span></div>';
  }

  function cardHtml(repo) {
    var d = state.data[repo.full_name] || {};
    var buckets = weeklyBuckets(d.commitDates);
    var total = (d.commitDates || []).length;
    var base = 'https://github.com/' + repo.full_name;
    var showAll = state.expandedList[repo.full_name];
    var limit = showAll ? COMMITS_KEPT : CFG.commitsShown;

    var head =
      '<div class="c-head">' +
        (isNew(repo.pushed_at) ? '<span class="dot" title="有你尚未看過的更新"></span>' : '') +
        '<a class="c-name" href="' + esc(base) + '" target="_blank" rel="noopener">' + esc(repo.name) + '</a>' +
        (repo.archived ? '<span class="chip">已封存</span>' : '') +
        '<span class="c-time" title="' + esc(fullTime(repo.pushed_at)) + '">' +
          esc(relTime(repo.pushed_at)) + '</span>' +
      '</div>' +
      '<p class="c-desc">' + esc(repo.description || '（沒有說明）') + '</p>';

    var strip =
      '<div class="c-strip">' + sparkline(buckets) +
        '<span class="s-count">近 ' + CFG.weeks + ' 週 <strong>' +
          esc(total + (d.truncated ? '+' : '')) + ' commit</strong></span>' +
      '</div>';

    var body;
    if (d.error) {
      body = '<p class="c-error">' + esc(d.error) + '</p>';
    } else if (!d.commits || !d.commits.length) {
      body = '<p class="c-empty">近 ' + CFG.weeks + ' 週沒有新的 commit。</p>';
    } else {
      body = '<ul class="commits">';
      d.commits.slice(0, limit).forEach(function (c) {
        body += '<li>' +
          (isNew(c.date) ? '<span class="tag-new">NEW</span>' : '<span class="tag-spacer"></span>') +
          '<button class="c-title" type="button" data-repo="' + esc(repo.full_name) + '" data-sha="' +
            esc(c.sha) + '" title="' + esc(c.title) + '">' + esc(c.title) +
            (c.body ? '<span class="has-body" title="有詳細說明">¶</span>' : '') + '</button>' +
          '<span class="c-when">' + esc(relTime(c.date)) + '</span>' +
        '</li>';
      });
      body += '</ul>';
      if (d.commits.length > limit) {
        body += '<button class="more" type="button" data-more="' + esc(repo.full_name) + '">' +
                '顯示其餘 ' + (d.commits.length - limit) + ' 筆</button>';
      } else if (showAll && d.commits.length > CFG.commitsShown) {
        body += '<button class="more" type="button" data-more="' + esc(repo.full_name) + '">收合</button>';
      }
    }

    return '<article class="card f-' + freshness(repo.pushed_at) + (repo.archived ? ' archived' : '') + '">' +
      head + versionHtml(repo) + depsCardHtml(repo) + strip + body + '</article>';
  }

  function render() {
    renderMeta();
    renderStats();
    renderDeps();

    var grid = $('#grid');
    var rows = visibleRepos();
    if (!rows.length) {
      grid.innerHTML = state.repos.length
        ? '<p class="empty">沒有符合條件的 repo。</p>'
        : '<p class="empty">還沒有資料。按右上角「更新」抓取 ' + esc(CFG.org) + ' 底下的 Caliptra repo。</p>';
      return;
    }
    grid.innerHTML = rows.map(cardHtml).join('');
  }

  /* ---------- 抽屜：commit 完整內容 / release notes ---------- */

  function openDrawer(eyebrow, title, bodyHtml) {
    $('#drawer-eyebrow').textContent = eyebrow;
    $('#drawer-title').textContent = title;
    $('#drawer-body').innerHTML = bodyHtml;
    $('#drawer-body').scrollTop = 0;
    var d = $('#drawer');
    if (d.hidden) {
      state.drawer = document.activeElement;
      d.hidden = false;
      document.body.classList.add('no-scroll');
      $('#drawer-close').focus();
    }
  }

  function closeDrawer() {
    var d = $('#drawer');
    if (d.hidden) return;
    d.hidden = true;
    document.body.classList.remove('no-scroll');
    if (state.drawer && state.drawer.focus) state.drawer.focus();
    state.drawer = null;
  }

  function commitBodyHtml(repo, commit, detail) {
    var html = '<div class="d-meta">' +
      '<span>' + esc(commit.author) + '</span>' +
      '<span>' + esc(fullTime(commit.date)) + '</span>' +
      '<code>' + esc(commit.sha.slice(0, 10)) + '</code>' +
      '<a href="' + esc(safeUrl(commit.url)) + '" target="_blank" rel="noopener">在 GitHub 開啟</a>' +
      '</div>';

    if (commit.body) html += '<pre class="d-message">' + esc(commit.body) + '</pre>';

    if (!detail) return html + '<p class="loading">讀取變更內容…</p>';
    if (detail.error) return html + '<p class="c-error">' + esc(detail.error) + '</p>';

    var files = detail.files || [];
    html += '<div class="d-stats">' +
      '<span><strong>' + files.length + '</strong> 個檔案</span>' +
      '<span class="add">+' + (detail.stats.additions || 0) + '</span>' +
      '<span class="del">−' + (detail.stats.deletions || 0) + '</span>' +
      '</div>';

    if (!files.length) {
      html += '<p class="muted">' + (detail.parents > 1
        ? '這是一筆 merge commit，GitHub 不會回傳合併後的檔案差異。'
        : 'GitHub 沒有回傳這筆 commit 的檔案清單（可能檔案數過多）。') + '</p>';
      return html;
    }

    html += '<div class="files">' + files.map(function (f, i) {
      return fileHtml(f, i < 2);
    }).join('') + '</div>';
    return html;
  }

  function showCommit(fullName, sha) {
    var repo = state.repos.filter(function (r) { return r.full_name === fullName; })[0];
    var data = state.data[fullName] || {};
    var commit = (data.commits || []).filter(function (c) { return c.sha === sha; })[0];
    if (!repo || !commit) return;

    var cached = state.diffs[sha];
    openDrawer(repo.name, commit.title, commitBodyHtml(repo, commit, cached));
    if (cached) { cached.seq = ++state.diffSeq; return; }

    loadCommitDetail(fullName, sha).then(function (detail) {
      state.diffs[sha] = detail;
      saveDiffs();
      if (!$('#drawer').hidden && $('#drawer-title').textContent === commit.title) {
        $('#drawer-body').innerHTML = commitBodyHtml(repo, commit, detail);
      }
    }, function (err) {
      if (!$('#drawer').hidden) {
        $('#drawer-body').innerHTML = commitBodyHtml(repo, commit, { error: errText(err) });
      }
    });
  }

  function showRelease(fullName, idx) {
    var repo = state.repos.filter(function (r) { return r.full_name === fullName; })[0];
    var rel = ((state.data[fullName] || {}).releases || [])[idx];
    if (!repo || !rel) return;

    var html = '<div class="d-meta">' +
      '<span>' + esc(rel.tag) + (rel.prerelease ? ' · pre-release' : '') + '</span>' +
      '<span>' + esc(fullTime(rel.date)) + '</span>' +
      '<a href="' + esc(safeUrl(rel.url)) + '" target="_blank" rel="noopener">在 GitHub 開啟</a>' +
      '</div><div class="md">' + markdown(rel.body) + '</div>';

    openDrawer(repo.name + ' · release', rel.name || rel.tag, html);
  }

  /* ---------- 相依分析 ---------- */

  // .gitmodules 與 Cargo.toml 從 raw.githubusercontent.com 讀，不算 GitHub API 額度。
  // ref 可以是分支、tag 或 commit sha，所以「看某個版本綁了什麼」也走同一條路。
  function raw(fullName, ref, path) {
    return fetch(RAW + '/' + fullName + '/' + encodeURIComponent(ref) + '/' + path)
      .then(function (res) { return res.ok ? res.text() : null; }, function () { return null; });
  }

  function shortRef(ref) {
    return /^[0-9a-f]{40}$/i.test(ref || '') ? ref.slice(0, 7) : (ref || '');
  }

  // https://github.com/owner/name(.git) → owner/name
  function repoFromUrl(url) {
    var m = String(url || '').match(/github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
    return m ? m[1] + '/' + m[2] : null;
  }

  function parseGitmodules(text) {
    if (!text) return [];
    var out = [], cur = null;
    text.split('\n').forEach(function (line) {
      var head = line.match(/^\s*\[submodule\s+"([^"]*)"\]/);
      if (head) { cur = { name: head[1], path: '', url: '', branch: '' }; out.push(cur); return; }
      if (!cur) return;
      var kv = line.match(/^\s*(path|url|branch)\s*=\s*(.+?)\s*$/);
      if (kv) cur[kv[1]] = kv[2];
    });
    return out.filter(function (s) { return s.path && s.url; });
  }

  // 抓 Cargo.toml 裡指向 git 的相依。單筆相依不會有巢狀 {}，所以 \{[^}]*\} 夠用。
  function parseCargoGit(text) {
    if (!text) return [];
    var out = [], seen = {}, re = /([A-Za-z0-9_-]+)\s*=\s*\{([^}]*)\}/g, m;
    while ((m = re.exec(text)) !== null) {
      var body = m[2];
      var git = body.match(/\bgit\s*=\s*"([^"]+)"/);
      if (!git) continue;
      var repo = repoFromUrl(git[1]);
      if (!repo) continue;
      var rev = body.match(/\brev\s*=\s*"([^"]+)"/);
      var tag = body.match(/\btag\s*=\s*"([^"]+)"/);
      var br  = body.match(/\bbranch\s*=\s*"([^"]+)"/);
      var pin = rev ? rev[1] : (tag ? tag[1] : (br ? br[1] : ''));
      var key = repo + '@' + pin;
      if (seen[key]) { seen[key].count++; continue; }
      seen[key] = { crate: m[1], repo: repo, sha: rev ? rev[1] : '', tag: tag ? tag[1] : '',
                    branch: br ? br[1] : '', count: 1 };
      out.push(seen[key]);
    }
    return out;
  }

  function trackedRepo(fullName) {
    return state.repos.filter(function (r) { return r.full_name === fullName; })[0] || null;
  }

  function shortName(fullName) { return fullName.split('/')[1] || fullName; }

  function analyseDeps() {
    if (state.busy) return;
    setBusy(true, '分析中…');
    banner('');
    state.calls = 0;

    var root = state.depsRoot && trackedRepo(state.depsRoot) ? state.depsRoot : '';
    var rootRef = root ? (state.depsRef || trackedRepo(root).default_branch) : '';
    var edges = [], external = [], repoTags = {}, shaTag = {}, nodeRefs = {};
    var scanned = {}, queue = [], MAX = 26;

    if (root) {
      queue.push({ repo: root, ref: rootRef });
    } else {
      state.repos.filter(function (r) { return !r.archived; }).forEach(function (r) {
        queue.push({ repo: r.full_name, ref: r.default_branch });
      });
    }

    function mkEdge(job, to, kind, ref) {
      return {
        from: job.repo, fromRef: job.ref, to: to, kind: kind, ref: ref,
        declaredBranch: '', sha: '', tag: '', behind: null, diverged: null,
        cmpStatus: '', latest: '', comparedTo: '', error: ''
      };
    }

    // 1. 讀宣告（免費），submodule 釘住的 commit 要問 API
    function scanNext() {
      if (!queue.length) return Promise.resolve();
      var job = queue.shift();
      var key = job.repo + '@' + job.ref;
      if (scanned[key]) return scanNext();
      if (Object.keys(scanned).length >= MAX) { queue.length = 0; return Promise.resolve(); }
      scanned[key] = 1;

      nodeRefs[job.repo] = nodeRefs[job.repo] || [];
      if (nodeRefs[job.repo].indexOf(job.ref) === -1) nodeRefs[job.repo].push(job.ref);

      banner('讀取 ' + shortName(job.repo) + ' @ ' + shortRef(job.ref) + ' 的相依宣告…', 'info');
      setBusy(true, '分析中 ' + Object.keys(scanned).length);

      return Promise.all([
        raw(job.repo, job.ref, '.gitmodules'),
        raw(job.repo, job.ref, 'Cargo.toml')
      ]).then(function (out) {
        var subs = parseGitmodules(out[0]);
        var cargos = parseCargoGit(out[1]);

        return series(subs, function (sm) {
          var target = repoFromUrl(sm.url);
          var e = mkEdge(job, target || sm.url, 'submodule', sm.path);
          e.declaredBranch = sm.branch || '';
          if (!target || !trackedRepo(target)) { external.push(e); return Promise.resolve(); }
          edges.push(e);
          return gh('/repos/' + job.repo + '/contents/' + sm.path, { ref: job.ref })
            .then(function (c) {
              if (c && !Array.isArray(c) && c.sha) {
                e.sha = c.sha;
                if (root) queue.push({ repo: target, ref: c.sha });
              } else { e.error = '取不到釘住的 commit'; }
            }, function (err) { e.error = errText(err); });
        }).then(function () {
          cargos.forEach(function (d) {
            var e = mkEdge(job, d.repo, 'cargo',
              d.crate + (d.count > 1 ? ' 等 ' + d.count + ' 個 crate' : ''));
            e.declaredBranch = d.branch; e.sha = d.sha; e.tag = d.tag;
            if (!trackedRepo(d.repo)) { external.push(e); return; }
            edges.push(e);
            if (root && d.sha) queue.push({ repo: d.repo, ref: d.sha });
          });
        });
      }).then(scanNext);
    }

    // 2. 每個出現過的 repo 抓 tag 清單：把 commit 對回版本名，也給版本下拉選單用
    function tagsStep() {
      var want = {};
      Object.keys(nodeRefs).forEach(function (r) { want[r] = 1; });
      edges.forEach(function (e) { want[e.to] = 1; want[e.from] = 1; });
      return series(Object.keys(want), function (t) {
        if (!trackedRepo(t)) return Promise.resolve();
        banner('讀取 ' + shortName(t) + ' 的版本清單…', 'info');
        return gh('/repos/' + t + '/tags', { per_page: 100 }).then(function (tags) {
          repoTags[t] = (tags || []).map(function (x) { return x.name; });
          (tags || []).forEach(function (x) { if (x.commit) shaTag[x.commit.sha] = x.name; });
          edges.forEach(function (e) {
            if (e.to === t && e.sha && !e.tag && shaTag[e.sha]) e.tag = shaTag[e.sha];
          });
        }, function () { /* 沒有 tag 就算了 */ });
      });
    }

    // 3. 每條邊離上游多遠
    function compareStep() {
      var todo = edges.filter(function (e) { return !!e.sha && trackedRepo(e.to); });
      var n = 0;
      return series(todo, function (e) {
        var target = trackedRepo(e.to);
        var head = e.declaredBranch || target.default_branch;
        e.comparedTo = head;
        banner('比對落後量 ' + (++n) + ' / ' + todo.length + '：' +
               shortName(e.from) + ' → ' + shortName(e.to), 'info');
        return gh('/repos/' + e.to + '/compare/' + e.sha + '...' + head, { per_page: 1 })
          .then(function (c) {
            e.behind = typeof c.ahead_by === 'number' ? c.ahead_by : null;
            e.diverged = typeof c.behind_by === 'number' ? c.behind_by : null;
            e.cmpStatus = c.status || '';
          }, function (err) { if (!e.error) e.error = errText(err); });
      });
    }

    return scanNext().then(tagsStep).then(compareStep).then(function () {
      edges.forEach(function (e) {
        var d = state.data[e.to];
        if (!d) return;
        if (d.releases && d.releases[0]) e.latest = d.releases[0].tag;
        else if (repoTags[e.to] && repoTags[e.to][0]) e.latest = repoTags[e.to][0];
        else if (d.tags && d.tags[0]) e.latest = d.tags[0].name;
      });
      state.deps = {
        analysedAt: new Date().toISOString(), root: root, rootRef: rootRef,
        edges: edges, external: external, repoTags: repoTags, shaTag: shaTag,
        nodeRefs: nodeRefs, calls: state.calls
      };
      lsSet(KEY.deps, JSON.stringify(state.deps));
      banner('分析完成，用了 ' + state.calls + ' 次 API。', 'info');
      setTimeout(function () { banner(''); }, 4000);
      $('#deps-body').hidden = false;
      state.depsRendered = null;
      render();
    }).catch(function (err) {
      banner(errText(err), 'error');
    }).then(function () { setBusy(false); });
  }

  // 逐一執行，不並發
  function series(items, fn) {
    return items.reduce(function (p, item) {
      return p.then(function () { return fn(item); });
    }, Promise.resolve());
  }

  // 釘住的 commit 不一定在被比較的分支上 —— 有好幾條是釘在 release 分支。
  // 那種情況說「落後 N」會誤導，要標成分歧並把兩邊各自多出多少講清楚。
  // 上游已知的版本，新到舊：先 release，再 tag，最後補上相依分析時抓到的完整 tag 清單
  function knownVersions(fullName) {
    var d = state.data[fullName] || {};
    var list = (d.releases || []).map(function (r) { return r.tag; })
      .concat((d.tags || []).map(function (t) { return t.name; }));
    var extra = (state.deps && state.deps.repoTags && state.deps.repoTags[fullName]) || [];
    extra.forEach(function (t) { if (list.indexOf(t) === -1) list.push(t); });
    return list;
  }

  function repoVersion(fullName) {
    return knownVersions(fullName)[0] || '';
  }

  function nodeVersionsFull(fullName) {
    var d = state.deps;
    if (d && d.root && d.nodeRefs && d.nodeRefs[fullName]) {
      var seen = {};
      return d.nodeRefs[fullName].map(function (r) {
        return (d.shaTag && d.shaTag[r]) || shortRef(r);
      }).filter(function (v) { if (seen[v]) return false; seen[v] = 1; return true; }).join('、');
    }
    return repoVersion(fullName) || '沒有 tag';
  }

  // 節點上要顯示的版本：指定起點時顯示「這個版本實際綁到的」，否則顯示上游最新版
  function nodeVersion(fullName) {
    var d = state.deps;
    if (d && d.root && d.nodeRefs && d.nodeRefs[fullName]) {
      var seen = {};
      var list = d.nodeRefs[fullName].map(function (r) {
        return (d.shaTag && d.shaTag[r]) || shortRef(r);
      }).filter(function (v) { if (seen[v]) return false; seen[v] = 1; return true; });
      var text = list.length > 2
        ? list.slice(0, 2).join(' / ') + ' +' + (list.length - 2)
        : list.join(' / ');
      if (text.length > 24) text = text.slice(0, 23) + '…';
      if (text) return text;
    }
    return repoVersion(fullName) || '沒有 tag';
  }

  function lagNote(e) {
    var to = e.comparedTo || 'main';
    if (e.cmpStatus === 'diverged') {
      return '釘在另一條分支：' + to + ' 另有 ' + e.behind + ' 個 commit，該分支自己有 ' +
             e.diverged + ' 個沒進 ' + to;
    }
    if (e.behind > 0) return '距 ' + to + ' ' + e.behind + ' 個 commit';
    return '';
  }

  // 釘 tag 的邊用版本比，釘 commit 的邊才用 commit 數比。
  // 釘在上游最新的 release 上，即使距離 main 幾百個 commit，也不算落後。
  function edgeState(e) {
    if (e.error) return { cls: 'unknown', label: '?', note: e.error };
    var note = lagNote(e);

    if (e.tag && e.latest && e.tag === e.latest) {
      return { cls: 'sync', label: '最新版本', note: note };
    }
    // 只有在上游的版本清單裡確實看到「釘的這個 tag 排在最新版之後」才敢說可以升版。
    // 找不到（例如打了 tag 但沒發 release）就退回用 commit 數判斷，不要亂猜方向。
    if (e.tag && e.latest) {
      var known = knownVersions(e.to);
      var iPin = known.indexOf(e.tag), iLatest = known.indexOf(e.latest);
      if (iLatest >= 0 && iPin > iLatest) {
        return { cls: 'behind', label: '可升到 ' + e.latest, note: note };
      }
    }
    if (e.cmpStatus === 'diverged') return { cls: 'diverged', label: '分歧', note: note };
    if (e.behind === 0) return { cls: 'sync', label: '同步', note: '' };
    if (e.behind > 0) return { cls: 'behind', label: '落後 ' + e.behind, note: note };
    return { cls: 'unknown', label: '—', note: '' };
  }

  function pinLabel(e) {
    if (e.tag) return e.tag;
    if (e.sha) return e.sha.slice(0, 7);
    if (e.declaredBranch) return '分支 ' + e.declaredBranch;
    return '—';
  }

  /* ---------- 相依關係圖（由分析結果自動排版） ---------- */

  // 分層 + 在中間層補虛擬節點，長線才有辦法從節點之間穿過去，
  // 而不是全部繞到畫布外側把中間塞滿橫線。
  function layeredLayout(edges) {
    var GAP = 30, DGAP = 14, ROW = 112, BH = 52, PAD = 24, DW = 8, MAXW = 208;
    function gapOf(a, b) {
      return (a.kind === 'dummy' || b.kind === 'dummy') ? DGAP : GAP;
    }
    function layerWidth(L) {
      var w = 0;
      L.forEach(function (it, i) { w += it.w; if (i) w += gapOf(L[i - 1], it); });
      return w;
    }

    // 1. 分層：沒有往外相依的排最底層；遇到環就地切斷
    var ids = {}, out = {};
    edges.forEach(function (e) {
      ids[e.from] = 1; ids[e.to] = 1;
      (out[e.from] = out[e.from] || []).push(e.to);
    });
    var rank = {}, mark = {};
    function visit(id) {
      if (rank[id] !== undefined) return rank[id];
      if (mark[id]) return 0;
      mark[id] = 1;
      var r = 0;
      (out[id] || []).forEach(function (t) { r = Math.max(r, visit(t) + 1); });
      return (rank[id] = r);
    }
    Object.keys(ids).forEach(visit);
    var maxRank = 0;
    Object.keys(rank).forEach(function (id) { maxRank = Math.max(maxRank, rank[id]); });

    // 2. 建出每一層的成員（真節點 + 虛擬節點）
    var layers = [], items = {};
    for (var r = 0; r <= maxRank; r++) layers[r] = [];
    Object.keys(ids).sort().forEach(function (id) {
      // 寬度要同時容得下名稱與版本字串，否則版本會凸出框外
      var it = {
        key: id, kind: 'node', id: id, rank: rank[id],
        w: Math.min(MAXW,
             Math.max(132, shortName(id).length * 7.4 + 30, nodeVersion(id).length * 6.5 + 30)),
        up: [], down: []
      };
      items[id] = it;
      layers[rank[id]].push(it);
    });

    var chains = [];
    edges.forEach(function (e, idx) {
      var a = items[e.from], b = items[e.to];
      if (!a || !b || a === b) return;
      var chain = [a], prev = a;
      for (var r2 = a.rank - 1; r2 > b.rank; r2--) {
        var d = { key: 'd' + idx + '@' + r2, kind: 'dummy', rank: r2, w: DW, up: [], down: [] };
        layers[r2].push(d);
        prev.down.push(d); d.up.push(prev);
        chain.push(d); prev = d;
      }
      prev.down.push(b); b.up.push(prev);
      chain.push(b);
      chains.push({ edge: e, chain: chain });
    });

    // 3. 重心法上下掃，減少交叉
    function norm(L) { L.forEach(function (it, i) { it.p = L.length > 1 ? i / (L.length - 1) : 0.5; }); }
    function sweep(dir) {
      layers.forEach(norm);
      var rs = [], i;
      if (dir === 'down') { for (i = maxRank - 1; i >= 0; i--) rs.push(i); }
      else { for (i = 1; i <= maxRank; i++) rs.push(i); }
      rs.forEach(function (r3) {
        var L = layers[r3];
        L.forEach(function (it) {
          var ns = dir === 'down' ? it.up : it.down;
          it.b = ns.length ? ns.reduce(function (a, n) { return a + n.p; }, 0) / ns.length : it.p;
        });
        L.sort(function (x, y) { return x.b - y.b; });
        norm(L);
      });
    }
    for (var k = 0; k < 4; k++) { sweep('down'); sweep('up'); }

    // 4. 先平均攤開，再把長線往直的方向拉
    var need = 0;
    layers.forEach(function (L) { need = Math.max(need, layerWidth(L)); });
    var W = Math.max(720, need + PAD * 2);
    layers.forEach(function (L) {
      var x = (W - layerWidth(L)) / 2;
      L.forEach(function (it, i) {
        if (i) x += gapOf(L[i - 1], it);
        it.cx = x + it.w / 2;
        x += it.w;
      });
    });

    function straighten(dir) {
      var rs = [], i;
      if (dir === 'down') { for (i = maxRank - 1; i >= 0; i--) rs.push(i); }
      else { for (i = 1; i <= maxRank; i++) rs.push(i); }
      rs.forEach(function (r4) {
        var L = layers[r4];
        L.forEach(function (it) {
          var ns = dir === 'down' ? it.up : it.down;
          it.want = ns.length ? ns.reduce(function (a, n) { return a + n.cx; }, 0) / ns.length : it.cx;
        });
        var prev = null;
        L.forEach(function (it) {
          var min = prev ? prev.cx + prev.w / 2 + gapOf(prev, it) + it.w / 2 : PAD + it.w / 2;
          it.cx = Math.max(min, it.want);
          prev = it;
        });
        for (var j = L.length - 1; j >= 0; j--) {
          var it2 = L[j], right = L[j + 1], left = L[j - 1];
          var hi = right ? right.cx - right.w / 2 - gapOf(it2, right) - it2.w / 2 : Infinity;
          var lo = left ? left.cx + left.w / 2 + gapOf(left, it2) + it2.w / 2 : PAD + it2.w / 2;
          it2.cx = Math.min(hi, Math.max(lo, Math.min(it2.want, hi)));
        }
      });
    }
    for (var t = 0; t < 3; t++) { straighten('down'); straighten('up'); }

    // 拉直那幾輪只會把東西往右推，最後要重新量實際範圍再置中
    var minX = Infinity, maxX = -Infinity;
    layers.forEach(function (L) {
      L.forEach(function (it) {
        minX = Math.min(minX, it.cx - it.w / 2);
        maxX = Math.max(maxX, it.cx + it.w / 2);
      });
    });
    var contentW = maxX - minX;
    W = Math.max(720, contentW + PAD * 2);
    var shift = (W - contentW) / 2 - minX;
    layers.forEach(function (L) {
      L.forEach(function (it) { it.cx += shift; });
    });

    layers.forEach(function (L) {
      L.forEach(function (it) { it.y = PAD + (maxRank - it.rank) * ROW; });
    });

    // 同一個節點的多條線，出線點沿底邊、入線點沿頂邊平均分開，
    // 不要全部擠在中心點射出去
    var outMap = {}, inMap = {};
    chains.forEach(function (c) {
      var a = c.chain[0], b = c.chain[c.chain.length - 1];
      (outMap[a.key] = outMap[a.key] || []).push(c);
      (inMap[b.key] = inMap[b.key] || []).push(c);
    });
    function spread(map, which, pick) {
      Object.keys(map).forEach(function (k) {
        var list = map[k], node = items[k];
        if (!node) return;
        list.sort(function (p, q) { return pick(p) - pick(q); });
        var span = Math.min(node.w - 30, Math.max(0, (list.length - 1) * 22));
        list.forEach(function (c, i) {
          c[which] = list.length === 1
            ? node.cx
            : node.cx - span / 2 + span * i / (list.length - 1);
        });
      });
    }
    spread(outMap, 'exitX', function (c) { return c.chain[1].cx; });
    spread(inMap, 'entryX', function (c) { return c.chain[c.chain.length - 2].cx; });

    return {
      layers: layers, chains: chains, items: items,
      W: W, H: PAD * 2 + maxRank * ROW + BH, BH: BH
    };
  }

  function r1(n) { return Math.round(n * 10) / 10; }

  // 把路徑點轉成直角折線：往下 → 橫移 → 再往下。
  // jog 是橫移發生的高度，同一個節點出來的多條線各自錯開，橫線才不會疊在一起。
  function orthogonalize(pts, jog) {
    var out = [{ x: pts[0].x, y: pts[0].y }];
    for (var i = 1; i < pts.length; i++) {
      var a = out[out.length - 1], b = pts[i];
      if (Math.abs(a.x - b.x) > 1.5) {
        var mid = (a.y + b.y) / 2 + jog;
        mid = Math.max(a.y + 10, Math.min(b.y - 10, mid));
        out.push({ x: a.x, y: mid }, { x: b.x, y: mid });
      }
      out.push({ x: b.x, y: b.y });
    }
    // 去掉重複與同一直線上的多餘點
    var clean = [out[0]];
    for (var j = 1; j < out.length; j++) {
      var p = out[j], q = clean[clean.length - 1];
      if (Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5) continue;
      if (clean.length >= 2) {
        var o = clean[clean.length - 2];
        var sameV = Math.abs(o.x - q.x) < 0.5 && Math.abs(q.x - p.x) < 0.5;
        var sameH = Math.abs(o.y - q.y) < 0.5 && Math.abs(q.y - p.y) < 0.5;
        if (sameV || sameH) { clean[clean.length - 1] = p; continue; }
      }
      clean.push(p);
    }
    return clean;
  }

  // 折線轉成帶圓角的路徑
  function roundedPath(pts, r) {
    if (pts.length < 2) return '';
    var d = 'M' + r1(pts[0].x) + ' ' + r1(pts[0].y);
    for (var i = 1; i < pts.length - 1; i++) {
      var p = pts[i], a = pts[i - 1], b = pts[i + 1];
      var d1 = Math.hypot(p.x - a.x, p.y - a.y) || 1;
      var d2 = Math.hypot(b.x - p.x, b.y - p.y) || 1;
      var rr = Math.min(r, d1 / 2, d2 / 2);
      d += ' L' + r1(p.x + (a.x - p.x) / d1 * rr) + ' ' + r1(p.y + (a.y - p.y) / d1 * rr) +
           ' Q' + r1(p.x) + ' ' + r1(p.y) + ' ' +
           r1(p.x + (b.x - p.x) / d2 * rr) + ' ' + r1(p.y + (b.y - p.y) / d2 * rr);
    }
    var last = pts[pts.length - 1];
    return d + ' L' + r1(last.x) + ' ' + r1(last.y);
  }

  function depsGraphSvg(edges) {
    if (!edges.length) return '';
    // 同一對 repo 之間釘同一個版本的重複引用（例如 hw/latest 與 hw/rev-2_1 都指向同一版），
    // 圖上畫一條就好；釘不同版本的才各畫一條。完整清單在表格那邊。
    var seen = {}, merged = [];
    edges.forEach(function (e) {
      var k = e.from + '>' + e.to + '>' + pinLabel(e) + '>' + edgeState(e).cls;
      if (seen[k]) { seen[k].dup++; return; }
      var copy = Object.assign({}, e, { dup: 1 });
      seen[k] = copy;
      merged.push(copy);
    });
    var G = layeredLayout(merged);
    if (!G.chains.length) return '';

    var svg = '<svg class="dep-graph" viewBox="0 0 ' + Math.round(G.W) + ' ' + Math.round(G.H) +
      '" role="img" aria-label="' +
      esc('相依關係圖：' + Object.keys(G.items).length + ' 個 repo、' + G.chains.length + ' 條相依') +
      '"><defs>' +
      ['sync', 'behind', 'diverged', 'unknown'].map(function (kk) {
        return '<marker id="gm-' + kk + '" viewBox="0 0 10 10" refX="9" refY="5" ' +
          'markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">' +
          '<path class="gm ' + kk + '" d="M1 1.5 L9 5 L1 8.5 z"/></marker>';
      }).join('') + '</defs>';

    var edgeSvg = '', labels = [], labelled = {};
    G.chains.forEach(function (c, ci) {
      var e = c.edge, st = edgeState(e), pin = pinLabel(e);
      var dupKey = e.to + '@' + pin;
      var jog = ((ci * 3) % 5 - 2) * 8;   // -16 / -8 / 0 / 8 / 16
      // 虛擬節點給上下兩個點：橫移只會發生在層與層之間的空隙，
      // 穿過節點那一排時一定是純垂直線，不會有橫線切過節點框。
      var pts = [];
      c.chain.forEach(function (it, i) {
        if (i === 0) { pts.push({ x: c.exitX, y: it.y + G.BH }); return; }            // 來源底部
        if (i === c.chain.length - 1) { pts.push({ x: c.entryX, y: it.y - 6 }); return; } // 目標上方留空隙
        pts.push({ x: it.cx, y: it.y }, { x: it.cx, y: it.y + G.BH });         // 穿過中間層
      });

      var route = orthogonalize(pts, jog);
      edgeSvg += '<path class="g-edge ' + st.cls + '" d="' + roundedPath(route, 11) +
        '" data-from="' + esc(e.from) + '" data-to="' + esc(e.to) + '" data-lk="' + esc(dupKey) +
        '" marker-end="url(#gm-' + st.cls + ')"><title>' +
        esc(shortName(e.from) + ' → ' + shortName(e.to) + '\n' +
            (e.kind === 'submodule' ? 'submodule ' : 'Cargo ') + e.ref +
            (e.dup > 1 ? '（另有 ' + (e.dup - 1) + ' 處引用同一版）' : '') +
            '\n釘在 ' + pin + '　' + st.label + (st.note ? '\n' + st.note : '')) +
        '</title></path>';

      // 只標需要注意的那些，全部都標會糊成一片
      // 同一個目標釘同一版就只標一次，重複的標籤只是噪音
      if (st.cls !== 'sync' && pin && pin !== '—' && !labelled[dupKey]) {
        labelled[dupKey] = 1;
        // 貼在最長的垂直段上：標籤永遠在線上，不會飄到旁邊
        var verticals = [];
        for (var si = 1; si < route.length; si++) {
          var a = route[si - 1], b = route[si];
          if (Math.abs(a.x - b.x) < 0.6) {
            verticals.push({ x: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y),
                             len: Math.abs(b.y - a.y) });
          }
        }
        verticals.sort(function (p, q) { return q.len - p.len; });
        var best = verticals[0] || null;
        if (best && best.len > 26) {
          labels.push({
            x: best.x, y: (best.lo + best.hi) / 2, lo: best.lo + 12, hi: best.hi - 12,
            runs: verticals, w: pin.length * 6.0 + 16, text: pin, cls: st.cls, lk: dupKey
          });
        }
      }
    });

    // 標籤避讓：不只要閃開其他標籤，也不能壓在節點框上
    var boxes = [];
    G.layers.forEach(function (L) {
      L.forEach(function (it) {
        if (it.kind === 'node') {
          boxes.push({ x: it.cx, y: it.y + G.BH / 2, w: it.w, h: G.BH });
        }
      });
    });
    function clash(L, upto) {
      var j;
      for (j = 0; j < upto; j++) {
        var o = labels[j];
        if (Math.abs(L.x - o.x) < (L.w + o.w) / 2 + 6 && Math.abs(L.y - o.y) < 20) return true;
      }
      for (j = 0; j < boxes.length; j++) {
        var b = boxes[j];
        if (Math.abs(L.x - b.x) < (L.w + b.w) / 2 + 4 &&
            Math.abs(L.y - b.y) < (18 + b.h) / 2 + 4) return true;
      }
      return false;
    }
    labels.forEach(function (L, i) {
      if (!clash(L, i)) return;
      var baseY = L.y, baseX = L.x, step, d, k, cands;

      // 依序試遍這條線的每一段垂直線，上下滑動找空位
      for (var ri = 0; ri < L.runs.length; ri++) {
        var run = L.runs[ri];
        if (run.len < 26) continue;
        L.x = run.x;
        var mid = (run.lo + run.hi) / 2, lo = run.lo + 12, hi = run.hi - 12;
        for (step = 0; step <= 12; step++) {
          d = step * 11;
          cands = (step ? [mid - d, mid + d] : [mid]).filter(function (y) { return y >= lo && y <= hi; });
          for (k = 0; k < cands.length; k++) {
            L.y = cands[k];
            if (!clash(L, i)) return;
          }
        }
      }
      L.x = baseX;
      // 還是擺不下就靠到線的側邊，貼著線仍然讀得出是哪一條
      var side = L.w / 2 + 12;
      for (step = 0; step <= 8; step++) {
        d = step * 13;
        for (k = 0; k < 4; k++) {
          L.x = baseX + (k % 2 ? side : -side);
          L.y = Math.max(L.lo, Math.min(L.hi, baseY + (k < 2 ? -d : d)));
          if (!clash(L, i)) return;
        }
      }
      L.x = baseX; L.y = baseY;
    });

    svg += edgeSvg + labels.map(function (L) {
      return '<g class="g-pin-g" data-lk="' + esc(L.lk) + '"><rect class="g-pin-bg ' + L.cls + '" x="' + r1(L.x - L.w / 2) +
        '" y="' + r1(L.y - 9) + '" width="' + r1(L.w) + '" height="18" rx="9"/>' +
        '<text class="g-pin" x="' + r1(L.x) + '" y="' + r1(L.y + 3.5) +
        '" text-anchor="middle">' + esc(L.text) + '</text></g>';
    }).join('');

    G.layers.forEach(function (L) {
      L.forEach(function (it) {
        if (it.kind !== 'node') return;
        var ver = nodeVersion(it.id);
        var full = nodeVersionsFull(it.id);
        svg += '<g class="g-node" data-id="' + esc(it.id) + '"><title>' +
          esc(shortName(it.id) + '\n' + (state.deps && state.deps.root ? '這個版本綁到：' : '最新版本：') + full) +
          '</title>' +
          '<rect class="g-box" x="' + (it.cx - it.w / 2) + '" y="' + it.y +
          '" width="' + it.w + '" height="' + G.BH + '" rx="6"/>' +
          '<text class="g-name" x="' + it.cx + '" y="' + (it.y + 22) + '" text-anchor="middle">' +
          esc(shortName(it.id)) + '</text>' +
          '<text class="g-ver" x="' + it.cx + '" y="' + (it.y + 38) + '" text-anchor="middle">' +
          esc(ver) + '</text></g>';
      });
    });

    return svg + '</svg>';
  }

  function depsLegend() {
    return '<div class="g-legend">' + [
      ['sync', '釘在最新版或完全同步'],
      ['behind', '可以往前追'],
      ['diverged', '釘在別條分支，已經分家'],
      ['unknown', '沒量到']
    ].map(function (x) {
      return '<span class="g-key"><i class="' + x[0] + '"></i>' + esc(x[1]) + '</span>';
    }).join('') + '<span class="g-hint">滑到任一節點只亮它相關的線；綠線沒問題所以不標字</span></div>';
  }

  /* ---------- 起點 / 版本 / 顯示哪些 repo ---------- */

  function depsRootOptions() {
    return state.repos.filter(function (r) { return !r.archived; })
      .map(function (r) { return r.full_name; }).sort();
  }

  // 版本清單直接跟 GitHub 要，不靠卡片那邊的快取 —— 這些 repo 多半只打 tag、沒發 release，
  // 卡片的 tags 又只在 releases 為空時才補抓，湊出來的清單會缺東西。
  //
  // 任何 repo 至少有一條分支，所以 branches 是空的一定是抓失敗（額度用完之類），
  // 不可能是真的沒有。用這個判斷就不會把失敗的結果當成有效快取存起來卡死。
  function refsUsable(root) {
    var c = state.refCache[root];
    return !!(c && c.branches && c.branches.length);
  }

  function loadRefsFor(root, force) {
    if (!root) return Promise.resolve();
    if (!force && refsUsable(root)) return Promise.resolve();
    if (state.refLoading === root) return Promise.resolve();

    state.refLoading = root;
    delete state.refError[root];
    renderDepsControls();

    var failed = [];
    function list(path) {
      return gh('/repos/' + root + '/' + path, { per_page: 100 }).then(
        function (l) { return (l || []).map(function (x) { return x.name; }); },
        function (err) { failed.push(errText(err)); return null; }
      );
    }

    return Promise.all([list('tags'), list('branches')]).then(function (out) {
      if (out[1] === null) {
        state.refError[root] = failed[0] || '讀不到版本清單';
        delete state.refCache[root];
      } else {
        state.refCache[root] = { tags: out[0] || [], branches: out[1] };
        lsSet(KEY.refs, JSON.stringify(state.refCache));
      }
      state.refLoading = '';
      renderDepsControls();
      renderRate();
    });
  }

  function depsRefGroups(root) {
    var r = trackedRepo(root);
    if (!r) return null;
    var cached = state.refCache[root] || { tags: [], branches: [] };
    var dflt = r.default_branch;
    // 版本清單抓不到時，至少用相依分析當時抓到的 tag 頂著
    var tags = cached.tags.length ? cached.tags
      : ((state.deps && state.deps.repoTags && state.deps.repoTags[root]) || []);
    return {
      dflt: dflt,
      tags: tags.filter(function (t) { return t !== dflt; }),
      branches: cached.branches.filter(function (b) { return b !== dflt; }),
      ok: refsUsable(root),
      error: state.refError[root] || ''
    };
  }

  function renderDepsControls() {
    var rootSel = $('#deps-root'), refSel = $('#deps-ref');
    var opts = depsRootOptions();
    var sig = opts.join('|');
    if (rootSel.dataset.sig !== sig) {
      rootSel.dataset.sig = sig;
      rootSel.innerHTML = '<option value="">全部 repo（各自的 main）</option>' +
        opts.map(function (id) {
          return '<option value="' + esc(id) + '">' + esc(shortName(id)) + '</option>';
        }).join('');
    }
    rootSel.value = state.depsRoot || '';

    var g = state.depsRoot ? depsRefGroups(state.depsRoot) : null;
    var rsig = state.depsRoot + '|' + (state.refLoading === state.depsRoot ? 'loading' : '') + '|' +
      (g ? g.dflt + '#' + g.tags.length + '#' + g.branches.length + '#' + (state.depsRef || '') : '');
    if (refSel.dataset.sig !== rsig) {
      refSel.dataset.sig = rsig;
      if (!g) {
        refSel.innerHTML = '<option value="">—</option>';
      } else {
        var opt = function (v, label) {
          return '<option value="' + esc(v) + '">' + esc(label || v) + '</option>';
        };
        var html = opt(g.dflt, g.dflt + '（預設分支）');
        if (state.depsRef && state.depsRef !== g.dflt &&
            g.tags.indexOf(state.depsRef) === -1 && g.branches.indexOf(state.depsRef) === -1) {
          html += opt(state.depsRef);
        }
        if (g.tags.length) {
          html += '<optgroup label="tag（' + g.tags.length + '）">' +
            g.tags.map(function (t) { return opt(t); }).join('') + '</optgroup>';
        }
        if (g.branches.length) {
          html += '<optgroup label="分支（' + g.branches.length + '）">' +
            g.branches.map(function (b) { return opt(b); }).join('') + '</optgroup>';
        }
        if (!g.ok && !g.tags.length && state.refLoading !== state.depsRoot) {
          html += opt('', '（版本清單還沒載入）');
        }
        refSel.innerHTML = html;
      }
    }
    refSel.disabled = !state.depsRoot || state.refLoading === state.depsRoot;
    if (state.depsRoot && !state.depsRef) state.depsRef = g ? g.dflt : '';
    refSel.value = state.depsRef || '';

    var d = state.deps;
    var changed = d && (d.root !== (state.depsRoot || '') ||
                        (state.depsRoot && d.rootRef !== state.depsRef));
    var err = g && g.error;
    $('#deps-mode-hint').textContent =
      state.refLoading === state.depsRoot && state.depsRoot ? '讀取版本清單…'
      : err ? '版本清單讀不到：' + err
      : changed ? '選擇已變更，按「重新分析」套用'
      : state.depsRoot ? '展開這個版本實際綁住的整棵樹'
      : '每個 repo 各自看 main 上宣告了什麼';
    $('#deps-mode-hint').classList.toggle('warn', !!(changed || err));

    var reload = $('#btn-refs-reload');
    reload.hidden = !state.depsRoot || state.refLoading === state.depsRoot ||
                    (g && g.ok && (g.tags.length || g.branches.length));
    reload.textContent = err ? '重試' : '載入版本清單';
  }

  function depsNodes(d) {
    var set = {};
    d.edges.forEach(function (e) { set[e.from] = 1; set[e.to] = 1; });
    return Object.keys(set).sort();
  }

  function renderDepsFilter(d) {
    var el = $('#deps-filter');
    var nodes = depsNodes(d);
    if (!nodes.length) { el.hidden = true; return; }
    el.hidden = false;
    var sig = nodes.join('|') + '#' + Object.keys(state.depsHidden).sort().join('|');
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;

    var hiddenCount = nodes.filter(function (n) { return state.depsHidden[n]; }).length;
    el.innerHTML = '<span class="f-label">顯示</span>' +
      nodes.map(function (n) {
        var on = !state.depsHidden[n];
        return '<button class="f-chip' + (on ? ' on' : '') + '" type="button" data-hide="' +
          esc(n) + '" aria-pressed="' + on + '">' + esc(shortName(n)) + '</button>';
      }).join('') +
      (hiddenCount
        ? '<button class="f-all" type="button" data-hide-all="show">全部顯示</button>'
        : '<button class="f-all" type="button" data-hide-all="hide">全部隱藏</button>');
  }

  function visibleDepEdges(d) {
    return d.edges.filter(function (e) {
      return !state.depsHidden[e.from] && !state.depsHidden[e.to];
    });
  }

  function renderDeps() {
    var sec = $('#deps');
    if (!CFG.analyseDeps || !state.repos.length) { sec.hidden = true; return; }
    sec.hidden = false;

    renderDepsControls();

    var d = state.deps;
    if (!d) {
      $('#deps-status').textContent = '尚未分析 · 會讀各 repo 的 .gitmodules 與 Cargo.toml';
      $('#btn-deps').textContent = '分析';
      $('#btn-deps-toggle').hidden = true;
      $('.seg-group').hidden = true;
      $('#deps-filter').hidden = true;
      $('#deps-body').innerHTML = '';
      return;
    }
    renderDepsFilter(d);

    var shown = visibleDepEdges(d);
    var drift = shown.filter(function (e) { return edgeState(e).cls === 'behind'; }).length;
    var forked = shown.filter(function (e) { return edgeState(e).cls === 'diverged'; }).length;
    $('#deps-status').textContent =
      (d.root ? shortName(d.root) + ' @ ' + (d.shaTag && d.shaTag[d.rootRef] || shortRef(d.rootRef)) + ' · ' : '') +
      '分析於 ' + relTime(d.analysedAt) + ' · ' + shown.length +
      ' 條內部相依' +
      (drift || forked
        ? '，其中 ' + (drift ? drift + ' 條可以升版' : '') + (drift && forked ? '、' : '') +
          (forked ? forked + ' 條釘在別的分支' : '')
        : '，全部同步') +
      ' · 這次用了 ' + d.calls + ' 次 API';
    $('#btn-deps').textContent = '重新分析';
    $('#btn-deps-toggle').hidden = false;
    $('.seg-group').hidden = false;

    var rows = shown.slice().sort(function (a, b) {
      var rank = function (e) { return { behind: 0, diverged: 1, unknown: 2, sync: 3 }[edgeState(e).cls]; };
      return rank(a) - rank(b) || (b.behind || 0) - (a.behind || 0) || a.from.localeCompare(b.from);
    });

    var view = state.depsView || 'graph';
    var sig = d.analysedAt + '|' + view + '|' + Object.keys(state.depsHidden).sort().join(',');
    var html = '';

    if (view === 'graph') {
      html += '<div class="graphwrap">' + depsGraphSvg(rows) + '</div>' + depsLegend();
      if (d.external.length) html += externalHtml(d);
      if (state.depsRendered !== sig) {
        $('#deps-body').innerHTML = html;
        state.depsRendered = sig;
      }
      return;
    }

    html += '<div class="tablewrap"><table class="dep-table"><thead><tr>' +
      '<th>依賴方</th><th>被依賴</th><th>怎麼引用</th><th>釘在</th><th>上游最新</th><th>狀態</th>' +
      '</tr></thead><tbody>';

    rows.forEach(function (e) {
      var st = edgeState(e);
      html += '<tr>' +
        '<td class="m">' + esc(shortName(e.from)) + '</td>' +
        '<td class="m">' + esc(shortName(e.to)) + '</td>' +
        '<td>' + (e.kind === 'submodule' ? 'submodule' : 'Cargo') +
          '<span class="sub">' + esc(e.ref) + (e.declaredBranch ? ' · 宣告分支 ' + esc(e.declaredBranch) : '') + '</span></td>' +
        '<td class="m">' + esc(pinLabel(e)) + '</td>' +
        '<td class="m">' + esc(e.latest || '—') + '</td>' +
        '<td><span class="dep-pill ' + st.cls + '">' + esc(st.label) + '</span>' +
          (st.note ? '<span class="sub">' + esc(st.note) + '</span>' : '') + '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';

    if (d.external.length) html += externalHtml(d);

    if (state.depsRendered !== sig) {
      $('#deps-body').innerHTML = html;
      state.depsRendered = sig;
    }
  }

  function externalHtml(d) {
    var byRepo = {};
    d.external.forEach(function (e) { (byRepo[e.to] = byRepo[e.to] || []).push(e); });
    var html = '<details class="ext"><summary>另外還有 ' + Object.keys(byRepo).length +
      ' 個追蹤清單外的相依（外部專案、不分析）</summary><ul>';
    Object.keys(byRepo).sort().forEach(function (t) {
      html += '<li><code>' + esc(t) + '</code> ← ' +
        byRepo[t].map(function (e) { return shortName(e.from); }).filter(function (v, i, a) {
          return a.indexOf(v) === i;
        }).map(esc).join('、') + '</li>';
    });
    return html + '</ul></details>';
  }

  // 卡片上的兩行：往下依賴誰、往上被誰依賴
  function depsCardHtml(repo) {
    if (!state.deps) return '';
    var out = state.deps.edges.filter(function (e) { return e.from === repo.full_name; });
    var inc = state.deps.edges.filter(function (e) { return e.to === repo.full_name; });
    if (!out.length && !inc.length) return '';

    function chips(list, pick) {
      var seen = {};
      return list.filter(function (e) {
        var k = pick(e) + '@' + pinLabel(e);
        if (seen[k]) return false; seen[k] = 1; return true;
      }).map(function (e) {
        var st = edgeState(e);
        return '<span class="dep-chip ' + st.cls + '" title="' +
          esc(shortName(e.from) + ' → ' + shortName(e.to) + '：' + e.kind + ' ' + e.ref +
              '，釘在 ' + pinLabel(e) + '，' + st.label) + '">' +
          esc(shortName(pick(e))) + ' <b>' + esc(pinLabel(e)) + '</b>' +
          (st.cls === 'behind' || st.cls === 'diverged' ? '<i>' + esc(st.label) + '</i>' : '') + '</span>';
      }).join('');
    }

    var html = '<div class="c-deps">';
    if (out.length) html += '<div class="dep-row"><span class="dep-dir">依賴</span>' +
      '<span class="dep-chips">' + chips(out, function (e) { return e.to; }) + '</span></div>';
    if (inc.length) html += '<div class="dep-row"><span class="dep-dir">被依賴</span>' +
      '<span class="dep-chips">' + chips(inc, function (e) { return e.from; }) + '</span></div>';
    return html + '</div>';
  }

  /* ---------- 動作 ---------- */

  function setBusy(on, label) {
    state.busy = on;
    var btn = $('#btn-refresh');
    btn.disabled = on;
    btn.textContent = on ? (label || '抓取中…') : '更新';
  }

  function needsData(repo) {
    var d = state.data[repo.full_name];
    return !d || d.error || d.pushed_at !== repo.pushed_at;
  }

  function wantData(repo) {
    return !repo.archived || $('#show-archived').checked;
  }

  // 逐一（而非同時）抓取，避免踩到 GitHub 的次要速率限制
  function fetchEach(targets) {
    return new Promise(function (resolve) {
      var i = 0;
      (function step() {
        if (i >= targets.length) { resolve(); return; }
        var repo = targets[i++];
        setBusy(true, '抓取中 ' + i + '/' + targets.length);
        banner('讀取更新內容 ' + i + ' / ' + targets.length + '：' + repo.name, 'info');
        loadRepoData(repo).then(function (d) {
          state.data[repo.full_name] = d;
        }, function (err) {
          state.data[repo.full_name] = {
            pushed_at: repo.pushed_at, error: errText(err), commits: [], commitDates: [], releases: [], tags: []
          };
        }).then(step);
      })();
    });
  }

  function fetchMissing() {
    if (state.busy) return;
    var targets = state.repos.filter(function (r) { return wantData(r) && needsData(r); });
    if (!targets.length) return;
    setBusy(true);
    fetchEach(targets).then(function () {
      banner(''); saveCache(); setBusy(false); render();
    });
  }

  function refresh() {
    if (state.busy) return;
    setBusy(true);
    banner('');
    state.calls = 0;

    loadRepoList().then(function (repos) {
      state.repos = repos;
      state.fetchedAt = new Date().toISOString();
      render();

      if (!repos.length) {
        banner('沒有找到符合條件的 repo，檢查一下 config.js 的 org / keyword。', 'warn');
        return;
      }
      var targets = repos.filter(function (r) { return wantData(r) && needsData(r); });
      if (!targets.length) { banner(''); return; }

      return fetchEach(targets).then(function () {
        banner('更新完成，這次用了 ' + state.calls + ' 次 API。', 'info');
        setTimeout(function () { banner(''); }, 4000);
      });
    }).then(function () {
      if (!state.seenAt && state.repos.length) {
        state.seenAt = new Date().toISOString();
        lsSet(KEY.seen, state.seenAt);
      }
      saveCache();
      render();
    }).catch(function (err) {
      banner(errText(err), 'error');
    }).then(function () { setBusy(false); });
  }

  function allCommitDates() {
    var out = [];
    state.repos.forEach(function (r) {
      var d = state.data[r.full_name];
      if (!d) return;
      (d.commitDates || []).forEach(function (x) { out.push(x); });
      (d.releases || []).forEach(function (x) { out.push(x.date); });
    });
    return out;
  }

  function markRead() {
    // 取「現在」與「已抓到的最新時間」較晚者，避免對方時間比本機時鐘快時永遠標成未讀
    var t = Date.now();
    allCommitDates().forEach(function (x) {
      var d = new Date(x).getTime();
      if (d > t) t = d;
    });
    state.seenAt = new Date(t).toISOString();
    lsSet(KEY.seen, state.seenAt);
    render();
  }

  /* ---------- 主題 ---------- */

  function applyTheme(theme) {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }

  function toggleTheme() {
    var cur = lsGet(KEY.theme);
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var next = cur ? (cur === 'dark' ? 'light' : 'dark') : (prefersDark ? 'light' : 'dark');
    lsSet(KEY.theme, next);
    applyTheme(next);
  }

  /* ---------- 綁定 ---------- */

  function init() {
    applyTheme(lsGet(KEY.theme));
    state.seenAt = lsGet(KEY.seen);
    $('#token').value = getToken();

    var hadCache = loadCache();
    if (state.deps) $('#deps-body').hidden = false;
    render();
    renderRate();
    if (!hadCache) refresh();

    $('#btn-refresh').addEventListener('click', refresh);
    $('#btn-mark-read').addEventListener('click', markRead);
    $('#btn-theme').addEventListener('click', toggleTheme);
    $('#btn-settings').addEventListener('click', function () {
      var p = $('#settings'); p.hidden = !p.hidden;
    });
    $('#btn-token-save').addEventListener('click', function () {
      var v = $('#token').value.trim();
      if (v) lsSet(KEY.token, v); else lsDel(KEY.token);
      $('#settings').hidden = true;
      banner(v ? 'Token 已儲存在這台瀏覽器。' : 'Token 已清除。', 'info');
      renderRate();
    });
    $('#btn-token-clear').addEventListener('click', function () {
      lsDel(KEY.token); $('#token').value = '';
      banner('Token 已清除。', 'info');
      renderRate();
    });

    ['#search', '#sort', '#only-new', '#show-archived'].forEach(function (sel) {
      $(sel).addEventListener('input', render);
      $(sel).addEventListener('change', render);
    });
    $('#show-archived').addEventListener('change', fetchMissing);
    // 滑到節點就只亮跟它有關的線，其餘淡出 —— 線一多的時候這比再怎麼排版都有效
    $('#deps-body').addEventListener('mouseover', function (ev) {
      var svg = $('#deps-body .dep-graph');
      if (!svg) return;
      var node = ev.target.closest && ev.target.closest('.g-node');
      if (!node) return;
      var id = node.getAttribute('data-id');
      svg.classList.add('focusing');
      var keep = {};
      svg.querySelectorAll('.g-edge').forEach(function (path) {
        var from = path.getAttribute('data-from'), to = path.getAttribute('data-to');
        var hit = from === id || to === id;
        path.classList.toggle('on', hit);
        if (hit) { keep[from] = keep[to] = 1; keep['lk:' + path.getAttribute('data-lk')] = 1; }
      });
      svg.querySelectorAll('.g-node').forEach(function (n) {
        n.classList.toggle('on', !!keep[n.getAttribute('data-id')]);
      });
      svg.querySelectorAll('.g-pin-g').forEach(function (g) {
        g.classList.toggle('on', !!keep['lk:' + g.getAttribute('data-lk')]);
      });
    });
    $('#deps-body').addEventListener('mouseleave', function () {
      var svg = $('#deps-body .dep-graph');
      if (svg) svg.classList.remove('focusing');
    });

    $('#btn-refs-reload').addEventListener('click', function () {
      loadRefsFor(state.depsRoot, true);
    });
    if (state.depsRoot && !refsUsable(state.depsRoot)) {
      setTimeout(function () { loadRefsFor(state.depsRoot); }, 1200);
    }

    $('#btn-deps').addEventListener('click', analyseDeps);
    $('#deps-root').addEventListener('change', function () {
      state.depsRoot = this.value;
      state.depsRef = '';
      lsSet(KEY.depsView, JSON.stringify({ root: state.depsRoot, ref: state.depsRef, hidden: state.depsHidden }));
      renderDepsControls();
      loadRefsFor(state.depsRoot);
    });
    $('#deps-ref').addEventListener('change', function () {
      state.depsRef = this.value;
      lsSet(KEY.depsView, JSON.stringify({ root: state.depsRoot, ref: state.depsRef, hidden: state.depsHidden }));
      renderDepsControls();
    });
    $('#deps-filter').addEventListener('click', function (e) {
      var chip = e.target.closest('[data-hide]');
      if (chip) {
        var id = chip.dataset.hide;
        if (state.depsHidden[id]) delete state.depsHidden[id];
        else state.depsHidden[id] = 1;
      } else {
        var all = e.target.closest('[data-hide-all]');
        if (!all) return;
        state.depsHidden = {};
        if (all.dataset.hideAll === 'hide' && state.deps) {
          depsNodes(state.deps).forEach(function (n) { state.depsHidden[n] = 1; });
        }
      }
      lsSet(KEY.depsView, JSON.stringify({ root: state.depsRoot, ref: state.depsRef, hidden: state.depsHidden }));
      $('#deps-filter').dataset.sig = '';
      render();
    });
    [['#btn-view-graph', 'graph'], ['#btn-view-table', 'table']].forEach(function (x) {
      $(x[0]).addEventListener('click', function () {
        state.depsView = x[1];
        $('#btn-view-graph').classList.toggle('on', x[1] === 'graph');
        $('#btn-view-table').classList.toggle('on', x[1] === 'table');
        render();
      });
    });
    $('#btn-deps-toggle').addEventListener('click', function () {
      var b = $('#deps-body');
      b.hidden = !b.hidden;
      $('#btn-deps-toggle').textContent = b.hidden ? '展開' : '收合';
    });

    $('#grid').addEventListener('click', function (e) {
      var commit = e.target.closest('.c-title');
      if (commit) { showCommit(commit.dataset.repo, commit.dataset.sha); return; }

      var rel = e.target.closest('[data-rel]');
      if (rel) { showRelease(rel.dataset.repo, Number(rel.dataset.rel)); return; }

      var more = e.target.closest('[data-more]');
      if (more) {
        var fn = more.dataset.more;
        if (state.expandedList[fn]) delete state.expandedList[fn];
        else state.expandedList[fn] = true;
        render();
      }
    });

    $('#drawer-close').addEventListener('click', closeDrawer);
    $('#drawer-backdrop').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
