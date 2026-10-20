/**
 * 前程无忧（51job）采集器配置。
 *
 * 本模块只服务 51job，**不读取** 智联的 collect.env / TODAYJOB_* 变量，
 * 两套系统各自独立配置文件、各自独立上限，互不影响。
 *
 * 配置文件：collect-51job.env（可用 JOB51_ENV_FILE 覆盖）
 *   JOB51_CITIES=厦门,深圳,上海
 *   JOB51_JOBS=开发:dev:开发|Java|前端|后端|Python
 *   JOB51_LIMITS={"maxCities":3,...}
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const ENV_FILE =
  process.env.JOB51_ENV_FILE || path.join(process.cwd(), 'collect-51job.env');

export const DEFAULT_LIMITS = {
  maxCities: 5,
  maxJobs: 3,
  maxKeywordsPerJob: 10,
  maxPagesPerKeyword: 2,
  maxRequestsPerRun: 120,
  pageSize: 200,
  issueDate: '1',
  requestDelayMs: 3500,
  requestJitterMs: 500,
  cityCooldownMs: 4000,
  requestTimeoutMs: 35_000,
  retryDelayMs: 3000,
  maxRetries: 1,
  maxTransientFailures: 4,
  headless: true,
  channel: 'chrome',
};

const NUMERIC_BOUNDS = {
  maxCities: [1, 5],
  maxJobs: [1, 3],
  maxKeywordsPerJob: [1, 40],
  maxPagesPerKeyword: [1, 3],
  maxRequestsPerRun: [1, 200],
  pageSize: [1, 200],
  requestDelayMs: [1200, 15_000],
  requestJitterMs: [0, 5_000],
  cityCooldownMs: [0, 30_000],
  requestTimeoutMs: [15_000, 90_000],
  retryDelayMs: [1000, 30_000],
  maxRetries: [0, 3],
  maxTransientFailures: [1, 20],
};

export function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeLimits(raw = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, [min, max]] of Object.entries(NUMERIC_BOUNDS)) {
    const value = Math.floor(Number(raw?.[key] ?? DEFAULT_LIMITS[key]));
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${ENV_FILE}: limits.${key} 必须在 ${min}~${max} 之间`);
    }
    limits[key] = value;
  }
  // issueDate 只接受 1/2/3/4，其它值远端会静默返回 0 条。
  const issueDate = String(raw?.issueDate ?? DEFAULT_LIMITS.issueDate).trim();
  if (!['1', '2', '3', '4'].includes(issueDate)) {
    throw new Error(`${ENV_FILE}: limits.issueDate 只能是 1/2/3/4`);
  }
  limits.issueDate = issueDate;

  // headless / channel 允许用字符串关闭（本地调浏览器时用）
  if (raw?.headless !== undefined) {
    limits.headless = !['0', 'false', 'no', 'off'].includes(
      String(raw.headless).toLowerCase(),
    );
  }
  if (raw?.channel !== undefined) {
    limits.channel = String(raw.channel).trim() || DEFAULT_LIMITS.channel;
  }
  return limits;
}

/**
 * 城市：只写名字，51job 编码在运行时用 assets/job51/dd_city.json 解析。
 * 也兼容 `厦门:110300` 这种显式写法（写了就不再查表）。
 */
export function parseCities(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error(`${ENV_FILE}: JOB51_CITIES 不能为空`);
  return splitList(text, /[,，;；]/).map((item) => {
    const index = item.indexOf(':');
    if (index === -1) return { name: item.trim(), code: '' };
    return {
      name: item.slice(0, index).trim(),
      code: item.slice(index + 1).trim(),
    };
  });
}

export function normalizeCities(cities, limits) {
  if (cities.length === 0) throw new Error(`${ENV_FILE}: 至少要有一个城市`);
  if (cities.length > limits.maxCities) {
    throw new Error(`${ENV_FILE}: 城市过多（${cities.length}），上限 ${limits.maxCities}`);
  }
  const seen = new Set();
  for (const city of cities) {
    if (!city.name) throw new Error(`${ENV_FILE}: 城市名不能为空`);
    if (seen.has(city.name)) throw new Error(`${ENV_FILE}: 城市重复：${city.name}`);
    seen.add(city.name);
  }
  return cities;
}

export function parseJobs(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error(`${ENV_FILE}: JOB51_JOBS 不能为空`);
  return splitList(text, /[;；]/).map((item) => {
    const fields = item.split(':');
    if (fields.length < 3 || fields.length > 5) {
      throw new Error(
        `${ENV_FILE}: 岗位 "${item}" 需写成 name:profile:keywords[:titleIncludes[:exclude]]`,
      );
    }
    const [name, profile, keywords, titleIncludes = '', exclude = ''] = fields;
    return {
      name: name.trim(),
      profile: profile.trim() || 'dev',
      keywords: splitList(keywords, /[|｜]/),
      titleIncludes: splitList(titleIncludes, /[|｜]/),
      exclude: splitList(exclude, /[|｜]/),
    };
  });
}

export function normalizeJobs(jobs, limits) {
  if (jobs.length === 0) throw new Error(`${ENV_FILE}: 至少要有一个岗位`);
  if (jobs.length > limits.maxJobs) {
    throw new Error(`${ENV_FILE}: 岗位过多（${jobs.length}），上限 ${limits.maxJobs}`);
  }
  const seen = new Set();
  const out = [];
  for (const job of jobs) {
    if (!job.name) throw new Error(`${ENV_FILE}: 岗位名不能为空`);
    if (seen.has(job.name)) throw new Error(`${ENV_FILE}: 岗位重复：${job.name}`);
    if (!['dev', 'keyword'].includes(job.profile)) {
      throw new Error(`${ENV_FILE}: 岗位 "${job.name}" 的 profile 只能是 dev 或 keyword`);
    }
    const keywords = uniqueStrings(job.keywords);
    if (keywords.length === 0) {
      throw new Error(`${ENV_FILE}: 岗位 "${job.name}" 需要关键词`);
    }
    seen.add(job.name);
    out.push({ ...job, keywords });
  }
  return out;
}

export function parseLimits(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('必须是 JSON 对象');
    }
    return parsed;
  } catch (error) {
    throw new Error(`${ENV_FILE}: JOB51_LIMITS JSON 解析失败：${error.message}`);
  }
}

export async function loadEnvFile(file = ENV_FILE) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`无法读取 ${file}：${error.message}`);
  }

  const vars = {};
  let pending = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!pending && (/^\s*#/.test(line) || !line.trim())) continue;
    if (line.endsWith('\\')) {
      pending += line.slice(0, -1);
      continue;
    }
    const full = pending + line;
    pending = '';
    const match = full.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`${file}: 无法解析的行：${full.slice(0, 80)}`);
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[match[1]] = value;
  }
  if (pending) throw new Error(`${file}: 行尾续行符没有闭合`);
  return vars;
}

export function envValue(fileVars, key) {
  const fromProcess = process.env[key];
  if (typeof fromProcess === 'string' && fromProcess.trim()) return fromProcess.trim();
  const fromFile = fileVars[key];
  return typeof fromFile === 'string' ? fromFile.trim() : '';
}

export async function loadConfig() {
  const fileVars = await loadEnvFile();
  const limits = normalizeLimits(parseLimits(envValue(fileVars, 'JOB51_LIMITS')));
  const cities = normalizeCities(parseCities(envValue(fileVars, 'JOB51_CITIES')), limits);
  const jobs = normalizeJobs(parseJobs(envValue(fileVars, 'JOB51_JOBS')), limits);
  return { cities, jobs, limits };
}

function splitList(value, separator) {
  return String(value || '')
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}
