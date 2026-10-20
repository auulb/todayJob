#!/usr/bin/env node
/**
 * 阶段① 探测：51job 在 headless 浏览器里能否通过阿里云 WAF。
 *
 * 背景：接口逆向阶段的全部实测都在 headful Chromium 中完成。
 * GitHub Actions 无显示器，必须确认 headless 是否被拦。
 *
 * 用法（本地，借用 npx 缓存里的 playwright）：
 *   PLAYWRIGHT_PATH=~/.npm/_npx/<hash>/node_modules/playwright-core \
 *     node scripts/spike-51job-headless.mjs
 *
 * 输出：每个组合一行 JSON + 末尾 summary。
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_PATH || 'playwright-core';
const { chromium } = require(PW);

const AREA = process.env.SPIKE_AREA || '110300'; // 厦门
const KEYWORD = process.env.SPIKE_KEYWORD || '开发';

const COMBOS = [
  { name: 'A_bundled_headless', opts: { headless: true } },
  { name: 'B_chrome_headless', opts: { channel: 'chrome', headless: true } },
  { name: 'C_chrome_headful', opts: { channel: 'chrome', headless: false } },
];

function pageUrl() {
  return `https://we.51job.com/pc/search?jobArea=${AREA}&keyword=${encodeURIComponent(KEYWORD)}&searchType=2&keywordType=`;
}

function xhrScript({ area, keyword, issueDate }) {
  const url =
    'https://we.51job.com/api/job/search-pc' +
    `?api_key=51job&timestamp=${Math.floor(Date.now() / 1000)}` +
    `&keyword=${encodeURIComponent(keyword)}&searchType=2&function=&industry=` +
    `&jobArea=${area}&jobArea2=&landmark=&metro=&salary=&workYear=&degree=` +
    `&companyType=&companySize=&jobType=&issueDate=${issueDate}&sortType=0` +
    '&pageNum=1&requestId=&keywordType=&pageSize=200' +
    '&source=1&pageCode=sou%7Csou%7Csoulb&scene=7';

  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.timeout = 20000;
    x.onload = () => {
      const text = x.responseText || '';
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      const job = json?.resultbody?.job;
      const isWaf = !json && /aliyun_waf|_waf_bd8ce2ce37|renderData/i.test(text);
      resolve({
        http: x.status,
        bytes: text.length,
        ok: Boolean(job),
        isWaf,
        status: json?.status ?? null,
        total: job?.totalCount ?? null,
        n: job?.items?.length ?? null,
        first: job?.items?.[0]?.jobName ?? null,
        head: text.slice(0, 120),
      });
    };
    x.onerror = () => resolve({ http: 0, error: 'network' });
    x.ontimeout = () => resolve({ http: 0, error: 'timeout' });
    x.send();
  });
}

async function runCombo({ name, opts }) {
  const started = Date.now();
  const result = { name, launch: { ...opts }, ok: false };
  let browser;
  try {
    browser = await chromium.launch({ ...opts, timeout: 45000 });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    const page = await context.newPage();

    await page.goto(pageUrl(), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500); // 让 WAF SDK 完成注入

    // 关掉可能挡住交互的弹窗不影响 XHR，直接发
    result.results = [];
    for (const issueDate of ['1', '']) {
      const r = await page.evaluate(xhrScript, {
        area: AREA,
        keyword: KEYWORD,
        issueDate,
      });
      result.results.push({ issueDate: issueDate || 'all', ...r });
      await page.waitForTimeout(800);
    }

    const good = result.results.filter((r) => r.ok);
    result.ok = good.length === result.results.length;
    result.ua = await page.evaluate(() => navigator.userAgent);
  } catch (error) {
    result.error = String(error.message || error).split('\n')[0];
    // 没下载捆绑浏览器 ≠ 被 WAF 拦，单独标记，避免误导。
    if (/Executable doesn't exist|browser.*not found|Please run/i.test(result.error)) {
      result.skipped = true;
      result.error = '未安装捆绑浏览器（与 WAF 无关）';
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    result.ms = Date.now() - started;
  }
  return result;
}

const summary = [];
for (const combo of COMBOS) {
  const r = await runCombo(combo);
  summary.push({ name: r.name, ok: r.ok, skipped: r.skipped, ms: r.ms, error: r.error });
  console.log(JSON.stringify(r, null, 2));
}

console.log('=== SUMMARY ===');
for (const s of summary) {
  const mark = s.ok ? '✅' : s.skipped ? '⏭ ' : '❌';
  console.log(
    `${mark} ${s.name.padEnd(22)} ${String(s.ms).padStart(6)}ms ${
      s.error ? ' ' + s.error : ''
    }`,
  );
}
const pass = summary.filter((s) => s.ok).map((s) => s.name);
console.log(`PASSING_MODES=${pass.join(',') || 'NONE'}`);
process.exit(pass.length ? 0 : 1);
