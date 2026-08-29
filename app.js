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
    var name = fullName.split('/')[1];
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
        return picked.filter(function (r) { return !isExcluded(r.full_name); });
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

  // .gitmodules 與 Cargo.toml 從 raw.githubusercontent.com 讀，不算 GitHub API 額度
  function raw(fullName, branch, path) {
    return fetch(RAW + '/' + fullName + '/' + encodeURIComponent(branch) + '/' + path)
      .then(function (res) { return res.ok ? res.text() : null; }, function () { return null; });
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
    state.calls = 0;

    var repos = state.repos.filter(function (r) { return !r.archived; });
    var edges = [], external = [], i = 0;

    // 1. 讀 .gitmodules 與 Cargo.toml（免費），再逐一問出 submodule 釘住的 commit
    function scanRepo() {
      if (i >= repos.length) return resolvePins();
      var r = repos[i++];
      banner('讀取宣告 ' + i + ' / ' + repos.length + '：' + r.name, 'info');
      setBusy(true, '分析中 ' + i + '/' + repos.length);

      return Promise.all([
        raw(r.full_name, r.default_branch, '.gitmodules'),
        raw(r.full_name, r.default_branch, 'Cargo.toml')
      ]).then(function (out) {
        parseGitmodules(out[0]).forEach(function (s) {
          var target = repoFromUrl(s.url);
          var edge = {
            from: r.full_name, to: target || s.url, kind: 'submodule',
            ref: s.path, declaredBranch: s.branch || '',
            sha: '', tag: '', behind: null, diverged: null, cmpStatus: '',
            latest: '', comparedTo: '', error: ''
          };
          if (target && trackedRepo(target)) edges.push(edge); else external.push(edge);
        });
        parseCargoGit(out[1]).forEach(function (d) {
          var edge = {
            from: r.full_name, to: d.repo, kind: 'cargo',
            ref: d.crate + (d.count > 1 ? ' 等 ' + d.count + ' 個 crate' : ''),
            declaredBranch: d.branch, sha: d.sha, tag: d.tag,
            behind: null, diverged: null, cmpStatus: '',
            latest: '', comparedTo: '', error: ''
          };
          if (trackedRepo(d.repo)) edges.push(edge); else external.push(edge);
        });
      }).then(scanRepo);
    }

    // 2. submodule 釘住的 commit：contents API 回傳 type=submodule 與 sha
    function resolvePins() {
      var subs = edges.filter(function (e) { return e.kind === 'submodule'; });
      var n = 0;
      return series(subs, function (e) {
        banner('解析釘住的版本 ' + (++n) + ' / ' + subs.length + '：' + shortName(e.from) + '/' + e.ref, 'info');
        return gh('/repos/' + e.from + '/contents/' + e.ref).then(function (c) {
          if (c && !Array.isArray(c) && c.sha) e.sha = c.sha;
          else e.error = '取不到釘住的 commit';
        }, function (err) { e.error = errText(err); });
      }).then(resolveTags);
    }

    // 3. 把釘住的 commit 對回 tag 名稱（只查有 submodule 指向的 repo）
    function resolveTags() {
      var targets = {};
      edges.forEach(function (e) { if (e.kind === 'submodule' && e.sha) targets[e.to] = 1; });
      var list = Object.keys(targets);

      return series(list, function (t) {
        banner('讀取 ' + shortName(t) + ' 的 tag 清單…', 'info');
        return gh('/repos/' + t + '/tags', { per_page: 100 }).then(function (tags) {
          var bySha = {};
          (tags || []).forEach(function (x) { if (x.commit) bySha[x.commit.sha] = x.name; });
          edges.forEach(function (e) {
            if (e.to === t && e.sha && !e.tag && bySha[e.sha]) e.tag = bySha[e.sha];
          });
        }, function () { /* 沒有 tag 就算了 */ });
      }).then(compareAll);
    }

    // 4. 每條邊落後上游幾個 commit
    function compareAll() {
      var todo = edges.filter(function (e) { return !!e.sha; });
      var n = 0;
      return series(todo, function (e) {
        var target = trackedRepo(e.to);
        if (!target) return Promise.resolve();
        // 宣告了分支就跟那條比；拿 v1p6 上的 commit 去跟 main 比會得到沒有意義的數字
        var head = e.declaredBranch || target.default_branch;
        e.comparedTo = head;
        banner('比對落後量 ' + (++n) + ' / ' + todo.length + '：' + shortName(e.from) + ' → ' + shortName(e.to), 'info');
        return gh('/repos/' + e.to + '/compare/' + e.sha + '...' + head, { per_page: 1 })
          .then(function (c) {
            e.behind = typeof c.ahead_by === 'number' ? c.ahead_by : null;
            e.diverged = typeof c.behind_by === 'number' ? c.behind_by : null;
            e.cmpStatus = c.status || '';
          }, function (err) { if (!e.error) e.error = errText(err); });
      });
    }

    return scanRepo().then(function () {
      // 上游目前的最新版本，用來對照「釘的版本是不是最新的」
      edges.forEach(function (e) {
        var d = state.data[e.to];
        if (!d) return;
        if (d.releases && d.releases[0]) e.latest = d.releases[0].tag;
        else if (d.tags && d.tags[0]) e.latest = d.tags[0].name;
      });
      state.deps = { analysedAt: new Date().toISOString(), edges: edges, external: external, calls: state.calls };
      lsSet(KEY.deps, JSON.stringify(state.deps));
      banner('相依分析完成，用了 ' + state.calls + ' 次 API。', 'info');
      setTimeout(function () { banner(''); }, 4000);
      $('#deps-body').hidden = false;
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
  // 上游已知的版本，新到舊：先 release，再 tag
  function knownVersions(fullName) {
    var d = state.data[fullName] || {};
    return (d.releases || []).map(function (r) { return r.tag; })
      .concat((d.tags || []).map(function (t) { return t.name; }));
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

  // 分層：沒有往外相依的排最底層，其餘 = 下游最大層數 + 1。遇到環就切斷，不會無限遞迴。
  function rankNodes(edges) {
    var nodes = {};
    edges.forEach(function (e) {
      nodes[e.from] = nodes[e.from] || { id: e.from, out: [], inn: [] };
      nodes[e.to] = nodes[e.to] || { id: e.to, out: [], inn: [] };
    });
    edges.forEach(function (e) {
      if (nodes[e.from].out.indexOf(e.to) === -1) nodes[e.from].out.push(e.to);
      if (nodes[e.to].inn.indexOf(e.from) === -1) nodes[e.to].inn.push(e.from);
    });

    var rank = {}, mark = {};
    function visit(id) {
      if (rank[id] !== undefined) return rank[id];
      if (mark[id]) return 0;               // 環：就地切斷
      mark[id] = 1;
      var r = 0;
      nodes[id].out.forEach(function (t) { r = Math.max(r, visit(t) + 1); });
      rank[id] = r;
      return r;
    }
    Object.keys(nodes).forEach(visit);
    return { nodes: nodes, rank: rank };
  }

  // 用重心法排同一層的左右順序，減少線的交叉
  function orderRanks(nodes, rank) {
    var rows = [], maxRank = 0;
    Object.keys(rank).forEach(function (id) { maxRank = Math.max(maxRank, rank[id]); });
    for (var r = 0; r <= maxRank; r++) rows[r] = [];
    Object.keys(rank).sort().forEach(function (id) { rows[rank[id]].push(id); });

    function posOf(rows) {
      var pos = {};
      rows.forEach(function (row) {
        row.forEach(function (id, i) { pos[id] = row.length > 1 ? i / (row.length - 1) : 0.5; });
      });
      return pos;
    }
    function sortBy(row, neighbours, pos) {
      var key = {};
      row.forEach(function (id) {
        var ns = neighbours(id).filter(function (n) { return pos[n] !== undefined; });
        key[id] = ns.length
          ? ns.reduce(function (a, n) { return a + pos[n]; }, 0) / ns.length
          : pos[id];
      });
      row.sort(function (a, b) { return key[a] - key[b] || a.localeCompare(b); });
    }

    for (var pass = 0; pass < 3; pass++) {
      var pos = posOf(rows);
      for (var i = 1; i <= maxRank; i++) {
        sortBy(rows[i], function (id) { return nodes[id].out; }, pos);
      }
      pos = posOf(rows);
      for (var j = maxRank - 1; j >= 0; j--) {
        sortBy(rows[j], function (id) { return nodes[id].inn; }, pos);
      }
    }
    return rows;
  }

  function depsGraphSvg(edges) {
    if (!edges.length) return '';

    var laid = rankNodes(edges);
    var rows = orderRanks(laid.nodes, laid.rank);
    var maxRank = rows.length - 1;

    var BW = 170, BH = 44, ROW = 108, GAP = 30;
    var LANE = 22, RAILS = 4;              // 跨層的線走側邊軌道
    var SIDE = 30 + RAILS * LANE;          // 左右各留給軌道的寬度
    var widest = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 1);
    var W = SIDE * 2 + widest * (BW + GAP) - GAP;
    var TOP = 14;
    var H = TOP + (maxRank + 1) * BH + maxRank * (ROW - BH) + 16;

    var xy = {};
    rows.forEach(function (row, r) {
      var y = TOP + (maxRank - r) * ROW;
      var inner = W - SIDE * 2 - BW;
      row.forEach(function (id, i) {
        var x = row.length > 1 ? SIDE + inner * i / (row.length - 1) : SIDE + inner / 2;
        xy[id] = { x: x, y: y, cx: x + BW / 2 };
      });
    });

    // 軌道分配：跨越愈多層的走愈外圈，左右交替
    var multi = edges.filter(function (e) {
      return xy[e.from] && xy[e.to] && laid.rank[e.from] - laid.rank[e.to] > 1;
    }).sort(function (a, b) {
      return (laid.rank[b.from] - laid.rank[b.to]) - (laid.rank[a.from] - laid.rank[a.to]);
    });
    var rail = {}, used = [0, 0];
    multi.forEach(function (e, i) {
      var side = i % 2;                                  // 0 = 左，1 = 右
      var slot = used[side]++ % RAILS;
      rail[e.from + '>' + e.to + '>' + e.ref] = {
        x: side === 0 ? SIDE - 26 - slot * LANE : W - SIDE + 26 + slot * LANE,
        // 進出軌道的橫線也要錯開，否則同一排的目標會疊在同一條高度上
        off: 14 + (i % 5) * 7
      };
    });

    var svg = '<svg class="dep-graph" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
      esc('相依關係圖：' + Object.keys(xy).length + ' 個 repo、' + edges.length + ' 條相依') + '"><defs>' +
      ['sync', 'behind', 'diverged', 'unknown'].map(function (k) {
        return '<marker id="gm-' + k + '" viewBox="0 0 10 10" refX="9.5" refY="5" ' +
          'markerWidth="8" markerHeight="8" orient="auto-start-reverse">' +
          '<path class="gm ' + k + '" d="M0.5 1 L9.5 5 L0.5 9 z"/></marker>';
      }).join('') + '</defs>';

    edges.forEach(function (e) {
      var a = xy[e.from], b = xy[e.to];
      if (!a || !b) return;
      var st = edgeState(e);
      var pin = pinLabel(e);
      var tip = esc(shortName(e.from) + ' → ' + shortName(e.to) + '\n' +
        (e.kind === 'submodule' ? 'submodule ' : 'Cargo ') + e.ref +
        '\n釘在 ' + pin + '　' + st.label + (st.note ? '\n' + st.note : ''));
      var y1 = a.y + BH, y2 = b.y;
      var rl = rail[e.from + '>' + e.to + '>' + e.ref];
      var d, label;

      if (!rl) {
        // 相鄰層：直接連過去
        d = 'M' + a.cx + ' ' + y1 + ' L' + b.cx + ' ' + y2;
        label = { x: (a.cx + b.cx) / 2, y: (y1 + y2) / 2 + 4, rot: 0 };
      } else {
        // 跨層：出來、走軌道、再進去，不穿過中間的節點
        var e1 = y1 + rl.off, e2 = y2 - rl.off;
        d = 'M' + a.cx + ' ' + y1 + ' L' + a.cx + ' ' + e1 + ' L' + rl.x + ' ' + e1 +
            ' L' + rl.x + ' ' + e2 + ' L' + b.cx + ' ' + e2 + ' L' + b.cx + ' ' + y2;
        label = { x: rl.x, y: (e1 + e2) / 2, rot: -90 };
      }

      svg += '<path class="g-edge ' + st.cls + '" d="' + d + '" marker-end="url(#gm-' + st.cls +
             ')"><title>' + tip + '</title></path>';

      if (pin && pin !== '—') {
        var w = pin.length * 6.1 + 10;
        var g = label.rot
          ? ' transform="rotate(-90 ' + label.x + ' ' + label.y + ')"'
          : '';
        svg += '<g' + g + '><rect class="g-pin-bg" x="' + (label.x - w / 2) + '" y="' +
               (label.y - 11) + '" width="' + w + '" height="15" rx="4"/>' +
               '<text class="g-pin ' + st.cls + '" x="' + label.x + '" y="' + label.y +
               '" text-anchor="middle">' + esc(pin) + '</text></g>';
      }
    });

    Object.keys(xy).forEach(function (id) {
      var p = xy[id], d = state.data[id] || {};
      var ver = (d.releases && d.releases[0] && d.releases[0].tag) ||
                (d.tags && d.tags[0] && d.tags[0].name) || '無版本 tag';
      svg += '<g class="g-node">' +
        '<rect class="g-box" x="' + p.x + '" y="' + p.y + '" width="' + BW + '" height="' + BH + '" rx="6"/>' +
        '<text class="g-name" x="' + (p.x + 11) + '" y="' + (p.y + 19) + '">' + esc(shortName(id)) + '</text>' +
        '<text class="g-ver" x="' + (p.x + 11) + '" y="' + (p.y + 34) + '">' + esc(ver) + '</text>' +
        '</g>';
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
    }).join('') + '<span class="g-hint">線上的字是釘住的版本，滑過去看細節</span></div>';
  }

  function renderDeps() {
    var sec = $('#deps');
    if (!CFG.analyseDeps || !state.repos.length) { sec.hidden = true; return; }
    sec.hidden = false;

    var d = state.deps;
    if (!d) {
      $('#deps-status').textContent = '尚未分析 · 會讀各 repo 的 .gitmodules 與 Cargo.toml';
      $('#btn-deps').textContent = '分析';
      $('#btn-deps-toggle').hidden = true;
      $('.seg-group').hidden = true;
      $('#deps-body').innerHTML = '';
      return;
    }

    var drift = d.edges.filter(function (e) { return edgeState(e).cls === 'behind'; }).length;
    var forked = d.edges.filter(function (e) { return edgeState(e).cls === 'diverged'; }).length;
    $('#deps-status').textContent = '分析於 ' + relTime(d.analysedAt) + ' · ' + d.edges.length +
      ' 條內部相依' +
      (drift || forked
        ? '，其中 ' + (drift ? drift + ' 條可以升版' : '') + (drift && forked ? '、' : '') +
          (forked ? forked + ' 條釘在別的分支' : '')
        : '，全部同步') +
      ' · 這次用了 ' + d.calls + ' 次 API';
    $('#btn-deps').textContent = '重新分析';
    $('#btn-deps-toggle').hidden = false;
    $('.seg-group').hidden = false;

    var rows = d.edges.slice().sort(function (a, b) {
      var rank = function (e) { return { behind: 0, diverged: 1, unknown: 2, sync: 3 }[edgeState(e).cls]; };
      return rank(a) - rank(b) || (b.behind || 0) - (a.behind || 0) || a.from.localeCompare(b.from);
    });

    var view = state.depsView || 'graph';
    var html = '';

    if (view === 'graph') {
      html += '<div class="graphwrap">' + depsGraphSvg(rows) + '</div>' + depsLegend();
      if (d.external.length) html += externalHtml(d);
      if (state.depsRendered !== d.analysedAt + view) {
        $('#deps-body').innerHTML = html;
        state.depsRendered = d.analysedAt + view;
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

    if (state.depsRendered !== d.analysedAt + view) {
      $('#deps-body').innerHTML = html;
      state.depsRendered = d.analysedAt + view;
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

    $('#btn-deps').addEventListener('click', analyseDeps);
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
