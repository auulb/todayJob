#!/usr/bin/env node
/**
 * 前程无忧（51job）独立采集器 —— 采集 + 生成文章，一条龙，自成一体。
 *
 * **与智联模块零耦合**：不读写 collect.env、不 import scripts/collect.mjs、
 * 不做数据合并、产出自己的一篇文章：
 *
 *     content/post/51job-<日期>/index.md
 *     .todayjob/job51-<日期>.json          （中间结果，便于复用/排查）
 *     .todayjob/job51-last-run.json        （运行摘要）
 *
 * 为什么必须用浏览器：/api/job/search-pc 在阿里云 WAF 后面，请求要带页面内
 * WAF SDK 在 XHR 发出前注入的 decode__1048。curl / node fetch / page.request
 * 都会被拦成挑战页，只有"真浏览器页面内的 XMLHttpRequest"能通过。
 * 详见仓库外的《51job接口逆向报告.md》。
 *
 * 用法：
 *   node scripts/job51/collect.mjs
 *   JOB51_DATE=2026-10-21 JOB51_POST=/tmp/preview.md node scripts/job51/collect.mjs
 *
 * 配置：collect-51job.env（JOB51_CITIES / JOB51_JOBS / JOB51_LIMITS）
 * 安全：请求串行 + 强制延迟 + 总预算；一旦识别风控立即整体停止，
 *       不重试风暴、不换代理、不伪造指纹。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { loadConfig } from './config.mjs';
import { matchesJobTitle } from './filter.mjs';
import { loadCityDict, resolveCity } from './city.mjs';
import { postDir, postPath, renderPost } from './render.mjs';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const TIME_ZONE = 'Asia/Shanghai';
const SEARCH_PAGE = 'https://we.51job.com/pc/search';

const TARGET_DATE = process.env.JOB51_DATE?.trim() || shanghaiDate(new Date());
const OUTPUT_PATH =
  process.env.JOB51_OUTPUT || path.join(ROOT, '.todayjob', `job51-${TARGET_DATE}.json`);
const STATUS_PATH =
  process.env.JOB51_STATUS_FILE || path.join(ROOT, '.todayjob', 'job51-last-run.json');
const POST_PATH = process.env.JOB51_POST || path.join(ROOT, postPath(TARGET_DATE));

class WafBlockedError extends Error {}

/**
 * 瞬态失败：WAF 挑战页 / 空响应 / 请求被挂住 / 网络抖动。
 * 实测同一个页面里这几种情况会随机出现（同一关键词重发一次往往就正常），
 * 因此允许有限次重试；连续失败到上限才当成"被风控"整体停止。
 */
class TransientError extends Error {
  constructor(kind, detail = '') {
    super(`${kind}${detail ? `: ${detail}` : ''}`);
    this.kind = kind;
  }
}

const DEBUG = Boolean(process.env.JOB51_DEBUG);
const t0 = Date.now();
function trace(...args) {
  if (DEBUG) console.error(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shanghaiDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * 页面内执行：发一次列表 XHR，并把 94 个字段裁剪成 17 个再传回 Node。
 * 必须用 XMLHttpRequest —— WAF SDK 只 hook XHR，不 hook fetch。
 * 绝不能自己拼 decode__1048，让它由 SDK 追加。
 */
async function fetchPageInPage({ area, keyword, pageNum, pageSize, issueDate }) {
  // ⚠️ 本函数会被序列化后在页面里执行，不能引用外层变量。
  const xhr = () =>
    new Promise((resolve) => {
      const url =
        `https://we.51job.com/api/job/search-pc?api_key=51job&timestamp=${Math.floor(Date.now() / 1000)}` +
        `&keyword=${encodeURIComponent(keyword)}&searchType=2&function=&industry=` +
        `&jobArea=${area}&jobArea2=&landmark=&metro=&salary=&workYear=&degree=` +
        `&companyType=&companySize=&jobType=&issueDate=${issueDate}&sortType=0` +
        `&pageNum=${pageNum}&requestId=&keywordType=&pageSize=${pageSize}` +
        '&source=1&pageCode=sou%7Csou%7Csoulb&scene=7';

      const x = new XMLHttpRequest();
      x.open('GET', url);
      x.timeout = 25_000;
      x.onload = () => {
        const text = x.responseText || '';
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        const job = json?.resultbody?.job;
        const blocked = !job && /aliyun_waf|_waf_bd8ce2ce37|renderData/i.test(text);
        resolve({
          http: x.status,
          bytes: text.length,
          blocked,
          ok: Boolean(job),
          status: json?.status ?? null,
          total: job?.totalCount ?? null,
          items: (job?.items || []).map((it) => ({
            jobId: String(it.jobId || ''),
            jobName: it.jobName || '',
            company: it.companyName || it.fullCompanyName || '',
            fullCompany: it.fullCompanyName || '',
            areaText: it.jobAreaString || '',
            cityCode: String(it.jobAreaCode || ''),
            district:
              it.jobAreaLevelDetail?.districtString ||
              (String(it.jobAreaString || '').split('·')[1] || ''),
            issueDateString: it.issueDateString || '',
            updateDateTime: it.updateDateTime || '',
            salary: it.provideSalaryString || '',
            salaryMin: it.jobSalaryMin || '',
            salaryMax: it.jobSalaryMax || '',
            href: it.jobHref || '',
            term: it.termStr || '',
            degree: it.degreeString || '',
            workYear: it.workYearString || '',
            companyType: it.companyTypeString || '',
            companySize: it.companySizeString || '',
            jd: String(it.jobDescribe || '').slice(0, 160),
          })),
        });
      };
      x.onerror = () => resolve({ http: 0, ok: false, blocked: false, error: 'network' });
      x.ontimeout = () => resolve({ http: 0, ok: false, blocked: false, error: 'timeout' });
      x.send();
    });

  return xhr();
}

async function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_PATH, 'playwright-core', 'playwright']
    .filter(Boolean);
  const errors = [];
  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      if (mod?.chromium) return { chromium: mod.chromium, from: candidate };
    } catch (error) {
      errors.push(`${candidate}: ${String(error.message || error).split('\n')[0]}`);
    }
  }
  throw new Error(
    '没有找到 playwright。请执行 `npm i -D playwright-core`（本地也可用 ' +
      'PLAYWRIGHT_PATH 指向已有的 playwright-core）。尝试过：\n  ' +
      errors.join('\n  '),
  );
}

