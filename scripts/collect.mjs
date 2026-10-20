#!/usr/bin/env node
/**
 * Collect today's jobs from Zhaopin's public web API.
 *
 * The city and job sets live in collect.env so they can be changed without
 * editing this script. Every run is serial, rate-limited, capped by a
 * per-run request budget, and stops immediately on risk-control code 2024.
 *
 * Usage:
 *   node scripts/collect.mjs
 *   TODAYJOB_DATE=2026-10-21 node scripts/collect.mjs
 *   TODAYJOB_OUTPUT=/tmp/preview.md node scripts/collect.mjs
 *   TODAYJOB_ENV_FILE=/tmp/collect.env node scripts/collect.mjs
 *
 * Optional environment:
 *   ZHAOPIN_COOKIE       Cookie header from a zhaopin.com browser session.
 *                        With a valid session, the API returns up to 90 rows/page
 *                        and 1000 rows/keyword. Without it, the script falls back
 *                        to the anonymous limit (20 rows/page, 100/keyword).
 *   TODAYJOB_ENV_FILE    Path to the env config. Defaults to collect.env.
 *   TODAYJOB_CITIES      City set; overrides collect.env. Simple form:
 *                        厦门:682,福州:591. JSON array is also accepted.
 *   TODAYJOB_JOBS        Job set; overrides collect.env. Simple form:
 *                        开发:dev:开发|Java|前端. JSON array is also accepted.
 *   TODAYJOB_LIMITS      Optional JSON object overriding the built-in limits.
 *   TODAYJOB_MAX_PAGES   Override the per-keyword page cap.
 *   TODAYJOB_MAX_REQUESTS
 *                        Override the per-run request budget.
 *   TODAYJOB_OUTPUT      Write the generated post to this path instead.
 *   TODAYJOB_STATUS_FILE
 *                        Write a machine-readable run summary here. Used by the
 *                        workflow to notify the maintainer when the cookie fails.
 *
 * Safety: requests are serial, delayed, capped, and never retried on 2024,
 * 403, or 429. A rate-limit response stops the run instead of making it worse.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const TIME_ZONE = 'Asia/Shanghai';
const API_URL = 'https://fe-api.zhaopin.com/c/i/search/positions';
const ENV_FILE =
  process.env.TODAYJOB_ENV_FILE || path.join(ROOT, 'collect.env');

const TARGET_DATE = process.env.TODAYJOB_DATE?.trim() || shanghaiDate(new Date());
const COOKIE = process.env.ZHAOPIN_COOKIE?.trim() || '';
const OUTPUT_PATH =
  process.env.TODAYJOB_OUTPUT ||
  path.join(ROOT, 'content', 'post', TARGET_DATE, 'index.md');
const STATUS_PATH =
  process.env.TODAYJOB_STATUS_FILE ||
  path.join(ROOT, '.todayjob', 'last-run.json');
const REQUEST_TIMEOUT_MS = 20_000;

const DEFAULT_LIMITS = {
  maxCities: 3,
  maxJobs: 3,
  maxTargets: 9,
  maxKeywordsPerJob: 40,
  maxPagesFull: 4,
  maxPagesAnonymous: 5,
  maxRequestsPerRun: 180,
  requestDelayMs: 1000,
  requestJitterMs: 250,
  targetCooldownMs: 1500,
};


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

function normalizeLimits(raw = {}) {
  const bounds = {
    maxCities: [1, 5],
    maxJobs: [1, 5],
    maxTargets: [1, 10],
    maxKeywordsPerJob: [1, 50],
    maxPagesFull: [1, 6],
    maxPagesAnonymous: [1, 5],
    maxRequestsPerRun: [10, 300],
    requestDelayMs: [800, 10_000],
    requestJitterMs: [0, 2_000],
    targetCooldownMs: [0, 30_000],
  };
  const limits = {};
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = Number(raw?.[key] ?? DEFAULT_LIMITS[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(
        `${ENV_FILE}: limits.${key} must be between ${min} and ${max}`,
      );
    }
    limits[key] = Math.floor(value);
  }
  return limits;
}

function normalizeCities(raw, limits) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${ENV_FILE}: cities must be a non-empty array`);
  }

  const cities = raw
    .filter((city) => city && city.enabled !== false)
    .map((city) => {
      const name = String(city.name || '').trim();
      const code = String(city.code || '').trim();
      if (!name || !code) {
        throw new Error(`${ENV_FILE}: every city needs name and code`);
      }
      return { name, code };
    });

  if (cities.length === 0) {
    throw new Error(`${ENV_FILE}: at least one city must be enabled`);
  }
  if (cities.length > limits.maxCities) {
    throw new Error(
      `${ENV_FILE}: too many cities (${cities.length}); limit is ${limits.maxCities}`,
    );
  }

  const seenCodes = new Set();
  const seenNames = new Set();
  for (const city of cities) {
    if (seenCodes.has(city.code)) {
      throw new Error(`${ENV_FILE}: duplicate city code ${city.code}`);
    }
    if (seenNames.has(city.name)) {
      throw new Error(`${ENV_FILE}: duplicate city name ${city.name}`);
    }
    seenCodes.add(city.code);
    seenNames.add(city.name);
  }
  return cities;
}

function normalizeJobs(raw, limits) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${ENV_FILE}: jobs must be a non-empty array`);
  }

  const jobs = raw
    .filter((job) => job && job.enabled !== false)
    .map((job) => {
      const name = String(job.name || '').trim();
      const profile = String(job.profile || 'dev').trim();
      if (!name) {
        throw new Error(`${ENV_FILE}: every job needs a name`);
      }
      if (profile !== 'dev' && profile !== 'keyword') {
        throw new Error(
          `${ENV_FILE}: job "${name}" profile must be "dev" or "keyword"`,
        );
      }

      const keywords = uniqueStrings(
        (Array.isArray(job.keywords) ? job.keywords : [])
          .map((keyword) => String(keyword || '').trim())
          .filter(Boolean),
      );
      if (keywords.length === 0) {
        throw new Error(`${ENV_FILE}: job "${name}" needs keywords`);
      }
      if (keywords.length > limits.maxKeywordsPerJob) {
        throw new Error(
          `${ENV_FILE}: job "${name}" has ${keywords.length} keywords; limit is ${limits.maxKeywordsPerJob}`,
        );
      }

      const titleIncludes = uniqueStrings(
        (Array.isArray(job.titleIncludes) ? job.titleIncludes : [])
          .map((term) => String(term || '').trim())
          .filter(Boolean),
      );
      const exclude = uniqueStrings(
        (Array.isArray(job.exclude) ? job.exclude : [])
          .map((term) => String(term || '').trim())
          .filter(Boolean),
      );

      return { name, profile, keywords, titleIncludes, exclude };
    });

  if (jobs.length === 0) {
    throw new Error(`${ENV_FILE}: at least one job must be enabled`);
  }
  if (jobs.length > limits.maxJobs) {
    throw new Error(
      `${ENV_FILE}: too many jobs (${jobs.length}); limit is ${limits.maxJobs}`,
    );
  }

  const seenNames = new Set();
  for (const job of jobs) {
    if (seenNames.has(job.name)) {
      throw new Error(`${ENV_FILE}: duplicate job name ${job.name}`);
    }
    seenNames.add(job.name);
  }
  return jobs;
}

async function loadEnvFile(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }

  const vars = {};
  let pending = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!pending && /^\s*#/.test(line)) continue;
    if (!pending && !line.trim()) continue;

    if (line.endsWith('\\')) {
      pending += line.slice(0, -1);
      continue;
    }

    const full = pending + line;
    pending = '';
    const match = full.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) {
      throw new Error(`${file}: invalid line: ${full.slice(0, 80)}`);
    }

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[match[1]] = value;
  }

  if (pending) {
    throw new Error(`${file}: unfinished line continuation`);
  }
  return vars;
}

function envValue(fileVars, key) {
  const fromProcess = process.env[key];
  if (typeof fromProcess === 'string' && fromProcess.trim()) {
    return fromProcess.trim();
  }
  const fromFile = fileVars[key];
  return typeof fromFile === 'string' ? fromFile.trim() : '';
}

function splitEnvList(value, separator) {
  return String(value || '')
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCities(raw) {
  const text = String(raw || '').trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('must be a JSON array');
      return parsed;
    } catch (error) {
      throw new Error(`${ENV_FILE}: TODAYJOB_CITIES JSON: ${error.message}`);
    }
  }

  return splitEnvList(text, /[,，;；]/).map((item) => {
    const index = item.indexOf(':');
    if (index === -1) {
      throw new Error(
        `${ENV_FILE}: city "${item}" must use name:code, e.g. 厦门:682`,
      );
    }
    return {
      name: item.slice(0, index).trim(),
      code: item.slice(index + 1).trim(),
    };
  });
}

function parseJobs(raw) {
  const text = String(raw || '').trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('must be a JSON array');
      return parsed;
    } catch (error) {
      throw new Error(`${ENV_FILE}: TODAYJOB_JOBS JSON: ${error.message}`);
    }
  }

  return splitEnvList(text, /[;；]/).map((item) => {
    const fields = item.split(':');
    if (fields.length < 3 || fields.length > 5) {
      throw new Error(
        `${ENV_FILE}: job "${item}" must use name:profile:keywords[:titleIncludes[:exclude]]`,
      );
    }
    const [name, profile, keywords, titleIncludes = '', exclude = ''] = fields;
    return {
      name: name.trim(),
      profile: profile.trim() || 'dev',
      keywords: splitEnvList(keywords, /[|｜]/),
      titleIncludes: splitEnvList(titleIncludes, /[|｜]/),
      exclude: splitEnvList(exclude, /[|｜]/),
    };
  });
}

function parseLimits(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`${ENV_FILE}: TODAYJOB_LIMITS JSON: ${error.message}`);
  }
}

async function loadConfig() {
  const fileVars = await loadEnvFile(ENV_FILE);
  const citiesRaw = envValue(fileVars, 'TODAYJOB_CITIES');
  const jobsRaw = envValue(fileVars, 'TODAYJOB_JOBS');
  if (!citiesRaw) {
    throw new Error(`${ENV_FILE}: TODAYJOB_CITIES is empty`);
  }
  if (!jobsRaw) {
    throw new Error(`${ENV_FILE}: TODAYJOB_JOBS is empty`);
  }

  const limits = normalizeLimits(
    parseLimits(envValue(fileVars, 'TODAYJOB_LIMITS')),
  );
  const cities = normalizeCities(parseCities(citiesRaw), limits);
  const jobs = normalizeJobs(parseJobs(jobsRaw), limits);
  if (cities.length * jobs.length > limits.maxTargets) {
    throw new Error(
      `${ENV_FILE}: ${cities.length} cities × ${jobs.length} jobs exceeds maxTargets=${limits.maxTargets}`,
    );
  }
  return { cities, jobs, limits };
}

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

function cityNameKey(name) {
  return String(name || '').replace(/市$/, '').trim();
}

function isTargetCity(posting, city) {
  const name = cityNameKey(city.name);
  return (
    (name && posting.city.includes(name)) ||
    String(posting.cityId || '') === String(city.code)
  );
}

function matchesJobTitle(title, job) {
  if (!title) return false;

  const lower = title.toLowerCase();
  if (job.exclude.some((term) => lower.includes(term.toLowerCase()))) {
    return false;
  }

  if (job.profile === 'dev') {
    if (NON_DEV_EXCLUDE.some((re) => re.test(title))) return false;
    if (HARD_EXCLUDE.some((re) => re.test(title))) return false;
    if (STRONG_DEV.some((re) => re.test(title))) return true;
    if (!GENERIC_DEV.some((re) => re.test(title))) return false;
    return !DOMAIN_EXCLUDE.some((re) => re.test(title));
  }

  const terms = job.titleIncludes.length ? job.titleIncludes : job.keywords;
  return terms.some((term) => lower.includes(term.toLowerCase()));
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
      // Do not retry 403/429: retries can turn a short throttle into a ban.
      if (response.status === 403 || response.status === 429) {
        throw new RiskControlError(`Zhaopin rate-limited the request (HTTP ${response.status})`);
      }
      if (response.status === 401) {
        throw new AuthEmptyError('Zhaopin returned HTTP 401');
      }
      if (response.status >= 500) {
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
    if (apiCode === 401) {
      throw new AuthEmptyError('Zhaopin API code 401');
    }
    if (apiCode !== 200) {
      throw new Error(`API code ${apiCode}: ${json.message || json.msg || 'unknown error'}`);
    }
    return json;
  } catch (error) {
    if (error instanceof RiskControlError) throw error;
    if (error instanceof AuthEmptyError) throw error;
    if (attempt >= 3) throw error;
    const wait = 700 * 2 ** (attempt - 1);
    console.error(`[retry ${attempt}/3] ${error.message}; waiting ${wait}ms`);
    await sleep(wait);
    return requestJson(url, init, attempt + 1);
  }
}

function pageCap(mode, limits) {
  const override = Number(process.env.TODAYJOB_MAX_PAGES);
  if (Number.isFinite(override) && override > 0) {
    return Math.min(Math.floor(override), 6);
  }
  return mode === 'full' ? limits.maxPagesFull : limits.maxPagesAnonymous;
}

function createClient(limits) {
  const jar = cookieMap(COOKIE);
  const at = jar.get('at') || '';
  const rt = jar.get('rt') || '';
  const full = Boolean(at && rt);
  return {
    mode: full ? 'full' : 'anonymous',
    cookie: full ? COOKIE : '',
    at,
    rt,
    cookieStatus: full ? 'unverified' : (COOKIE ? 'invalid' : 'missing'),
    cookieFallbackReason: full
      ? ''
      : (COOKIE ? 'Cookie 缺少 at 或 rt' : '未配置 Cookie'),
    pageSize: full ? 90 : 20,
    maxPages: pageCap(full ? 'full' : 'anonymous', limits),
    checked: false,
    requests: 0,
  };
}

function asAnonymous(client, reason, limits) {
  if (client.mode === 'anonymous') return client;
  console.error(`[auth] ${reason}; falling back to anonymous mode`);
  client.mode = 'anonymous';
  client.cookie = '';
  client.at = '';
  client.rt = '';
  client.cookieStatus = 'expired';
  client.cookieFallbackReason = reason;
  client.pageSize = 20;
  client.maxPages = pageCap('anonymous', limits);
  client.checked = true;
  return client;
}

async function fetchPage(client, city, keyword, pageIndex) {
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
    S_SOU_WORK_CITY: city.code,
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
      throw new AuthEmptyError('登录会话返回空结果');
    }
    client.cookieStatus = 'valid';
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

function locationText(jobs, city) {
  const districts = uniqueStrings(jobs.map((job) => job.district));
  if (districts.length === 0) return city.name;
  return `${city.name} · ${districts.slice(0, 3).join('、')}${districts.length > 3 ? ' 等' : ''}`;
}

function aggregate(jobs, city) {
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
      location: locationText(sorted, city),
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

function companyTableLines(companies) {
  const lines = [
    '| 公司名称 | 今日职位发布数量 | 地点 | 岗位链接 | 发布时间 |',
    '| --- | ---: | --- | --- | --- |',
  ];
  for (const item of companies) {
    const linkTitle = mdCell(item.title).replace(/"/g, '\\"');
    const link = item.url
      ? `[查看岗位](${item.url} "${linkTitle}")`
      : '查看岗位';
    lines.push(
      `| ${mdCell(item.company)} | ${item.count} | ${mdCell(item.location)} | ${link} | ${mdCell(formatTime(item.publishTime))} |`,
    );
  }
  return lines;
}

function renderMarkdown({ targets, client, collectedAt, budgetExhausted, requestLimit }) {
  const [year, month, day] = TARGET_DATE.split('-');
  const cities = uniqueStrings(targets.map((target) => target.city.name));
  const jobs = uniqueStrings(targets.map((target) => target.job.name));
  const cityLabel = cities.join('、');
  const jobLabel = jobs.join('、');
  const single = targets.length === 1;

  const totalCompanies = targets.reduce(
    (sum, target) => sum + target.companies.length,
    0,
  );
  const totalJobs = targets.reduce((sum, target) => sum + target.jobs.length, 0);
  const totalKeywords = targets.reduce(
    (sum, target) => sum + target.keywords,
    0,
  );
  const totalKeywordsTotal = targets.reduce(
    (sum, target) => sum + target.keywordsTotal,
    0,
  );

  const title = single
    ? `${year}年${Number(month)}月${Number(day)}日 ${cityLabel}${jobLabel}岗位日报`
    : `${year}年${Number(month)}月${Number(day)}日 ${cityLabel} · ${jobLabel}岗位日报`;
  const description =
    totalJobs > 0
      ? `${TARGET_DATE}，${targets.length} 个城市/岗位组合共 ${totalCompanies} 家公司、${totalJobs} 个岗位。`
      : `${TARGET_DATE}，暂未采集到符合当前配置的岗位。`;

  const lines = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `slug: "${TARGET_DATE}"`,
    `date: ${shanghaiIso(collectedAt)}`,
    `description: "${description.replace(/"/g, '\\"')}"`,
    'categories:',
    '    - 智联招聘',
    'tags:',
    ...cities.map((city) => `    - ${JSON.stringify(city)}`),
    ...jobs.map((job) => `    - ${JSON.stringify(`${job}岗位`)}`),
    '    - "招聘日报"',
    'comments: true',
    '---',
    '',
    `> 统计日期：${TARGET_DATE}（北京时间 00:00–24:00）  `,
    `> 统计范围：${cityLabel} · ${jobLabel}  `,
    '> 数据来源：智联招聘公开职位接口  ',
    `> 采集时间：${shanghaiDateTime(collectedAt)}  `,
    `> 采集方式：${client.mode === 'full' ? '登录会话接口' : '匿名接口（单关键词最多 100 条）'}`,
    '',
  ];

  if (budgetExhausted) {
    lines.push(
      `> 注意：本次达到请求上限 ${requestLimit} 次，已处理 ${totalKeywords}/${totalKeywordsTotal} 个关键词，结果可能不完整。`,
      '',
    );
  }

  lines.push(
    '## 今日概览',
    '',
  );

  if (single) {
    const target = targets[0];
    lines.push(
      `- 公司：**${target.companies.length}** 家`,
      `- ${target.job.name}岗位：**${target.jobs.length}** 个`,
      `- 当日该城市去重岗位：**${target.allJobsOnDate}** 个（含其他岗位）`,
      `- 覆盖关键词：**${target.keywords}/${target.keywordsTotal}** 个`,
    );
  } else {
    lines.push(
      `- 目标组合：**${targets.length}** 个（${cityLabel} × ${jobLabel}）`,
      `- 公司（按组合合计）：**${totalCompanies}** 家`,
      `- 岗位（按组合合计）：**${totalJobs}** 个`,
      `- 覆盖关键词：**${totalKeywords}/${totalKeywordsTotal}** 个`,
    );
  }

  lines.push('', '<!--more-->', '');

  if (single) {
    const target = targets[0];
    lines.push('## 公司汇总', '');
    if (target.jobs.length === 0) {
      lines.push(
        '今天暂时没有采集到符合条件的岗位。',
        '',
        `可能是当天尚未发布新岗位，也可能是接口返回延迟。可以稍后重试，或直接在智联招聘搜索“${target.city.name} ${target.job.name}”。`,
      );
    } else {
      lines.push(...companyTableLines(target.companies));
    }
  } else {
    for (const target of targets) {
      lines.push(`## ${target.city.name} · ${target.job.name}`, '');
      lines.push(
        `- 公司：**${target.companies.length}** 家`,
        `- 岗位：**${target.jobs.length}** 个`,
        `- 当日该城市去重岗位：**${target.allJobsOnDate}** 个（含其他岗位）`,
        `- 覆盖关键词：**${target.keywords}/${target.keywordsTotal}** 个`,
        '',
      );
      if (target.jobs.length === 0) {
        lines.push('今天暂时没有采集到符合条件的岗位。', '');
      } else {
        lines.push(...companyTableLines(target.companies), '');
      }
    }
  }

  lines.push(
    '',
    '## 数据说明',
    '',
    '- 仅统计发布时间在统计日期内、符合当前配置城市与岗位的岗位，按公司名称聚合。',
    `- “今日职位发布数量”是该公司当天在目标城市发布的${jobLabel}岗位数；同一岗位跨关键词命中只计一次。`,
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

async function collectTarget({ city, job, client, limits, requestLimit }) {
  const jobs = new Map();
  const allJobsOnDate = new Set();
  let budgetExhausted = false;
  let totalHits = 0;
  let attemptedKeywords = 0;

  for (const keyword of job.keywords) {
    if (client.requests >= requestLimit) {
      budgetExhausted = true;
      break;
    }
    attemptedKeywords += 1;

    let stalePages = 0;
    let keywordHits = 0;

    for (let pageIndex = 1; pageIndex <= client.maxPages; pageIndex += 1) {
      if (client.requests >= requestLimit) {
        budgetExhausted = true;
        break;
      }

      let page;
      try {
        page = await fetchPage(client, city, keyword, pageIndex);
      } catch (error) {
        if (error instanceof AuthEmptyError && client.mode !== 'anonymous') {
          asAnonymous(client, error.message, limits);
          pageIndex -= 1;
          continue;
        }
        throw error;
      }

      if (page.list.length === 0) break;

      let newest = 0;
      for (const raw of page.list) {
        const posting = normalizeJob(raw);
        if (!posting) continue;
        const date = posting.publishedAt ? shanghaiDate(posting.publishedAt) : '';
        if (date === TARGET_DATE && isTargetCity(posting, city)) {
          allJobsOnDate.add(posting.id);
          if (matchesJobTitle(posting.title, job)) {
            const previous = jobs.get(posting.id);
            if (
              !previous ||
              (posting.publishedAt?.getTime() || 0) >
                (previous.publishedAt?.getTime() || 0)
            ) {
              jobs.set(posting.id, posting);
            }
            keywordHits += 1;
          }
        }
        const ts = posting.publishedAt?.getTime() || 0;
        if (ts > newest) newest = ts;
      }

      const targetDateStart = new Date(
        `${TARGET_DATE}T00:00:00+08:00`,
      ).getTime();
      const pageIsOld = newest > 0 && newest < targetDateStart;
      stalePages = pageIsOld ? stalePages + 1 : 0;

      if (page.isEndPage === 1) break;
      if (stalePages >= 2) break;

      if (client.requests % 10 === 0) {
        console.error(
          `[progress] requests=${client.requests} city=${city.name} job=${job.name} ` +
            `keyword=${keyword} page=${pageIndex} jobs=${jobs.size}`,
        );
      }

      await sleep(
        limits.requestDelayMs +
          Math.floor(Math.random() * (limits.requestJitterMs + 1)),
      );
    }

    totalHits += keywordHits;
    console.error(
      `[keyword] ${city.name}/${job.name}/${keyword}: +${keywordHits} (unique=${jobs.size})`,
    );

    if (budgetExhausted) break;
  }

  const postings = [...jobs.values()];
  return {
    city,
    job,
    jobs: postings,
    companies: aggregate(postings, city),
    allJobsOnDate: allJobsOnDate.size,
    keywords: attemptedKeywords,
    keywordsTotal: job.keywords.length,
    keywordHits: totalHits,
    budgetExhausted,
  };
}

async function collect() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(TARGET_DATE)) {
    throw new Error(`Invalid TODAYJOB_DATE: ${TARGET_DATE}`);
  }

  const config = await loadConfig();
  const client = createClient(config.limits);
  const envLimit = Number(process.env.TODAYJOB_MAX_REQUESTS);
  const requestLimit =
    Number.isFinite(envLimit) && envLimit >= 1
      ? Math.min(Math.floor(envLimit), 300)
      : config.limits.maxRequestsPerRun;

  const totalKeywords = config.jobs.reduce(
    (sum, job) => sum + job.keywords.length,
    0,
  );
  console.error(
    `[start] date=${TARGET_DATE} mode=${client.mode} ` +
      `cities=${config.cities.length} jobs=${config.jobs.length} keywords=${totalKeywords} ` +
      `pageSize=${client.pageSize} maxPages=${client.maxPages} ` +
      `delay=${config.limits.requestDelayMs}ms limit=${requestLimit}`,
  );

  const targets = [];
  let budgetExhausted = false;

  outer: for (const city of config.cities) {
    for (const job of config.jobs) {
      if (client.requests >= requestLimit) {
        budgetExhausted = true;
        break outer;
      }

      console.error(
        `[target] city=${city.name}(${city.code}) job=${job.name} keywords=${job.keywords.length}`,
      );
      const result = await collectTarget({
        city,
        job,
        client,
        limits: config.limits,
        requestLimit,
      });
      targets.push(result);

      if (result.budgetExhausted) {
        budgetExhausted = true;
        break outer;
      }

      await sleep(config.limits.targetCooldownMs);
    }
  }

  if (targets.length === 0) {
    throw new Error('No target was collected');
  }

  const collectedAt = new Date();
  const markdown = renderMarkdown({
    targets,
    client,
    collectedAt,
    budgetExhausted,
    requestLimit,
  });

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, markdown, 'utf8');

  const totalJobs = targets.reduce((sum, target) => sum + target.jobs.length, 0);
  const totalCompanies = targets.reduce(
    (sum, target) => sum + target.companies.length,
    0,
  );
  const summary = {
    date: TARGET_DATE,
    mode: client.mode,
    cookieStatus: client.cookieStatus,
    cookieFallbackReason: client.cookieFallbackReason,
    cookieConfigured: Boolean(COOKIE),
    requests: client.requests,
    requestLimit,
    budgetExhausted,
    targets: targets.map((target) => ({
      city: target.city.name,
      cityCode: target.city.code,
      job: target.job.name,
      keywords: target.keywords,
      keywordsTotal: target.keywordsTotal,
      allJobsOnDate: target.allJobsOnDate,
      jobs: target.jobs.length,
      companies: target.companies.length,
    })),
    totalJobs,
    totalCompanies,
    collectedAt: collectedAt.toISOString(),
    output: OUTPUT_PATH,
  };
  await mkdir(path.dirname(STATUS_PATH), { recursive: true });
  await writeFile(STATUS_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
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
