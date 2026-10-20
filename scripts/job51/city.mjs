/**
 * 城市名 → 前程无忧（51job）城市编码。
 *
 * 51job 的城市编码（厦门 110300、深圳 040000、上海 020000）和智联的
 * （厦门 682、深圳 765、上海 538）完全是两套体系，不能混用。
 *
 * 为了不在 collect.env 里维护第二套码，这里按**城市名**自动解析：
 *   1. 优先读仓库内的 assets/job51/dd_city.json（公开 CDN 快照，约 70 KB）；
 *   2. 缺失时从 js.51jobcdn.com 拉取并缓存到 .todayjob/cache（该 CDN 无 WAF）；
 *   3. 都失败 → 抛错，让调用方明确失败，而不是静默跳过城市。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CDN_URL = 'https://js.51jobcdn.com/in/js/2023/dd/dd_city.json';

export function cityKey(name) {
  return String(name || '')
    .replace(/\s+/g, '')
    .replace(/(市|地区|特别行政区)$/, '')
    .trim();
}

function parseDict(json) {
  const groups = Array.isArray(json?.items) ? json.items : [];
  const byName = new Map();
  for (const group of groups) {
    for (const city of group?.items || []) {
      const code = String(city?.code || '').trim();
      const value = String(city?.value || '').trim();
      if (!/^\d{6}$/.test(code) || !value) continue;
      const key = cityKey(value);
      // 同名城市可能出现在多个分组（热门城市 / 按拼音分组），编码一致，保留首个。
      if (!byName.has(key)) {
        byName.set(key, {
          code,
          name: value,
          hasSubArea: Boolean(city.hasSubArea),
        });
      }
    }
  }
  return byName;
}

export async function loadCityDict({ root = process.cwd(), cacheDir } = {}) {
  const localPaths = [
    path.join(root, 'assets', 'job51', 'dd_city.json'),
  ];
  for (const file of localPaths) {
    try {
      return { source: file, cities: parseDict(JSON.parse(await readFile(file, 'utf8'))) };
    } catch {}
  }

  const cachePath = path.join(
    cacheDir || path.join(root, '.todayjob', 'cache'),
    'job51-dd_city.json',
  );
  try {
    return {
      source: cachePath,
      cities: parseDict(JSON.parse(await readFile(cachePath, 'utf8'))),
    };
  } catch {}

  const response = await fetch(CDN_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; todayJob/1.0)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`无法获取 51job 城市字典（HTTP ${response.status}）`);
  }
  const json = await response.json();
  const cities = parseDict(json);
  if (cities.size === 0) {
    throw new Error('51job 城市字典解析为空');
  }
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(json)}\n`, 'utf8');
  return { source: CDN_URL, cities };
}

/**
 * @returns {{code:string,name:string,hasSubArea:boolean}} 找不到时抛错（含可用城市提示）。
 */
export function resolveCity(cities, name) {
  const key = cityKey(name);
  const hit = cities.get(key);
  if (hit) return hit;
  const sample = [...cities.keys()].slice(0, 12).join('、');
  throw new Error(
    `51job 城市字典里找不到「${name}」。可用的前几个城市：${sample} …；` +
      '也可用 TODAYJOB_51JOB_CITIES 显式指定编码，例如 厦门:110300',
  );
}