function challengeReason(html) {
  return /aliyun_waf|_waf_bd8ce2ce37|renderData|aliyunwaf_/i.test(html);
}

async function waitForApp(page, cityName) {
  // WAF 挑战页里没有 #app；真页面一定有。等它出现即代表 SDK 已就绪。
  try {
    await page.waitForFunction(() => Boolean(document.querySelector('#app')), {
      timeout: 25_000,
      polling: 250,
    });
  } catch {
    const html = await page.content().catch(() => '');
    if (challengeReason(html)) {
      throw new WafBlockedError(`打开搜索页时被 WAF 挑战页拦截（${cityName}）`);
    }
    throw new Error(`搜索页未渲染出 #app（${cityName}），可能是页面结构变化`);
  }
}

async function openCityPage(context, city) {
  const page = await context.newPage();
  const url =
    `${SEARCH_PAGE}?jobArea=${city.code}` +
    `&keyword=${encodeURIComponent('开发')}&searchType=2&keywordType=`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForApp(page, city.name);
  return page;
}

async function fetchPage(page, { city, keyword, pageIndex, limits }) {
  const label = `${city.name}/${keyword} p${pageIndex}`;

  // WAF SDK 会 hook XMLHttpRequest，可能吞掉 timeout 事件，导致 evaluate 永远不返回。
  // 必须在 Node 侧加硬超时，否则整个采集会挂死。
  const result = await Promise.race([
    page.evaluate(fetchPageInPage, {
      area: city.code,
      keyword,
      pageNum: pageIndex,
      pageSize: limits.pageSize,
      issueDate: limits.issueDate,
    }),
    sleep(limits.requestTimeoutMs).then(() => ({
      http: 0,
      ok: false,
      blocked: false,
      stalled: true,
    })),
  ]);

  if (result.stalled) {
    throw new TransientError('stall', `${label} 超过 ${limits.requestTimeoutMs}ms 无响应`);
  }
  if (result.blocked) {
    throw new TransientError('waf-challenge', `${label} 返回挑战页 ${result.bytes}B`);
  }
  if (!result.ok) {
    if (result.http === 403 || result.http === 429) {
      throw new WafBlockedError(`接口返回 ${result.http}（${label}），停止采集`);
    }
    if (result.http === 0 || result.error) {
      throw new TransientError('network', `${label} ${result.error || 'http=0'}`);
    }
    // 200 但 body 极短：实测 WAF 会返回空响应
    if (result.bytes < 2000) {
      throw new TransientError('empty', `${label} bytes=${result.bytes}`);
    }
    throw new Error(`${label} 返回异常：status=${result.status} bytes=${result.bytes}`);
  }
  return result;
}

