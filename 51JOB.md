# 前程无忧（51job）日报 —— 独立模块

这个模块和智联日报**完全独立**：独立配置、独立脚本、独立定时任务、独立发文。
两边互不 import、互不读写对方的配置文件，任何一边挂掉都不影响另一边。

| | 智联招聘 | 前程无忧（51job） |
| --- | --- | --- |
| 配置文件 | `collect.env` | `collect-51job.env` |
| 采集脚本 | `scripts/collect.mjs` | `scripts/job51/collect.mjs` |
| 定时任务 | `.github/workflows/collect.yml`（17:00） | `.github/workflows/collect-51job.yml`（16:00） |
| 文章路径 | `content/post/<日期>/index.md` | `content/post/51job-<日期>/index.md` |
| 认证 | 需要 `ZHAOPIN_COOKIE` | 不需要任何 cookie / secret |
| 运行方式 | `fetch` 直连接口 | Playwright 驱动真 Chrome，页面内发 XHR |

## 为什么必须用浏览器

51job 的 `/api/job/search-pc` 挂在阿里云 WAF 后面，请求必须带页面内 WAF SDK
在 XHR 发出前注入的 `decode__1048` 参数。curl / node fetch / playwright 的
`page.request` 都会被拦成挑战页，只有「真浏览器页面里的 XMLHttpRequest」能过。

## 本地跑

```bash
npm install                      # 只有 playwright-core 一个依赖
npm run collect:51job            # 采集 + 生成文章
npm run spike:51job              # 诊断：确认 headless Chrome 是否还被放行
```

产出：

```
content/post/51job-<日期>/index.md      # 文章
.todayjob/job51-<日期>.json             # 中间结果（排查用）
.todayjob/job51-last-run.json           # 最近一次运行摘要
```

预览：`hugo server` 后打开 `http://localhost:1313/post/51job-<日期>/`。

## 配置

改 `collect-51job.env`：

```env
JOB51_CITIES=厦门,深圳,上海
JOB51_JOBS=开发:dev:开发|Java|前端|后端|Python|Golang|全栈|算法|测试|C++
# JOB51_LIMITS={"maxKeywordsPerJob":10,"maxRequestsPerRun":60}
```

城市只写名字，51job 编码由 `assets/job51/dd_city.json` 运行时解析
（智联用的是另一套编码，两边不通用，也不互相读取）。

## 限制与注意事项

- **一次运行 ≈ 30~40 次请求、3~5 分钟**。请求串行、间隔 ≥3.5s。
- **风控表现是「XHR 挂死」而不是弹验证码**：连续请求过多后请求不再返回任何事件，
  随后整个出口 IP 冷却若干分钟。采集器为此加了 Node 侧硬超时（35s）、
  挂死后 `page.reload()` 换会话参数、重试 1 次、连续 4 次瞬态失败即整体停止。
- `issueDate` 只支持 `1/2/3/4`，传 7、30 会**静默返回 0 条**；`1` 实际覆盖约 1~2 天，
  最终以 `issueDateString` 二次过滤到当天。
- 接口最多返回 1000 条，`pageSize` 上限 200。
- 0 条岗位时**不发文章**，避免首页出现空日报；运行摘要里会标 `post: ""`。
- GitHub Actions 的 runner 是机房 IP，WAF 判定可能比家宽更严；
  若长期被拦，改为本地定时跑采集、把 `content/post/51job-*` 提交到仓库。
