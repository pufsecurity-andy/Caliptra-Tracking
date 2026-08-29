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
  var WEEK = 7 * 86400000;
  var COMMITS_KEPT = 40;      // 每個 repo 留幾筆 commit 在快取裡
  var DIFF_KEPT = 120;        // 最多快取幾筆 commit 的 diff
  var PATCH_MAX_LINES = 400;  // 單一檔案 diff 超過就截斷

  var KEY = {
    cache: 'caliptra-tracker.cache',
    diffs: 'caliptra-tracker.diffs',
    seen: 'caliptra-tracker.seen',
    token: 'caliptra-tracker.token',
    theme: 'caliptra-tracker.theme'
  };

  var state = {
    repos: [],
    data: {},        // full_name -> { pushed_at, commits, commitDates, releases, tags }
    diffs: {},       // sha -> { files, stats, seq }
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

    var raw = lsGet(KEY.cache);
    if (!raw) return false;
    try {
      var c = JSON.parse(raw);
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
      head + versionHtml(repo) + strip + body + '</article>';
  }

  function render() {
    renderMeta();
    renderStats();

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
