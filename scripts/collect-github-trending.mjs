#!/usr/bin/env node
/**
 * GitHub Trending 独立采集模块。
 *
 * GitHub 没有公开的 Trending JSON API，/trending 是服务端渲染的 HTML，
 * 因此这里直接抓取页面并解析 article.Box-row。输出是一张独立页面，只保留
 * 仓库名（可点击）、Stars、标签（主语言）和采集时间四列。
 *
 * 用法：
 *   node scripts/collect-github-trending.mjs
 *   TODAYJOB_TRENDING_OUTPUT=/tmp/trending.md node scripts/collect-github-trending.mjs
 *   TODAYJOB_TRENDING_SINCE=weekly node scripts/collect-github-trending.mjs
 *   TODAYJOB_TRENDING_LANGUAGE=python node scripts/collect-github-trending.mjs
 *
 * 可选环境变量：
 *   TODAYJOB_TRENDING_SINCE    daily（默认）/ weekly / monthly
 *   TODAYJOB_TRENDING_LANGUAGE 语言 slug，例如 python、rust、c++、c%23
 *   TODAYJOB_TRENDING_OUTPUT   页面输出路径，默认 content/page/github-trending/index.md
 *   TODAYJOB_TRENDING_STATUS_FILE
 *                              运行摘要 JSON 路径，默认 .todayjob/github-trending-last-run.json
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const TIME_ZONE = 'Asia/Shanghai';
const BASE = 'https://github.com';
const REQUEST_TIMEOUT_MS = 20_000;

const sinceRaw = String(process.env.TODAYJOB_TRENDING_SINCE || 'daily').toLowerCase();
const SINCE = ['daily', 'weekly', 'monthly'].includes(sinceRaw) ? sinceRaw : 'daily';
const LANGUAGE = String(process.env.TODAYJOB_TRENDING_LANGUAGE || '').trim();
const OUTPUT_PATH =
  process.env.TODAYJOB_TRENDING_OUTPUT ||
  path.join(ROOT, 'content', 'page', 'github-trending', 'index.md');
const STATUS_PATH =
  process.env.TODAYJOB_TRENDING_STATUS_FILE ||
  path.join(ROOT, '.todayjob', 'github-trending-last-run.json');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

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

function shanghaiDateTime(date) {
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function shanghaiIso(date) {
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
}

function trendingUrl() {
  const pathname = LANGUAGE ? `/trending/${LANGUAGE}` : '/trending';
  const url = new URL(BASE + pathname);
  url.searchParams.set('since', SINCE);
  return url.toString();
}

async function fetchHtml(url, attempt = 1) {
  let response;
  try {
    response = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch (error) {
    if (attempt >= 3) throw error;
    const wait = 1000 * 2 ** (attempt - 1);
    console.error(`[retry ${attempt}/3] ${error.message}; waiting ${wait}ms`);
    await sleep(wait);
    return fetchHtml(url, attempt + 1);
  }

  if (!response.ok) {
    // 429/5xx 做有限退避；403 直接失败，避免把短期限流升级成封禁。
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const wait = 1000 * 2 ** (attempt - 1);
      console.error(
        `[retry ${attempt}/3] HTTP ${response.status}; waiting ${wait}ms`,
      );
      await sleep(wait);
      return fetchHtml(url, attempt + 1);
    }
    throw new Error(`GitHub Trending returned HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    throw new Error(`Unexpected content-type: ${contentType || 'unknown'}`);
  }
  return response.text();
}

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'");
}

function stripTags(value) {
  return decodeEntities(String(value).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCount(value) {
  const text = stripTags(value).replace(/,/g, '');
  const match = text.match(/([\d.]+)\s*([kKmM])?/);
  if (!match) return null;
  let count = Number(match[1]);
  if (!Number.isFinite(count)) return null;
  const suffix = (match[2] || '').toLowerCase();
  if (suffix === 'k') count *= 1_000;
  if (suffix === 'm') count *= 1_000_000;
  return Math.round(count);
}

function firstMatch(html, regex) {
  const match = html.match(regex);
  return match ? match[1] : null;
}

/**
 * 解析 /trending 页面中的仓库榜。
 * 页面顺序就是 GitHub 的 Trending 排序；条数不固定，也没有分页。
 */
