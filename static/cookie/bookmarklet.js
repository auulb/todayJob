/*
 * TodayJob — Zhaopin cookie helper bookmarklet.
 *
 * This function is turned into a javascript: bookmark by /cookie/. It runs only
 * on zhaopin.com, reads the five cookies used by scripts/collect.mjs, validates
 * the session against the same public search API, and shows the Cookie string
 * in a local copy box. Nothing is uploaded anywhere.
 */
function todayJobCookieHelper() {
  var wanted = ['x-zp-client-id', 'smidV2', 'at', 'rt', 'x-zp-device-sn'];
  var jar = {};
  document.cookie.split(';').forEach(function (part) {
    var i = part.indexOf('=');
    if (i < 0) return;
    var key = part.slice(0, i).trim();
    if (wanted.indexOf(key) !== -1) jar[key] = part.slice(i + 1).trim();
  });

  var cookie = wanted
    .filter(function (key) { return jar[key]; })
    .map(function (key) { return key + '=' + jar[key]; })
    .join('; ');
  var missing = wanted.filter(function (key) { return !jar[key]; });
  var requiredMissing = ['at', 'rt'].filter(function (key) { return !jar[key]; });

  var old = document.getElementById('todayjob-cookie-helper');
  if (old) old.remove();

  var overlay = document.createElement('div');
  overlay.id = 'todayjob-cookie-helper';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.62);' +
    'display:flex;align-items:center;justify-content:center;padding:18px;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;';

  var panel = document.createElement('div');
  panel.style.cssText =
    'width:min(680px,100%);max-height:90vh;overflow:auto;background:#fff;color:#0f172a;' +
    'border-radius:16px;padding:22px;box-shadow:0 24px 80px rgba(0,0,0,.35);';
  panel.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px">' +
      '<div>' +
        '<div style="font-size:18px;font-weight:700">TodayJob · 智联招聘 Cookie</div>' +
        '<div style="margin-top:3px;font-size:12px;color:#64748b">只在当前页面读取，不会上传</div>' +
      '</div>' +
      '<button type="button" data-close style="border:0;background:#f1f5f9;border-radius:9px;padding:8px 12px;font-size:13px;cursor:pointer">关闭</button>' +
    '</div>' +
    '<div data-status style="margin-top:16px;padding:10px 12px;border-radius:10px;background:#f8fafc;font-size:13px;line-height:1.6;color:#475569">正在检查登录态…</div>' +
    '<textarea readonly spellcheck="false" data-cookie style="margin-top:12px;width:100%;box-sizing:border-box;height:132px;resize:vertical;border:1px solid #cbd5e1;border-radius:10px;padding:10px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#0f172a;background:#f8fafc"></textarea>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;flex-wrap:wrap">' +
      '<div data-count style="font-size:12px;color:#64748b"></div>' +
      '<button type="button" data-copy style="border:0;background:#2563eb;color:#fff;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer">复制 Cookie</button>' +
    '</div>' +
    '<div style="margin-top:16px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.7;color:#64748b">' +
      'Cookie 等同于登录凭证，请勿发给他人。复制后到 GitHub 仓库的 ' +
      '<b style="color:#334155">Settings → Secrets → Actions → ZHAOPIN_COOKIE</b> 更新。' +
    '</div>';

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  var textarea = panel.querySelector('[data-cookie]');
  var status = panel.querySelector('[data-status]');
  var count = panel.querySelector('[data-count]');
  var copyBtn = panel.querySelector('[data-copy]');
  textarea.value = cookie;

  var optionalMissing = missing.filter(function (key) {
    return key !== 'at' && key !== 'rt';
  });
  count.textContent =
    '已读取 ' + (wanted.length - missing.length) + '/' + wanted.length + ' 项' +
    (optionalMissing.length ? '（缺少 ' + optionalMissing.join('、') + '）' : '');

  function close() {
    overlay.remove();
  }

  panel.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', function onKey(event) {
    if (event.key === 'Escape') {
      document.removeEventListener('keydown', onKey);
      close();
    }
  });

  copyBtn.addEventListener('click', function () {
    function done() {
      copyBtn.textContent = '已复制 ✓';
      copyBtn.style.background = '#15803d';
      setTimeout(function () {
        copyBtn.textContent = '复制 Cookie';
        copyBtn.style.background = '#2563eb';
      }, 1800);
    }
    function manual() {
      copyBtn.textContent = '请手动全选复制';
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
    }
    function selectAndCopy() {
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      try {
        return document.execCommand('copy');
      } catch (error) {
        return false;
      }
    }

    // Prefer the synchronous path: it works in more browsers and does not
    // depend on clipboard permissions or a focused document.
    if (selectAndCopy()) {
      done();
      return;
    }

    if (navigator.clipboard && window.isSecureContext) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          manual();
        }
      }, 1200);
      navigator.clipboard.writeText(cookie).then(function () {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          done();
        }
      }).catch(function () {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          manual();
        }
      });
    } else {
      manual();
    }
  });

  if (requiredMissing.length) {
    status.textContent =
      '未检测到登录态（缺少 ' + requiredMissing.join('、') + '）。' +
      '请先在智联招聘登录，并确认当前页面是 www.zhaopin.com，然后再点一次书签。';
    status.style.background = '#fef2f2';
    status.style.color = '#b91c1c';
    return;
  }

  status.textContent = '已读取 Cookie，正在向智联招聘接口验证登录态…';
  var query = new URLSearchParams({
    platform: '13',
    version: '0.0.0',
    _v: String(Date.now()),
    at: jar.at,
    rt: jar.rt,
    'x-zp-client-id': jar['x-zp-client-id'] || '',
  });

  fetch('https://fe-api.zhaopin.com/c/i/search/positions?' + query.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      S_SOU_FULL_INDEX: '开发',
      S_SOU_WORK_CITY: '682',
      order: 4,
      sortType: 'JOB_PUBLISH_TIME',
      pageSize: 20,
      pageIndex: 1,
      platform: 13,
      version: '0.0.0',
      eventScenario: 'pcSearchedSouSearch',
      anonymous: 0,
    }),
  })
    .then(function (response) { return response.json(); })
    .then(function (json) {
      var total = Number((json && json.data && json.data.count) || 0);
      if (json && json.code === 200 && total > 0) {
        status.textContent = '登录态有效：接口返回 ' + total + ' 条结果，可以复制使用。';
        status.style.background = '#f0fdf4';
        status.style.color = '#15803d';
      } else {
        status.textContent =
          '验证未通过：接口返回 0 条（code=' + ((json && json.code) || '?') + '）。' +
          'Cookie 可能已过期，建议重新登录后再生成。仍然可以复制，但采集可能回退到匿名模式。';
        status.style.background = '#fef2f2';
        status.style.color = '#b91c1c';
      }
    })
    .catch(function () {
      status.textContent =
        '已生成 Cookie，但浏览器内验证失败（网络或接口限制）。仍然可以复制使用。';
      status.style.background = '#fffbeb';
      status.style.color = '#a16207';
    });
}
