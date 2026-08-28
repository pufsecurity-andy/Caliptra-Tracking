/* Caliptra 更新追蹤 — 純前端，無相依套件。 */
(function () {
  'use strict';

  var CFG = Object.assign({
    org: 'chipsalliance',
    keyword: 'caliptra',
    extraRepos: [],
    excludeRepos: [],
    commitsPerRepo: 15,
    freshDays: 7,
    staleDays: 30
  }, window.TRACKER_CONFIG || {});

  var API = 'https://api.github.com';
  var KEY = {
    cache: 'caliptra-tracker.cache',
    seen: 'caliptra-tracker.seen',
    token: 'caliptra-tracker.token',
    theme: 'caliptra-tracker.theme'
  };

  var state = {
    repos: [],        // repo 摘要
    details: {},      // full_name -> { commits, release }
    expanded: {},     // full_name -> true
    fetchedAt: null,
    seenAt: null,
    rate: null,
    busy: false
  };

  /* ---------- localStorage（開無痕或擋 cookie 時要能不炸） ---------- */

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
    if (s < 3600) return Math.floor(s / 60) + ' 分鐘前';
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
      html_url: r.html_url,
      description: r.description || '',
      default_branch: r.default_branch,
      pushed_at: r.pushed_at,
      stars: r.stargazers_count,
      archived: !!r.archived,
      open_count: r.open_issues_count   // GitHub 的這個數字含 issue + PR
    };
  }

  function isExcluded(fullName) {
    var name = fullName.split('/')[1];
    return (CFG.excludeRepos || []).some(function (x) {
      return x === fullName || x === name;
    });
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

  function loadDetail(repo) {
    var commits = gh('/repos/' + repo.full_name + '/commits', {
      sha: repo.default_branch, per_page: CFG.commitsPerRepo
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

    var release = gh('/repos/' + repo.full_name + '/releases', { per_page: 1 })
      .then(function (list) {
        if (!list.length) return null;
        var r = list[0];
        return { name: r.name || r.tag_name, tag: r.tag_name, url: r.html_url, date: r.published_at };
      }, function () { return null; });

    return Promise.all([commits, release]).then(function (out) {
      return { commits: out[0], release: out[1] };
    });
  }

  /* ---------- 快取 ---------- */

  function saveCache() {
    lsSet(KEY.cache, JSON.stringify({
      fetchedAt: state.fetchedAt,
      repos: state.repos,
      details: state.details
    }));
  }

  function loadCache() {
    var raw = lsGet(KEY.cache);
    if (!raw) return false;
    try {
      var data = JSON.parse(raw);
      state.repos = data.repos || [];
      state.details = data.details || {};
      state.fetchedAt = data.fetchedAt || null;
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
    var newCount = state.repos.filter(function (r) { return isNew(r.pushed_at); }).length;
    var shown = visibleRepos().length;
    var count = shown === state.repos.length
      ? ('追蹤 ' + state.repos.length + ' 個 repo')
      : ('顯示 ' + shown + ' / 共 ' + state.repos.length + ' 個 repo');
    var parts = [count, '資料時間 ' + relTime(state.fetchedAt)];
    if (state.seenAt) {
      parts.push(newCount > 0 ? (newCount + ' 個有新更新') : '沒有新更新');
    }
    line.textContent = parts.join(' · ');
  }

  function visibleRepos() {
    var q = $('#search').value.trim().toLowerCase();
    var onlyNew = $('#only-new').checked;
    var showArchived = $('#show-archived').checked;

    var rows = state.repos.filter(function (r) {
      if (r.archived && !showArchived) return false;
      if (onlyNew && !isNew(r.pushed_at)) return false;
      if (!q) return true;
      return (r.full_name + ' ' + r.description).toLowerCase().indexOf(q) !== -1;
    });

    var sort = $('#sort').value;
    rows.sort(function (a, b) {
      if (sort === 'name') return a.full_name.localeCompare(b.full_name);
      if (sort === 'stars') return (b.stars || 0) - (a.stars || 0);
      return new Date(b.pushed_at || 0) - new Date(a.pushed_at || 0);
    });
    return rows;
  }

  function detailHtml(repo) {
    var d = state.details[repo.full_name];
    if (!d) return '<p class="loading">載入中…</p>';
    if (d.error) return '<p class="error">' + esc(d.error) + '</p>';

    var html = '';

    if (d.release) {
      html += '<div class="release">最新 release：' +
        '<a href="' + esc(d.release.url) + '" target="_blank" rel="noopener">' + esc(d.release.name) + '</a>' +
        ' <span class="muted">' + relTime(d.release.date) + '</span></div>';
    }

    if (!d.commits || !d.commits.length) {
      html += '<p class="muted">沒有抓到 commit。</p>';
    } else {
      html += '<ul class="commits">';
      d.commits.forEach(function (c) {
        html += '<li class="' + (isNew(c.date) ? 'is-new' : '') + '">' +
          (isNew(c.date) ? '<span class="tag-new">NEW</span>' : '') +
          '<a class="c-title" href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.title) + '</a>' +
          '<span class="c-meta">' + esc(c.author) + ' · ' + relTime(c.date) +
          ' · <code>' + esc(c.sha.slice(0, 7)) + '</code></span></li>';
      });
      html += '</ul>';
    }

    var base = 'https://github.com/' + repo.full_name;
    html += '<div class="links">' +
      '<a href="' + base + '/commits/' + esc(repo.default_branch) + '" target="_blank" rel="noopener">所有 commit</a>' +
      '<a href="' + base + '/pulls" target="_blank" rel="noopener">Pull requests</a>' +
      '<a href="' + base + '/issues" target="_blank" rel="noopener">Issues</a>' +
      '<a href="' + base + '/releases" target="_blank" rel="noopener">Releases</a>' +
      '</div>';

    return html;
  }

  function render() {
    renderMeta();
    var list = $('#list');
    list.textContent = '';

    var rows = visibleRepos();
    if (!rows.length) {
      list.innerHTML = state.repos.length
        ? '<p class="empty">沒有符合條件的 repo。</p>'
        : '<p class="empty">還沒有資料。按右上角「更新」抓取 ' + esc(CFG.org) + ' 底下的 Caliptra repo。</p>';
      return;
    }

    var tpl = $('#tpl-repo');
    rows.forEach(function (repo) {
      var node = tpl.content.cloneNode(true);
      var art = node.querySelector('.repo');
      art.dataset.repo = repo.full_name;
      art.classList.add('f-' + freshness(repo.pushed_at));
      if (repo.archived) art.classList.add('archived');

      node.querySelector('.dot').hidden = !isNew(repo.pushed_at);
      node.querySelector('.repo-name').textContent = repo.name + (repo.archived ? '（已封存）' : '');
      node.querySelector('.repo-desc').textContent = repo.description;
      node.querySelector('.repo-stars').textContent = repo.stars ? '★ ' + repo.stars : '';
      var t = node.querySelector('.repo-time');
      t.textContent = relTime(repo.pushed_at);
      t.title = repo.pushed_at ? new Date(repo.pushed_at).toLocaleString('zh-TW') : '';

      var body = node.querySelector('.repo-body');
      if (state.expanded[repo.full_name]) {
        art.classList.add('open');
        body.hidden = false;
        body.innerHTML = detailHtml(repo);
      }
      list.appendChild(node);
    });
  }

  /* ---------- 動作 ---------- */

  function setBusy(on, label) {
    state.busy = on;
    var btn = $('#btn-refresh');
    btn.disabled = on;
    btn.textContent = on ? (label || '抓取中…') : '更新';
    $('#btn-fetch-all').disabled = on;
  }

  function refresh() {
    if (state.busy) return;
    setBusy(true);
    banner('');
    loadRepoList().then(function (repos) {
      state.repos = repos;
      state.fetchedAt = new Date().toISOString();
      // repo 已更新過的話，之前抓的 commit 清單就過期了
      Object.keys(state.details).forEach(function (fn) {
        var r = repos.filter(function (x) { return x.full_name === fn; })[0];
        if (!r || state.details[fn].pushed_at !== r.pushed_at) delete state.details[fn];
      });
      saveCache();
      if (!state.seenAt && repos.length) {
        // 第一次抓取沒有比較基準，就把現在當成基準點，下次更新才看得出哪些是新的
        state.seenAt = new Date().toISOString();
        lsSet(KEY.seen, state.seenAt);
      }
      render();
      if (!repos.length) {
        banner('沒有找到符合條件的 repo，檢查一下 config.js 的 org / keyword。', 'warn');
        return;
      }
      var stale = repos.filter(function (r) {
        return state.expanded[r.full_name] && !state.details[r.full_name];
      });
      if (!stale.length) return;
      return fetchDetails(stale).then(function () {
        banner('');
        saveCache();
        render();
      });
    }).catch(function (err) {
      banner(errText(err), 'error');
    }).then(function () { setBusy(false); });
  }

  function expand(fullName) {
    var repo = state.repos.filter(function (r) { return r.full_name === fullName; })[0];
    if (!repo) return Promise.resolve();
    if (state.details[fullName] && !state.details[fullName].error) { render(); return Promise.resolve(); }

    render(); // 先顯示「載入中」
    return loadDetail(repo).then(function (d) {
      d.pushed_at = repo.pushed_at;
      state.details[fullName] = d;
      saveCache();
      render();
    }).catch(function (err) {
      state.details[fullName] = { error: errText(err), commits: [] };
      render();
    });
  }

  // 逐一（而非同時）抓取，避免一次打爆 GitHub 的次要速率限制
  function fetchDetails(targets) {
    return new Promise(function (resolve) {
      var i = 0;
      (function step() {
        if (i >= targets.length) { resolve(); return; }
        var repo = targets[i++];
        state.expanded[repo.full_name] = true;
        banner('抓取中 ' + i + ' / ' + targets.length + '：' + repo.name, 'info');
        setBusy(true, '抓取中 ' + i + '/' + targets.length);
        loadDetail(repo).then(function (d) {
          d.pushed_at = repo.pushed_at;
          state.details[repo.full_name] = d;
        }, function (err) {
          state.details[repo.full_name] = { error: errText(err), commits: [] };
        }).then(step);
      })();
    });
  }

  function fetchAll() {
    if (state.busy) return;
    var rows = visibleRepos();
    rows.forEach(function (r) { state.expanded[r.full_name] = true; });
    var targets = rows.filter(function (r) { return !state.details[r.full_name]; });
    if (!targets.length) { render(); return; }

    setBusy(true);
    fetchDetails(targets).then(function () {
      banner('');
      saveCache();
      setBusy(false);
      render();
    });
  }

  function markRead() {
    state.seenAt = new Date().toISOString();
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
    if (!hadCache) refresh();   // 第一次進來自動抓一次（只花 1 次 API）

    $('#btn-refresh').addEventListener('click', refresh);
    $('#btn-fetch-all').addEventListener('click', fetchAll);
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

    $('#list').addEventListener('click', function (e) {
      var head = e.target.closest('.repo-head');
      if (!head) return;
      var fullName = head.closest('.repo').dataset.repo;
      if (state.expanded[fullName]) {
        delete state.expanded[fullName];
        render();
      } else {
        state.expanded[fullName] = true;
        expand(fullName);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