/** 带一次重试的取页；连续瞬态失败累计到上限即整体停止。 */
async function fetchPageWithRetry(page, opts, state) {
  let lastError;
  for (let attempt = 0; attempt <= opts.limits.maxRetries; attempt += 1) {
    if (state.budget.used >= opts.limits.maxRequestsPerRun) {
      throw new Error('request budget exhausted');
    }
    state.budget.used += 1;
    try {
      const page_ = await fetchPage(page, opts);
      state.transientFailures = 0;
      return page_;
    } catch (error) {
      if (!(error instanceof TransientError)) throw error;
      lastError = error;
      state.transientFailures += 1;
      state.transientErrors.push(String(error.message));
      if (state.transientFailures >= opts.limits.maxTransientFailures) {
        throw new WafBlockedError(
          `连续 ${state.transientFailures} 次瞬态失败，判定被风控：${error.message}`,
        );
      }
      if (attempt < opts.limits.maxRetries) {
        trace('retry after transient failure', error.message);
        await sleep(opts.limits.retryDelayMs);
        // 实测连续请求约 35 次后 XHR 会开始"挂住"；重新加载页面能换一套
        // WAF 会话参数，比重试同一个挂死的 XHR 更有效。
        if (error.kind === 'stall' && state.refresh) {
          try {
            await state.refresh();
            trace('page reloaded after stall');
          } catch (refreshError) {
            trace('reload failed', String(refreshError.message || refreshError));
          }
        }
      }
    }
  }
  throw lastError;
}

function normalizePosting(item, city) {
  const id = String(item.jobId || '').trim();
  const title = String(item.jobName || '').trim();
  const company = String(item.company || '').trim();
  if (!id || !title || !company) return null;
  return {
    source: 'job51',
    id,
    title,
    company,
    city: city.name,
    cityId: city.code,
    district: String(item.district || '').trim(),
    publishTime: String(item.issueDateString || '').trim(),
    publishedAt: parsePublishTime(item.issueDateString),
    updatedAt: parsePublishTime(item.updateDateTime),
    url: String(item.href || '').trim() ||
      `https://jobs.51job.com/${id}.html`,
    salary: String(item.salary || '').trim(),
    salaryMin: String(item.salaryMin || '').trim(),
    salaryMax: String(item.salaryMax || '').trim(),
    term: String(item.term || '').trim(),
    degree: String(item.degree || '').trim(),
    workYear: String(item.workYear || '').trim(),
    companyType: String(item.companyType || '').trim(),
    companySize: String(item.companySize || '').trim(),
    jd: String(item.jd || '').trim(),
  };
}