function parseTrending(html) {
  const items = [];
  const articleRe =
    /<article\b[^>]*class="[^"]*\bBox-row\b[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;

  for (const match of html.matchAll(articleRe)) {
    const block = match[1];

    const heading =
      firstMatch(
        block,
        /<h2\b[^>]*class="[^"]*\bh3\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/i,
      ) || firstMatch(block, /<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
    if (!heading) continue;

    const repoLink = heading.match(
      /<a\b[^>]*href="\/([^/"?#]+)\/([^/"?#]+)"/i,
    );
    if (!repoLink) continue;

    const owner = safeDecode(repoLink[1]).trim();
    const name = safeDecode(repoLink[2]).trim();
    if (!owner || !name) continue;

    const starsHtml = firstMatch(
      block,
      /<a\b[^>]*href="(?:https?:\/\/github\.com)?\/[^/"]+\/[^/"]+\/stargazers"[^>]*>([\s\S]*?)<\/a>/i,
    );
    const languageHtml = firstMatch(
      block,
      /<span\b[^>]*itemprop="programmingLanguage"[^>]*>([\s\S]*?)<\/span>/i,
    );

    items.push({
      owner,
      name,
      fullName: `${owner}/${name}`,
      url: `${BASE}/${owner}/${name}`,
      stars: parseCount(starsHtml || ''),
      tag: stripTags(languageHtml || '') || '未标注',
    });
  }

  return items;
}

function mdCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function formatStars(stars) {
  return stars === null || stars === undefined
    ? '—'
    : stars.toLocaleString('en-US');
}

function renderPage({ items, collectedAt, sourceUrl }) {
  const collectedText = shanghaiDateTime(collectedAt);
  const iso = shanghaiIso(collectedAt);
  const lines = [
    '---',
    'title: "GitHub Trending"',
    'slug: "github-trending"',
    `date: ${iso}`,
    `lastmod: ${iso}`,
    'description: "GitHub 每日 Trending 仓库榜：仓库名、Stars、标签与采集时间。"',
    'comments: false',
    '---',
    '',
    `> 采集时间：${collectedText}（北京时间） · 数据来源：[GitHub Trending](${sourceUrl})`,
    '',
    '| 仓库名 | Stars | 标签 | 时间 |',
    '| --- | ---: | --- | --- |',
  ];

  for (const item of items) {
    lines.push(
      `| [${mdCell(item.fullName)}](${item.url}) | ${formatStars(item.stars)} | ${mdCell(item.tag)} | ${collectedText} |`,
    );
  }

  lines.push('', '');
  return lines.join('\n');
}

async function collect() {
  const sourceUrl = trendingUrl();
  console.error(`[start] url=${sourceUrl}`);

  const html = await fetchHtml(sourceUrl);
  const items = parseTrending(html);
  if (items.length === 0) {
    throw new Error(
      'No repository found on the Trending page. The page structure may have changed, or the filter returned no data.',
    );
  }

  const collectedAt = new Date();
  const markdown = renderPage({ items, collectedAt, sourceUrl });

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, markdown, 'utf8');

  const summary = {
    source: sourceUrl,
    since: SINCE,
    language: LANGUAGE || null,
    collectedAt: collectedAt.toISOString(),
    collectedAtShanghai: shanghaiDateTime(collectedAt),
    items: items.length,
    missingStars: items.filter((item) => item.stars === null).length,
    output: OUTPUT_PATH,
  };

  await mkdir(path.dirname(STATUS_PATH), { recursive: true });
  await writeFile(STATUS_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

collect().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exit(1);
});
