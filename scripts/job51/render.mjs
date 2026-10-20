/**
 * 前程无忧日报渲染：把采集结果渲染成一篇**独立的** Hugo 文章，
 * 与智联日报完全无关（不同目录 slug、不同标题、不同数据来源说明）。
 *
 *   content/post/51job-2026-10-21/index.md
 *
 * 纯函数，不碰网络、不读配置，方便用 fixture 单测。
 */

const TIME_ZONE = 'Asia/Shanghai';

const MONTH_DAY = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function postDir(date) {
  return `content/post/51job-${date}`;
}

export function postPath(date) {
  return `${postDir(date)}/index.md`;
}

export function renderPost(payload) {
  const { date } = payload;
  const parts = MONTH_DAY.format(new Date(`${date}T12:00:00+08:00`)).split('/');
  const [year, month, day] = parts.map((item) => String(Number(item)));

  const targets = (payload.targets || []).filter((target) => (target.postings || []).length > 0);
  const cities = [...new Set(targets.map((target) => target.city.name))];
  const jobs = [...new Set(targets.map((target) => target.job.name))];
  const postings = targets.flatMap((target) => target.postings);
  const companies = new Set(postings.map((posting) => posting.company));

  const cityLabel = cities.join(' · ');
  const jobLabel = jobs.join(' · ');
  const title = `${year}年${month}月${day}日 前程无忧 ${cityLabel} · ${jobLabel}岗位日报`;
  const description =
    `${date}，前程无忧 ${cityLabel} 的 ${jobLabel} 岗位，` +
    `共 ${companies.size} 家公司、${postings.length} 个岗位。`;

  const lines = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `slug: ${JSON.stringify(`51job-${date}`)}`,
    `date: ${new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')}`,
    `description: ${JSON.stringify(description)}`,
    'categories:',
    '    - 前程无忧',
    'tags:',
    '    - "前程无忧"',
    ...cities.map((city) => `    - ${JSON.stringify(city)}`),
    ...jobs.map((job) => `    - ${JSON.stringify(`${job}岗位`)}`),
    '    - "招聘日报"',
    'comments: true',
    '---',
    '',
    `> 统计日期：${date}（北京时间 00:00–24:00）  `,
    `> 统计范围：${cityLabel} · ${jobLabel}  `,
    '> 数据来源：前程无忧（51job）公开职位接口  ',
    `> 采集时间：${payload.generatedAt || ''}  `,
    '> 发布口径：发布日期落在统计日期当天的岗位  ',
    '',
    '## 今日概览',
    '',
    `- 公司：**${companies.size}** 家`,
    `- ${jobLabel}岗位：**${postings.length}** 个`,
  ];

  for (const target of targets) {
    lines.push(
      `- ${target.city.name} 当日全部岗位（含其他岗位，去重）：**${target.allJobsOnDate ?? 0}** 个`,
    );
  }
  if (payload.requests) {
    lines.push(`- 采集请求数：**${payload.requests}** 次`);
  }
  lines.push('');

  for (const target of targets) {
    lines.push(
      `## ${target.city.name} · ${target.job.name}`,
      '',
      `共 ${new Set(target.postings.map((p) => p.company)).size} 家公司、${target.postings.length} 个岗位。`,
      '',
      '| 公司 | 岗位 | 薪资 | 经验 | 学历 | 发布 |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const posting of target.postings) {
      lines.push(
        `| ${cell(posting.company)} | [${cell(posting.title)}](${posting.url}) | ` +
          `${cell(posting.salary) || '面议'} | ${cell(posting.workYear) || '-'} | ` +
          `${cell(posting.degree) || '-'} | ${cell(posting.publishTime) || '-'} |`,
      );
    }
    lines.push('');
  }

  lines.push(
    '## 数据说明',
    '',
    '- 岗位来自前程无忧公开搜索接口，仅统计**发布日期落在当天**的岗位，不代表企业全部在招职位。',
    '- 「当日全部岗位」是该城市在统计日期当天的去重岗位总数（含非开发类），用于观察市场整体热度。',
    '- 薪资为招聘方填写的原始区间；「面议」表示招聘方未填写具体数字。',
    '- 岗位链接指向前程无忧详情页，如已下线可能无法打开。',
    '- 本日报由脚本自动生成，与「智联招聘」日报是两篇独立文章，数据源互不影响。',
    '',
  );

  if (payload.wafBlocked) {
    lines.push(
      '> 注意：本次采集触发源站风控提前结束，结果可能不完整。',
      '',
    );
  }

  return `${lines.join('\n')}`;
}

function cell(value) {
  return String(value || '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}
