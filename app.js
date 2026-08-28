/* Caliptra 更新儀表板 — 純前端，無相依套件。 */
(function () {
  'use strict';

  var CFG = Object.assign({
    org: 'chipsalliance',
    keyword: 'caliptra',
    extraRepos: [],
    excludeRepos: [],
    commitsShown: 5,
    weeks: 8,
    showReleases: true,
    freshDays: 7,
    staleDays: 30
  }, window.TRACKER_CONFIG || {});

  var API = 'https://api.github.com';
  var WEEK = 7 * 86400000;
  var KEY = {
    cache: 'caliptra-tracker.cache',
    seen: 'caliptra-tracker.seen',
    token: 'caliptra-tracker.token',
    theme: 'caliptra-tracker.theme'
  };

  var state = {
    repos: [],      // repo 摘要
    data: {},       // full_name -> { pushed_at, commits, commitDates, release }
    fetchedAt: null,
    seenAt: null,
    rate: null,
    calls: 0,
    busy: false
  };

  /* ---------- localStorage（無痕或擋 cookie 時要能不炸） ---------- */

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  /* ---------- 小工具 ---------- */

  var $ = function (sel) { return document.querySelector(sel); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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

    var headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
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
    if (err instanceof ApiError && err.status === 404) return '找不到這個 repo（可能已改名或是私有的）。';
    return err && err.message ? err.message : '發生未知錯誤。';
  }

  /* ---------- 抓取 ---------- */

  function normalizeRepo(r) {
    return {
      full_name: r.full_name,
      name: r.name,
      html_url: r.html_url || ('https://github.com/' + r.full_name),
      description: r.description || '',
      default_branch: r.default_branch,
      pushed_at: r.pushed_at,
      stars: r.stargazers_count,
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

  // 一個 repo 的更新內容：近 N 週的 commit（1 次 API）＋ 最新 release（1 次 API）
  function loadRepoData(repo) {
    var since = new Date(Date.now() - CFG.weeks * WEEK).toISOString();

    var commits = gh('/repos/' + repo.full_name + '/commits', {
      sha: repo.default_branch, since: since, per_page: 100
    }).then(function (list) {
      return list.map(function (c) {
        return {
          sha: c.sha,
          url: c.html_url,
          title: (c.commit.message || '').split('\n')[0],
          author: (c.author && c.author.login) || (c.commit.author && c.commit.author.name) || 'unknown',
          date: (c.commit.author && c.commit.author.date) || (c.commit.committer && c.commit.committer.date)
        };
      });
    });

    var release = CFG.showReleases
      ? gh('/repos/' + repo.full_name + '/releases', { per_page: 1 }).then(function (list) {
          if (!list.length) return null;
          var r = list[0];
          return { name: r.name || r.tag_name, tag: r.tag_name, url: r.html_url, date: r.published_at };
        }, function () { return null; })
      : Promise.resolve(null);

    return Promise.all([commits, release]).then(function (out) {
      return {
        pushed_at: repo.pushed_at,
        commits: out[0].slice(0, 12),                              // 卡片上顯示用
        commitDates: out[0].map(function (c) { return c.date; }),  // 活躍度長條圖用
        truncated: out[0].length >= 100,
        release: out[1]
      };
    });
  }

  /* ---------- 活躍度：把 commit 分到每一週 ---------- */

  function weeklyBuckets(dates) {
    var n = CFG.weeks;
    var buckets = new Array(n).fill(0);
    var now = Date.now();
    (dates || []).forEach(function (d) {
      var age = now - new Date(d).getTime();
      if (age < 0) age = 0;
      var idx = n - 1 - Math.floor(age / WEEK);   // 最後一格＝本週
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
      var weeksAgo = buckets.length - 1 - i;
      var label = (weeksAgo === 0 ? '本週' : weeksAgo + ' 週前') + '：' + v + ' 個 commit';
      svg += '<rect class="' + cls + '" x="' + x + '" y="' + (h - bh) + '" width="' + w +
             '" height="' + bh + '" rx="2"><title>' + esc(label) + '</title></rect>';
    });
    return svg + '</svg>';
  }

  /* ---------- 快取 ---------- */

  function saveCache() {
    lsSet(KEY.cache, JSON.stringify({
      fetchedAt: state.fetchedAt, repos: state.repos, data: state.data
    }));
  }

  function loadCache() {
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

  /* ---------- 畫面 ---------- */

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

  function allCommits() {
    var out = [];
    state.repos.forEach(function (r) {
      var d = state.data[r.full_name];
      if (d && d.commits) out = out.concat(d.commits);
    });
    return out;
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
    var stale = live.filter(function (r) { return freshness(r.pushed_at) === 'stale'; }).length;

    el.innerHTML =
      tile('近 7 天 commit', commits7, '所有追蹤 repo 加總', 'hero') +
      tile('自上次查看以來', unread, unread ? '個新 commit' : '沒有新的', unread ? 'accent' : '') +
      tile('活躍 repo', active + ' / ' + live.length, CFG.freshDays + ' 天內有更新', '') +
      tile('久未更新', stale, '超過 ' + CFG.staleDays + ' 天沒動', '');
  }

  function tile(label, value, sub, kind) {
    return '<div class="tile ' + (kind || '') + '">' +
      '<div class="t-label">' + esc(label) + '</div>' +
      '<div class="t-value">' + esc(value) + '</div>' +
      '<div class="t-sub">' + esc(sub) + '</div></div>';
  }

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
        (d && d.commits ? d.commits.map(function (c) { return c.title; }).join(' ') : '');
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

  function cardHtml(repo) {
    var d = state.data[repo.full_name] || {};
    var buckets = weeklyBuckets(d.commitDates);
    var total = (d.commitDates || []).length;
    var base = 'https://github.com/' + repo.full_name;

    var head =
      '<div class="c-head">' +
        (isNew(repo.pushed_at) ? '<span class="dot" title="有你尚未看過的更新"></span>' : '') +
        '<a class="c-name" href="' + esc(base) + '" target="_blank" rel="noopener">' + esc(repo.name) + '</a>' +
        (repo.archived ? '<span class="chip">已封存</span>' : '') +
        '<span class="c-time f-' + freshness(repo.pushed_at) + '" title="' +
          (repo.pushed_at ? esc(new Date(repo.pushed_at).toLocaleString('zh-TW')) : '') + '">' +
          esc(relTime(repo.pushed_at)) + '</span>' +
      '</div>' +
      '<p class="c-desc">' + esc(repo.description || '（沒有說明）') + '</p>';

    var stripLabel = total + (d.truncated ? '+' : '') + ' commit';
    var strip =
      '<div class="c-strip">' +
        sparkline(buckets) +
        '<span class="s-count">近 ' + CFG.weeks + ' 週 <strong>' + esc(stripLabel) + '</strong></span>' +
        (d.release
          ? '<a class="chip release" href="' + esc(d.release.url) + '" target="_blank" rel="noopener" title="發佈於 ' +
            esc(relTime(d.release.date)) + '">' + esc(d.release.tag || d.release.name) + '</a>'
          : '') +
      '</div>';

    var body;
    if (d.error) {
      body = '<p class="c-error">' + esc(d.error) + '</p>';
    } else if (!d.commits || !d.commits.length) {
      body = '<p class="c-empty">近 ' + CFG.weeks + ' 週沒有新的 commit。</p>';
    } else {
      body = '<ul class="commits">';
      d.commits.slice(0, CFG.commitsShown).forEach(function (c) {
        body += '<li>' +
          (isNew(c.date) ? '<span class="tag-new">NEW</span>' : '<span class="tag-spacer"></span>') +
          '<a class="c-title" href="' + esc(c.url) + '" target="_blank" rel="noopener" title="' +
            esc(c.title) + '">' + esc(c.title) + '</a>' +
          '<span class="c-when">' + esc(relTime(c.date)) + '</span>' +
        '</li>';
      });
      body += '</ul>';
      if (total > CFG.commitsShown) {
        body += '<a class="more" href="' + esc(base) + '/commits/' + esc(repo.default_branch) +
                '" target="_blank" rel="noopener">還有 ' + (total - CFG.commitsShown) +
                ' 筆，到 GitHub 看全部 →</a>';
      }
    }

    return '<article class="card f-' + freshness(repo.pushed_at) + (repo.archived ? ' archived' : '') + '">' +
      head + strip + body + '</article>';
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

  /* ---------- 動作 ---------- */

  function setBusy(on, label) {
    state.busy = on;
    var btn = $('#btn-refresh');
    btn.disabled = on;
    btn.textContent = on ? (label || '抓取中…') : '更新';
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
          state.data[repo.full_name] = { pushed_at: repo.pushed_at, error: errText(err), commits: [], commitDates: [] };
        }).then(step);
      })();
    });
  }

  function needsData(repo) {
    var d = state.data[repo.full_name];
    return !d || d.error || d.pushed_at !== repo.pushed_at;
  }

  function wantData(repo) {
    return !repo.archived || $('#show-archived').checked;
  }

  // 勾選「顯示已封存」時，補抓那些之前跳過的 repo
  function fetchMissing() {
    if (state.busy) return;
    var targets = state.repos.filter(function (r) { return wantData(r) && needsData(r); });
    if (!targets.length) return;
    setBusy(true);
    fetchEach(targets).then(function () {
      banner('');
      saveCache();
      setBusy(false);
      render();
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

      // 只重抓「上游真的有動過」的 repo，其餘沿用快取；封存的 repo 不看就不抓
      var targets = repos.filter(function (r) { return wantData(r) && needsData(r); });

      if (!targets.length) { banner(''); return; }

      return fetchEach(targets).then(function () {
        banner('更新完成，這次用了 ' + state.calls + ' 次 API。', 'info');
        setTimeout(function () { banner(''); }, 4000);
      });
    }).then(function () {
      if (!state.seenAt && state.repos.length) {
        // 第一次抓取沒有比較基準，就把現在當基準點，下次更新才看得出哪些是新的
        state.seenAt = new Date().toISOString();
        lsSet(KEY.seen, state.seenAt);
      }
      saveCache();
      render();
    }).catch(function (err) {
      banner(errText(err), 'error');
    }).then(function () { setBusy(false); });
  }

  function markRead() {
    // 取「現在」與「已抓到的最新 commit 時間」較晚者，避免對方 commit 時間比本機時鐘快時永遠標成未讀
    var t = Date.now();
    allCommits().forEach(function (c) {
      var d = new Date(c.date).getTime();
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
