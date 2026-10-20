#!/usr/bin/env node
/**
 * Collect today's Xiamen development jobs from Zhaopin's public web API.
 *
 * Usage:
 *   node scripts/collect.mjs
 *   TODAYJOB_DATE=2026-10-21 node scripts/collect.mjs
 *   TODAYJOB_OUTPUT=/tmp/preview.md node scripts/collect.mjs
 *
 * Optional environment:
 *   ZHAOPIN_COOKIE      Cookie header from a zhaopin.com browser session.
 *                       With a valid session, the API returns up to 90 rows/page
 *                       and 1000 rows/keyword. Without it, the script falls back
 *                       to the anonymous limit (20 rows/page, 100/keyword).
 *   TODAYJOB_MAX_PAGES  Override the per-keyword page cap.
 *   TODAYJOB_OUTPUT     Write the generated post to this path instead.
 *
 * The script is intentionally serial and conservative: it pauses between
 * requests, stops immediately on risk-control code 2024, and never touches
 * private endpoints.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const TIME_ZONE = 'Asia/Shanghai';
const CITY_CODE = '682';
const CITY_NAME = '厦门';
const API_URL = 'https://fe-api.zhaopin.com/c/i/search/positions';

const TARGET_DATE = process.env.TODAYJOB_DATE?.trim() || shanghaiDate(new Date());
const COOKIE = process.env.ZHAOPIN_COOKIE?.trim() || '';
const OUTPUT_PATH =
  process.env.TODAYJOB_OUTPUT ||
  path.join(ROOT, 'content', 'post', TARGET_DATE, 'index.md');
const REQUEST_DELAY_MS = 650;
const REQUEST_TIMEOUT_MS = 20_000;

const KEYWORDS = [
  '开发',
  'Java',
  '前端',
  '后端',
  'Python',
  '软件开发',
  '前端开发',
  '后端开发',
  '软件工程师',
  '测试开发',
  '算法工程师',
  '大数据',
  '人工智能',
  '机器学习',
  '数据开发',
  '运维开发',
  '全栈开发',
  '嵌入式开发',
  '游戏开发',
  '安卓',
  'Android',
  'iOS',
  'C++',
  'C#',
  '.NET',
  'PHP',
  'Go',
  'Node.js',
  'React',
  'Vue',
  '小程序',
  '鸿蒙',
  'Flutter',
  '低代码',
  '区块链',
  '云计算',
  'DevOps',
];

const STRONG_DEV = [
  /软件工程师/,
  /软件开发/,
  /软件研发/,
  /系统研发/,
  /平台研发/,
  /后端研发/,
  /前端研发/,
  /客户端研发/,
  /服务端研发/,
  /游戏研发/,
  /前端/,
  /后端/,
  /全栈/,
  /测试开发/,
  /运维开发/,
  /数据开发/,
  /数据挖掘/,
  /数据仓库/,
  /数仓/,
  /大数据/,
  /人工智能/,
  /机器学习/,
  /深度学习/,
  /大模型/,
  /算法/,
  /架构/,
  /嵌入式/,
  /驱动/,
  /固件/,
  /\bbsp\b/i,
  /游戏开发/,
  /游戏客户端/,
  /游戏服务端/,
  /游戏引擎/,
  /unity/i,
  /unreal/i,
  /\bue[45]\b/i,
  /cocos/i,
  /安卓/,
  /android/i,
  /ios/i,
  /java/i,
  /python/i,
  /golang/i,
  /\bgo\b/i,
  /php/i,
  /c\+\+/i,
  /c#/i,
  /\.net/i,
  /node/i,
  /react/i,
  /vue/i,
  /\bweb\b/i,
  /小程序/,
  /鸿蒙/,
  /flutter/i,
  /区块链/,
  /云计算/,
  /devops/i,
  /\bsre\b/i,
  /\bdba\b/i,
  /数据库/,
  /低代码/,
  /客户端/,
  /服务端/,
  /\bai\b/i,
  /上位机/,
  /机器视觉/,
  /视觉算法/,
  /视觉软件/,
  /图像算法/,
  /\bsap\b/i,
];

const GENERIC_DEV = [/开发/, /程序员/];

// Hardware/mechanical roles must not sneak in through a generic "开发/研发"
// or an embedded keyword. A title that also mentions software/driver/firmware
// is allowed to pass.
const HARD_EXCLUDE = [
  /硬件(?!.*(软件|驱动|固件|程序|开发))/,
];

const DOMAIN_EXCLUDE = [
  /硬件/,
  /电子(?!商务)/,
  /电气/,
  /工艺/,
  /材料/,
  /化工/,
  /化学/,
  /生物/,
  /医药/,
  /医疗/,
  /机械/,
  /结构/,
  /模具/,
  /光学/,
  /光电/,
  /激光/,
  /电池/,
  /储能/,
  /复合材料/,
  /\bcad\b/i,
  /绘图/,
  /产品开发/,
  /开发专员/,
  /设备/,
  /继电器/,
  /合成/,
  /有机/,
  /试剂/,
  /抗体/,
  /蛋白/,
  /免疫/,
  /诊断/,
  /发酵/,
  /米面/,
  /面食/,
  /小吃/,
  /电感/,
  /变压器/,
  /磁性/,
  /电机/,
  /马达/,
  /线束/,
  /连接器/,
  /电源/,
  /射频/,
  /天线/,
  /\bpcb\b/i,
  /\bfpga\b/i,
  /芯片/,
  /半导体/,
  /仪器/,
  /自动化(?!.*(软件|开发|程序))/,
  /食品/,
  /课程/,
  /化妆品/,
  /服装/,
  /家具/,
  /玩具/,
  /包装/,
  /印刷/,
  /建筑/,
  /土木/,
  /规划师/,
  /商户开发/,
  /膜产品/,
  /纯化/,
  /代肝/,
  /打手/,
  /代练/,
  /陪玩/,
];

const NON_DEV_EXCLUDE = [
  /销售/,
  /业务开发/,
  /市场开发/,
  /客户开发/,
  /渠道/,
  /招商/,
  /开单/,
  /店员/,
  /客服/,
  /运营/,
  /人事/,
  /行政/,
  /财务/,
  /会计/,
  /出纳/,
  /文员/,
  /普工/,
  /操作工/,
  /司机/,
  /保安/,
  /保洁/,
  /厨师/,
  /烘焙/,
  /医药代表/,
  /货代/,
  /外贸/,
  /采购/,
  /教师/,
  /培训/,
  /产品经理/,
  /项目经理/,
  /设计师/,
  /美工/,
  /摄影/,
  /剪辑/,
  /主播/,
  /律师/,
  /猎头/,
  /招聘/,
  /咨询顾问/,
  /销售代表/,
  /经理/,
  /主管/,
  /总监/,
  /负责人/,
  /组长/,
  /私募/,
  /财富管理/,
  /数据库运维/,
  /系统运维/,
  /网络运维/,
  /IT运维/i,
  /支持工程师/,
  /机构开发/,
  /特渠/,
  /店长/,
  /督导/,
  /地编/,
  /美术/,
  /原画/,
  /建模/,
  /动画/,
  /特效/,
  /UI设计/,
  /视觉设计/,
  /平面设计/,
];

class RiskControlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RiskControlError';
    this.code = 'RISK_CONTROL_2024';
  }
}

class AuthEmptyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthEmptyError';
    this.code = 'AUTH_EMPTY';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function shanghaiParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') === '24' ? '00' : get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function shanghaiDate(date) {
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function shanghaiDateTime(date) {
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function shanghaiIso(date) {
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
}

function parsePublishTime(value) {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.trim().replace(' ', 'T');
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized)
    ? normalized
    : `${normalized}+08:00`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(value) {
  const date = parsePublishTime(value);
  return date ? shanghaiDateTime(date) : '';
}

function cookieMap(cookie) {
  const map = new Map();
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) map.set(key, value);
  }
  return map;
}

function randomCacheBuster() {
  return Math.random().toString().slice(2, 12).padEnd(10, '0');
}

function normalizeUrl(raw, id) {
  if (id) return `https://www.zhaopin.com/jobdetail/${id}.htm`;
  if (!raw) return '';
  return String(raw)
    .replace(/^http:\/\/jobs\.zhaopin\.com/i, 'https://www.zhaopin.com/jobdetail')
    .replace(/^http:\/\//i, 'https://');
}

function normalizeJob(raw) {
  const id = String(raw?.number || raw?.jobId || '').trim();
  if (!id) return null;

  const title = String(raw?.name || '').trim();
  const company = String(raw?.companyName || '').trim();
  if (!title || !company) return null;

  return {
    id,
    title,
    company,
    city: String(raw?.workCity || '').trim(),
    cityId: String(raw?.cityId || '').trim(),
    district: String(raw?.cityDistrict || '').trim(),
    street: String(raw?.streetName || '').trim(),
    publishTime: String(raw?.publishTime || raw?.firstPublishTime || '').trim(),
    publishedAt: parsePublishTime(raw?.publishTime || raw?.firstPublishTime),
    url: normalizeUrl(raw?.positionUrl || raw?.positionURL, id),
  };
}

function isXiamen(job) {
  return job.city.includes(CITY_NAME) || job.cityId === CITY_CODE;
}

function isDevTitle(title) {
  if (!title) return false;
  if (NON_DEV_EXCLUDE.some((re) => re.test(title))) return false;
  if (HARD_EXCLUDE.some((re) => re.test(title))) return false;
  if (STRONG_DEV.some((re) => re.test(title))) return true;
  if (!GENERIC_DEV.some((re) => re.test(title))) return false;
  return !DOMAIN_EXCLUDE.some((re) => re.test(title));
}

function requestHeaders(cookie) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: 'https://www.zhaopin.com',
    Referer: 'https://www.zhaopin.com/',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'x-zp-platform': '13',
    'x-zp-business-system': '1',
    'x-zp-page-code': '0',
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

async function requestJson(url, init, attempt = 1) {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await response.text();
    if (!response.ok) {
      if (response.status === 2024) {
        throw new RiskControlError('Zhaopin returned HTTP 2024');
      }
      if (response.status === 403 || response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status}`);
      }
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (/security\/certification|captcha|验证/i.test(text)) {
        throw new RiskControlError('Zhaopin returned a security page instead of JSON');
      }
      throw new Error(`Non-JSON response: ${text.slice(0, 160)}`);
    }

    const apiCode = Number(json.code ?? json.apiCode ?? json.statusCode);
    if (apiCode === 2024) {
      throw new RiskControlError('Zhaopin risk control code 2024');
    }
    if (apiCode !== 200) {
      throw new Error(`API code ${apiCode}: ${json.message || json.msg || 'unknown error'}`);
    }
    return json;
  } catch (error) {
    if (error instanceof RiskControlError) throw error;
    if (attempt >= 3) throw error;
    const wait = 700 * 2 ** (attempt - 1);
    console.error(`[retry ${attempt}/3] ${error.message}; waiting ${wait}ms`);
    await sleep(wait);
    return requestJson(url, init, attempt + 1);
  }
}

function createClient() {
  const jar = cookieMap(COOKIE);
  const at = jar.get('at') || '';
  const rt = jar.get('rt') || '';
  const full = Boolean(at && rt);
  return {
    mode: full ? 'full' : 'anonymous',
    cookie: full ? COOKIE : '',
    at,
    rt,
    pageSize: full ? 90 : 20,
    maxPages: Number(process.env.TODAYJOB_MAX_PAGES) || (full ? 6 : 5),
    checked: false,
    requests: 0,
  };
}

function asAnonymous(client, reason) {
  if (client.mode === 'anonymous') return client;
  console.error(`[auth] ${reason}; falling back to anonymous mode`);
  return {
    ...client,
    mode: 'anonymous',
    cookie: '',
    at: '',
    rt: '',
    pageSize: 20,
    maxPages: Number(process.env.TODAYJOB_MAX_PAGES) || 5,
    checked: true,
  };
}

async function fetchPage(client, keyword, pageIndex) {
  const query = new URLSearchParams({
    platform: '13',
    version: '0.0.0',
    _v: randomCacheBuster(),
  });
  if (client.mode === 'full') {
    query.set('at', client.at);
    query.set('rt', client.rt);
    query.set('x-zp-client-id', cookieMap(client.cookie).get('x-zp-client-id') || '');
  }

  const body = {
    S_SOU_FULL_INDEX: keyword,
    S_SOU_WORK_CITY: CITY_CODE,
    order: 4,
    sortType: 'JOB_PUBLISH_TIME',
    pageSize: client.pageSize,
    pageIndex,
    platform: 13,
    version: '0.0.0',
    eventScenario: 'pcSearchedSouSearch',
    anonymous: client.mode === 'full' ? 0 : 1,
  };

  client.requests += 1;
  const json = await requestJson(`${API_URL}?${query.toString()}`, {
    method: 'POST',
    headers: requestHeaders(client.cookie),
    body: JSON.stringify(body),
  });

  const data = json.data || {};
  if (client.mode === 'full' && !client.checked) {
    client.checked = true;
    if (Number(data.count || 0) === 0 && (!Array.isArray(data.list) || data.list.length === 0)) {
      throw new AuthEmptyError('session returned zero results');
    }
  }

  return {
    count: Number(data.count || 0),
    isEndPage: Number(data.isEndPage || 0),
    list: Array.isArray(data.list) ? data.list : [],
  };
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function locationText(jobs) {
  const districts = uniqueStrings(jobs.map((job) => job.district));
  if (districts.length === 0) return CITY_NAME;
  return `${CITY_NAME} · ${districts.slice(0, 3).join('、')}${districts.length > 3 ? ' 等' : ''}`;
}

function aggregate(jobs) {
  const byCompany = new Map();
  for (const job of jobs) {
    const key = job.company.replace(/\s+/g, ' ').trim();
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(job);
  }

  const companies = [];
  for (const [company, list] of byCompany) {
    const sorted = [...list].sort((a, b) => {
      const at = a.publishedAt?.getTime() || 0;
      const bt = b.publishedAt?.getTime() || 0;
      return bt - at;
    });
    const representative = sorted[0];
    companies.push({
      company,
      count: sorted.length,
      location: locationText(sorted),
      title: representative.title,
      url: representative.url,
      publishTime: representative.publishTime,
      latestAt: representative.publishedAt?.getTime() || 0,
    });
  }

  companies.sort(
    (a, b) =>
      b.count - a.count ||
      b.latestAt - a.latestAt ||
      a.company.localeCompare(b.company, 'zh-CN'),
  );
  return companies;
}

function mdCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function mdLinkText(value) {
  return mdCell(value).replace(/([\[\]])/g, '\\$1');
}

function renderMarkdown({ companies, devJobs, allJobsOnDate, keywords, client, collectedAt }) {
  const [year, month, day] = TARGET_DATE.split('-');
  const title = `${year}年${Number(month)}月${Number(day)}日 厦门开发岗位日报`;
  const totalCompanies = companies.length;
  const totalJobs = devJobs.length;
  const description =
    totalJobs > 0
      ? `${TARGET_DATE}，厦门共 ${totalCompanies} 家公司发布 ${totalJobs} 个开发岗位。`
      : `${TARGET_DATE}，厦门暂未采集到符合条件的开发岗位。`;

  const lines = [
    '---',
    `title: "${title}"`,
    `slug: "${TARGET_DATE}"`,
    `date: ${shanghaiIso(collectedAt)}`,
    `description: "${description.replace(/"/g, '\\"')}"`,
    'categories:',
    '    - 日报',
    'tags:',
    '    - 厦门',
    '    - 开发岗位',
    '    - 招聘日报',
    'comments: false',
    '---',
    '',
    `> 统计日期：${TARGET_DATE}（北京时间 00:00–24:00）  `,
    '> 数据来源：智联招聘公开职位接口  ',
    `> 采集时间：${shanghaiDateTime(collectedAt)}  `,
    `> 采集方式：${client.mode === 'full' ? '登录会话接口' : '匿名接口（单关键词最多 100 条）'}`,
    '',
    '## 今日概览',
    '',
    `- 公司：**${totalCompanies}** 家`,
    `- 开发岗位：**${totalJobs}** 个`,
    `- 当日去重岗位：**${allJobsOnDate}** 个（含非开发岗）`,
    `- 覆盖关键词：**${keywords}** 个`,
    '',
  ];

  if (totalJobs === 0) {
    lines.push(
      '今天暂时没有采集到符合条件的岗位。',
      '',
      '可能是当天尚未发布新岗位，也可能是接口返回延迟。建议稍后刷新，或直接前往智联招聘搜索“厦门 开发”。',
    );
  } else {
    lines.push(
      '<!--more-->',
      '',
      '## 公司汇总',
      '',
      '| 公司名称 | 今日职位发布数量 | 地点 | 岗位链接 | 发布时间 |',
      '| --- | ---: | --- | --- | --- |',
    );

    for (const item of companies) {
      const linkTitle = mdCell(item.title).replace(/"/g, '\\"');
      const link = item.url
        ? `[查看岗位](${item.url} "${linkTitle}")`
        : '查看岗位';
      lines.push(
        `| ${mdCell(item.company)} | ${item.count} | ${mdCell(item.location)} | ${link} | ${mdCell(formatTime(item.publishTime))} |`,
      );
    }
  }

  lines.push(
    '',
    '## 数据说明',
    '',
    '- 仅统计发布时间在统计日期内的厦门开发岗位，按公司名称聚合。',
    '- “今日职位发布数量”是该公司当天在厦门发布的开发岗位数；同一岗位跨关键词命中只计一次。',
    '- “岗位链接”取该公司当天最新发布的一个岗位，点击可查看详情；悬停可查看具体岗位名称。',
    '- 招聘平台数据可能存在延迟、重复或下架，最终以智联招聘页面为准。',
  );

  if (client.mode !== 'full') {
    lines.push(
      '- 本次使用匿名接口额度（每个关键词最多返回 100 条），结果可能未覆盖全部岗位。',
    );
  }

  lines.push('', '');
  return lines.join('\n');
}

async function collect() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(TARGET_DATE)) {
    throw new Error(`Invalid TODAYJOB_DATE: ${TARGET_DATE}`);
  }

  let client = createClient();
  console.error(
    `[start] date=${TARGET_DATE} mode=${client.mode} keywords=${KEYWORDS.length} ` +
      `pageSize=${client.pageSize} maxPages=${client.maxPages}`,
  );

  const jobs = new Map();
  let allJobsOnDate = new Set();
  let requestCount = 0;

  for (const keyword of KEYWORDS) {
    let stalePages = 0;
    let keywordHits = 0;

    for (let pageIndex = 1; pageIndex <= client.maxPages; pageIndex += 1) {
      let page;
      try {
        page = await fetchPage(client, keyword, pageIndex);
      } catch (error) {
        if (error instanceof AuthEmptyError) {
          client = asAnonymous(client, error.message);
          pageIndex -= 1;
          continue;
        }
        throw error;
      }

      requestCount = client.requests;
      if (page.list.length === 0) break;

      let newest = 0;
      for (const raw of page.list) {
        const job = normalizeJob(raw);
        if (!job) continue;
        const date = job.publishedAt ? shanghaiDate(job.publishedAt) : '';
        if (date === TARGET_DATE) {
          allJobsOnDate.add(job.id);
          if (isXiamen(job) && isDevTitle(job.title)) {
            const previous = jobs.get(job.id);
            if (!previous || (job.publishedAt?.getTime() || 0) > (previous.publishedAt?.getTime() || 0)) {
              jobs.set(job.id, job);
            }
            keywordHits += 1;
          }
        }
        const ts = job.publishedAt?.getTime() || 0;
        if (ts > newest) newest = ts;
      }

      const targetDateStart = new Date(`${TARGET_DATE}T00:00:00+08:00`).getTime();
      const pageIsOld = newest > 0 && newest < targetDateStart;
      stalePages = pageIsOld ? stalePages + 1 : 0;

      if (page.isEndPage === 1) break;
      if (stalePages >= 2) break;

      if (requestCount % 10 === 0) {
        console.error(
          `[progress] requests=${requestCount} keyword=${keyword} page=${pageIndex} jobs=${jobs.size}`,
        );
      }
      await sleep(REQUEST_DELAY_MS + Math.floor(Math.random() * 120));
    }

    console.error(`[keyword] ${keyword}: +${keywordHits} (unique=${jobs.size})`);
  }

  const devJobs = [...jobs.values()];
  const companies = aggregate(devJobs);
  const collectedAt = new Date();
  const markdown = renderMarkdown({
    companies,
    devJobs,
    allJobsOnDate: allJobsOnDate.size,
    keywords: KEYWORDS.length,
    client,
    collectedAt,
  });

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, markdown, 'utf8');

  const summary = {
    date: TARGET_DATE,
    mode: client.mode,
    requests: client.requests,
    allJobsOnDate: allJobsOnDate.size,
    devJobs: devJobs.length,
    companies: companies.length,
    output: OUTPUT_PATH,
  };
  console.log(JSON.stringify(summary, null, 2));
}

collect().catch((error) => {
  if (error instanceof RiskControlError) {
    console.error(`[fatal] risk control: ${error.message}. Stop immediately; do not retry.`);
    process.exit(2);
  }
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exit(1);
});