function parsePublishTime(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  // 51job 返回 "2026-10-20 10:11:36"（北京时间），无时区后缀
  const iso = text.includes('T') ? text : text.replace(' ', 'T');
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const date = new Date(hasZone ? iso : `${iso}+08:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function countryDay(date) {
  return shanghaiDate(date);
}

async function collectTarget({ page, city, job, limits, state }) {
  const postings = new Map();
  const allOnDate = new Set();
  const requestsBefore = state.budget.used;
  let attempted = 0;
  let budgetHit = false;

  for (const keyword of job.keywords) {
    if (state.budget.used >= limits.maxRequestsPerRun) {
      budgetHit = true;
      break;
    }
    attempted += 1;

    for (let pageIndex = 1; pageIndex <= limits.maxPagesPerKeyword; pageIndex += 1) {
      if (state.budget.used >= limits.maxRequestsPerRun) {
        budgetHit = true;
        break;
      }

      trace('xhr', city.name, keyword, 'p' + pageIndex);
      let page_;
      try {
        page_ = await fetchPageWithRetry(page, { city, keyword, pageIndex, limits }, state);
      } catch (error) {
        if (error instanceof WafBlockedError) throw error;
        if (/budget exhausted/.test(error.message)) {
          budgetHit = true;
          break;
        }
        state.errors.push(String(error.message || error));
        break; // 单关键词失败不重试，继续下一个
      }

      for (const item of page_.items) {
        const posting = normalizePosting(item, city);
        if (!posting) continue;
        const day = posting.publishedAt ? countryDay(posting.publishedAt) : '';
        if (day !== TARGET_DATE) continue;
        allOnDate.add(posting.id);
        if (!matchesJobTitle(posting.title, job)) continue;
        const previous = postings.get(posting.id);
        if (!previous || (posting.updatedAt?.getTime() || 0) > (previous.updatedAt?.getTime() || 0)) {
          postings.set(posting.id, posting);
        }
      }

      if (page_.items.length < limits.pageSize) break;
      await page.evaluate(
        (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        limits.requestDelayMs + Math.floor(Math.random() * (limits.requestJitterMs + 1)),
      );
    }

    if (budgetHit) break;
    await page.evaluate(
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      limits.requestDelayMs + Math.floor(Math.random() * (limits.requestJitterMs + 1)),
    );
  }

  return {
    city: { name: city.name, code: city.code },
    job: { name: job.name, profile: job.profile },
    keywords: attempted,
    keywordsTotal: job.keywords.length,
    requests: state.budget.used - requestsBefore,
    allJobsOnDate: allOnDate.size,
    budgetExhausted: budgetHit,
    postings: [...postings.values()].sort(
      (a, b) => (b.updatedAt?.getTime() || 0) - (a.updatedAt?.getTime() || 0),
    ),
  };
}

async function main() {
  const startedAt = Date.now();
  const { cities, jobs, limits } = await loadConfig();
  const { cities: cityDict, source: dictSource } = await loadCityDict({ root: ROOT });

  const resolvedCities = cities.map((city) => ({
    name: city.name,
    code: city.code || resolveCity(cityDict, city.name).code,
  }));

  console.error(
    `[config] ${dictSource} | ${resolvedCities.map((c) => `${c.name}=${c.code}`).join(', ')} | ` +
      `jobs=${jobs.map((j) => `${j.name}(${j.keywords.length})`).join(',')} | ` +
      `issueDate=${limits.issueDate} pageSize=${limits.pageSize}`,
  );

  const { chromium, from } = await loadChromium();
  const targets = [];
  const state = {
    budget: { used: 0 },
    errors: [],
    transientErrors: [],
    transientFailures: 0,
  };
  let wafBlocked = false;
  let ua = '';

  trace('launching browser');
  const browser = await chromium.launch({
    channel: limits.channel || undefined,
    headless: limits.headless,
    timeout: 60_000,
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  });

  trace('browser ready');
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: TIME_ZONE,
    });

    for (const city of resolvedCities) {
      if (state.budget.used >= limits.maxRequestsPerRun) break;
      let page;
      try {
        page = await openCityPage(context, city);
        trace('page ready', city.name, page.url());
        state.refresh = async () => {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
          await waitForApp(page, city.name);
        };
      } catch (error) {
        if (error instanceof WafBlockedError) {
          wafBlocked = true;
          state.errors.push(error.message);
          break;
        }
        state.errors.push(String(error.message || error));
        continue;
      }

      ua = ua || (await page.evaluate(() => navigator.userAgent));

      for (const job of jobs) {
        if (state.budget.used >= limits.maxRequestsPerRun) break;
        try {
          const limitedJob = {
            ...job,
            keywords: job.keywords.slice(0, limits.maxKeywordsPerJob),
          };
          const target = await collectTarget({ page, city, job: limitedJob, limits, state });
          target.keywordsConfigured = job.keywords.length;
          targets.push(target);
          console.error(
            `[target] ${city.name}/${job.name}: ${target.postings.length} 条 / ` +
              `当日(全部岗位)=${target.allJobsOnDate} / requests=${target.requests}`,
          );
        } catch (error) {
          if (error instanceof WafBlockedError) {
            wafBlocked = true;
            state.errors.push(error.message);
            break;
          }
          state.errors.push(String(error.message || error));
        }
      }

      // 城市之间才需要长冷却；同一页面内继续下一个岗位即可。
      await sleep(limits.cityCooldownMs);
      await page.close().catch(() => {});
      if (wafBlocked) break;
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const payload = {
    source: 'job51',
    date: TARGET_DATE,
    generatedAt: new Date().toISOString(),
    ok: !wafBlocked && state.errors.length === 0,
    wafBlocked,
    browser: { from, channel: limits.channel, headless: limits.headless, ua },
    limits,
    requests: state.budget.used,
    elapsedMs: Date.now() - startedAt,
    errors: state.errors,
    transientErrors: state.transientErrors,
    targets,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  // 一条岗位都没有就不发文章，避免污染首页（宁可少一天，也不要空日报）。
  const totalPostings = targets.reduce((sum, target) => sum + target.postings.length, 0);
  let postWritten = '';
  if (totalPostings > 0) {
    const markdown = renderPost(payload);
    await mkdir(path.dirname(POST_PATH), { recursive: true });
    await writeFile(POST_PATH, markdown, 'utf8');
    postWritten = POST_PATH;
  } else {
    console.error('[post] 本次 0 条岗位，跳过文章生成');
  }

  const summary = {
    source: 'job51',
    ok: payload.ok,
    wafBlocked,
    requests: payload.requests,
    targets: targets.length,
    jobs: targets.reduce((sum, t) => sum + t.postings.length, 0),
    onDate: targets.reduce((sum, t) => sum + t.allJobsOnDate, 0),
    errors: state.errors.length,
    transientRetries: state.transientErrors.length,
    output: OUTPUT_PATH,
    post: postWritten,
    postDir: postWritten ? postDir(TARGET_DATE) : '',
    elapsedMs: payload.elapsedMs,
  };
  await mkdir(path.dirname(STATUS_PATH), { recursive: true });
  await writeFile(STATUS_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));

  if (wafBlocked) {
    // 明确失败但不抛异常：CI 里这一步是 continue-on-error，不需要红色报错。
    process.exitCode = 0;
  }
}

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exit(1);
});
