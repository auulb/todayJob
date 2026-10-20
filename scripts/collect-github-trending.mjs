#!/usr/bin/env node
/**
 * GitHub Trending 独立采集模块。
 *
 * GitHub 没有公开的 Trending JSON API，/trending 是服务端渲染的 HTML，
 * 因此这里直接抓取页面并解析 article.Box-row。每天生成一篇日报，日报内包含
 * 日榜、周榜、月榜三张表；每张表只保留仓库名（可点击）、Stars、标签和采集时间。
 *
 * 用法：
 *   node scripts/collect-github-trending.mjs
 *   TODAYJOB_TRENDING_OUTPUT=/tmp/trending.md node scripts/collect-github-trending.mjs
 *   TODAYJOB_TRENDING_LANGUAGE=python node scripts/collect-github-trending.mjs
 *
 * 可选环境变量：
 *   TODAYJOB_TRENDING_LANGUAGE 语言 slug，例如 python、rust、c++、c%23
 *   TODAYJOB_TRENDING_DIR      日报输出目录，默认 content/post
 *   TODAYJOB_TRENDING_OUTPUT   覆盖输出文件路径（调试用）
 *   TODAYJOB_TRENDING_STATUS_FILE
 *                              运行摘要 JSON 路径，默认 .todayjob/github-trending-last-run.json
 */

import dns from 'node:dns';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const TIME_ZONE = 'Asia/Shanghai';
const BASE = 'https://github.com';
const REQUEST_TIMEOUT_MS = 20_000;

// 部分 runner / 本机 IPv6 不可达，优先 IPv4，避免 fetch 卡在 IPv6 连接上。
dns.setDefaultResultOrder('ipv4first');

const PERIODS = [
  { since: 'daily', label: '日榜' },
  { since: 'weekly', label: '周榜' },
  { since: 'monthly', label: '月榜' },
];
const LANGUAGE = String(process.env.TODAYJOB_TRENDING_LANGUAGE || '').trim();
const TRENDING_DIR =
  process.env.TODAYJOB_TRENDING_DIR ||
  path.join(ROOT, 'content', 'post');
const OUTPUT_OVERRIDE = process.env.TODAYJOB_TRENDING_OUTPUT || '';
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

function shanghaiDate(date) {
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function shanghaiChineseDate(date) {
  const p = shanghaiParts(date);
  return `${p.year}年${Number(p.month)}月${Number(p.day)}日`;
}

function shanghaiDateTime(date) {
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function shanghaiIso(date) {
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
}

function trendingUrl(since) {
  const pathname = LANGUAGE ? `/trending/${LANGUAGE}` : '/trending';
  const url = new URL(BASE + pathname);
  url.searchParams.set('since', since);
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

function renderPage({ periods, collectedAt }) {
  const collectedText = shanghaiDateTime(collectedAt);
  const date = shanghaiDate(collectedAt);
  const chineseDate = shanghaiChineseDate(collectedAt);
  const iso = shanghaiIso(collectedAt);
  const total = periods.reduce((sum, period) => sum + period.items.length, 0);
  const sourceRoot = LANGUAGE
    ? `${BASE}/trending/${LANGUAGE}`
    : `${BASE}/trending`;

  const lines = [
    '---',
    `title: "${chineseDate} GitHub Trending 日报"`,
    `slug: "github-trending-${date}"`,
    `date: ${iso}`,
    `lastmod: ${iso}`,
    `description: "${date} GitHub Trending 日榜、周榜、月榜，共 ${total} 个仓库。"`,
    'categories:',
    '    - 趋势GitHub',
    'tags:',
    '    - GitHub Trending',
    'comments: false',
    '---',
    '',
    `> 采集时间：${collectedText}（北京时间）  `,
    `> 数据来源：[GitHub Trending](${sourceRoot})  `,
    `> 统计范围：${LANGUAGE || '全语言'} · 日榜 / 周榜 / 月榜`,
    '',
  ];

  for (const period of periods) {
    lines.push(
      `## ${period.label}`,
      '',
      `> 共 ${period.items.length} 个仓库 · [在 GitHub 查看${period.label}](${period.sourceUrl})`,
      '',
      '| 仓库名 | Stars | 标签 | 时间 |',
      '| --- | ---: | --- | --- |',
    );

    for (const item of period.items) {
      lines.push(
        `| [${mdCell(item.fullName)}](${item.url}) | ${formatStars(item.stars)} | ${mdCell(item.tag)} | ${collectedText} |`,
      );
    }

    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function collect() {
  const collectedAt = new Date();
  const periods = [];

  for (const period of PERIODS) {
    const sourceUrl = trendingUrl(period.since);
    console.error(`[start] ${period.label} url=${sourceUrl}`);

    const html = await fetchHtml(sourceUrl);
    const items = parseTrending(html);
    if (items.length === 0) {
      throw new Error(
        `No repository found on the ${period.since} Trending page. The page structure may have changed, or the filter returned no data.`,
      );
    }

    periods.push({ ...period, sourceUrl, items });
  }

  const date = shanghaiDate(collectedAt);
  const outputPath =
    OUTPUT_OVERRIDE ||
    path.join(TRENDING_DIR, `github-trending-${date}`, 'index.md');
  const markdown = renderPage({ periods, collectedAt });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, markdown, 'utf8');

  const summary = {
    language: LANGUAGE || null,
    collectedAt: collectedAt.toISOString(),
    collectedAtShanghai: shanghaiDateTime(collectedAt),
    date,
    output: outputPath,
    periods: Object.fromEntries(
      periods.map((period) => [
        period.since,
        {
          source: period.sourceUrl,
          items: period.items.length,
          missingStars: period.items.filter((item) => item.stars === null)
            .length,
        },
      ]),
    ),
  };

  await mkdir(path.dirname(STATUS_PATH), { recursive: true });
  await writeFile(STATUS_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collect().catch((error) => {
    console.error(`[fatal] ${error.stack || error.message}`);
    process.exit(1);
  });
}

export { parseTrending, renderPage, shanghaiDate, trendingUrl };
