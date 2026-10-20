# TodayJob

记录每天发布的目标城市、目标岗位。

- 每天北京时间 **16:30** 生成 GitHub Trending 日报（日榜 / 周榜 / 月榜），**17:00** 采集招聘岗位，**17:30** 统一部署。
- 博客基于 [Hugo](https://gohugo.io/) + [Stack](https://github.com/CaiJimmy/hugo-theme-stack) 主题。
- `main`：博客源码分支。
- `gh-page`：Hugo 构建产物，由 Vercel 自动部署。

## 本地预览

```bash
git clone --recursive git@github.com:auulb/todayJob.git
cd todayJob
hugo server
```

如果克隆时没有带上主题：

```bash
git submodule update --init --recursive
```

## 构建

```bash
hugo --gc --minify
```

构建产物位于 `public/`。

## 目录结构

```
content/post/          文章
content/page/          归档、搜索等独立页面
content/trending/      GitHub Trending 日报（每天一篇，含日榜 / 周榜 / 月榜）
config/_default/       Hugo 与 Stack 主题配置
collect.env            采集范围：城市集合、岗位集合、限速与请求上限
scripts/collect-github-trending.mjs GitHub Trending 日报采集 + 三榜渲染
themes/hugo-theme-stack Stack 主题（git submodule）
```

## 采集范围配置（collect.env）

城市集合和岗位集合放在仓库根目录的 [`collect.env`](collect.env)，使用环境变量格式，不包含任何密钥。

```env
# 城市集合：名称:智联城市编码，多个城市用逗号分隔
TODAYJOB_CITIES=厦门:682

# 岗位集合：名称:profile:关键词1|关键词2|...
TODAYJOB_JOBS=开发:dev:开发|Java|前端|后端|Python
```

- `TODAYJOB_CITIES`：城市集合。`name` 用于匹配职位城市和展示，`code` 是智联招聘城市编码（厦门是 `682`）。多个城市写成 `厦门:682,福州:591`。
- `TODAYJOB_JOBS`：岗位集合。每项格式是 `名称:profile:关键词1|关键词2|...`，多个岗位用分号分隔。
- `profile: "dev"`：使用内置的开发岗位过滤规则，适合“开发”这一组。
- `profile: "keyword"`：按关键词或 `titleIncludes` 做标题包含匹配，适合测试、产品等自定义岗位。

增加一个测试岗的示例（追加到 `TODAYJOB_JOBS`，用分号隔开）：

```env
TODAYJOB_JOBS=开发:dev:开发|Java|前端|后端|Python;测试:keyword:测试|自动化测试|测试开发:测试|QA|质量:销售|硬件|电子|医疗
```

自定义岗位完整格式是 `名称:profile:keywords:titleIncludes:exclude`，后两项可省略；`titleIncludes` 和 `exclude` 都是不区分大小写的包含匹配，多个词用 `|` 分隔。`collect.env` 支持行尾 `\` 续行和 `#` 注释。

需要更多控制时（例如临时停用某个城市/岗位），可以把 `TODAYJOB_CITIES` 或 `TODAYJOB_JOBS` 写成 JSON 数组，并设置 `"enabled": false`：

```env
TODAYJOB_CITIES=[{"name":"厦门","code":"682"},{"name":"福州","code":"591","enabled":false}]
```

### 限速与防封

默认值已经按保守策略设置，正常情况下不需要改。需要调整时，在 `collect.env` 中增加一行 `TODAYJOB_LIMITS`（JSON）：

```env
TODAYJOB_LIMITS={"maxCities":3,"maxJobs":3,"maxTargets":9,"maxKeywordsPerJob":40,"maxPagesFull":4,"maxPagesAnonymous":5,"maxRequestsPerRun":180,"requestDelayMs":1000,"requestJitterMs":250,"targetCooldownMs":1500}
```

- 请求串行，不并发；每次请求间隔 `1000ms` 加 `0–250ms` 随机抖动。
- 每个“城市 × 岗位”组合最多 4 页（登录态）/ 5 页（匿名），每个岗位最多 40 个关键词。
- 单次运行最多 180 次请求；达到上限会停止并生成带提示的部分日报。
- 城市最多 3 个、岗位最多 3 个、组合最多 9 个；超过会直接报错，不会静默放大请求量。
- 遇到风控码 `2024`、HTTP `403` 或 `429` 立即停止，不重试。
- 工作流设置了 `concurrency`，不会同时运行两次采集。

一次运行会生成一篇合并日报 `content/post/YYYY-MM-DD/index.md`，每个“城市 × 岗位”组合在文章里各占一节。修改 `collect.env` 并提交到 `main` 后，下一次 17:00 的任务就会按新范围采集；也可以在 Actions 里手动运行 **collect** 立即生效。

如果不想把集合提交到公开仓库，可以：

1. 本地把配置写到未跟踪的 `.env`，运行时设置 `TODAYJOB_ENV_FILE=.env`。
2. GitHub Actions 中使用 Secrets：`TODAYJOB_CITIES`、`TODAYJOB_JOBS`、`TODAYJOB_LIMITS`。这些 Secrets 会覆盖 `collect.env`，不需要修改仓库文件。

本地调试还可以用 `TODAYJOB_MAX_PAGES`、`TODAYJOB_MAX_REQUESTS` 覆盖分页和请求上限：

```bash
TODAYJOB_ENV_FILE=.env TODAYJOB_MAX_REQUESTS=20 TODAYJOB_OUTPUT=/tmp/preview.md node scripts/collect.mjs
```

## 自动更新

每天北京时间，GitHub Actions 按下面的顺序执行：

1. **16:30**：`.github/workflows/trending.yml` 抓取 GitHub Trending 的日榜、周榜、月榜，生成 `content/trending/YYYY-MM-DD/index.md`，提交到 `main`。
2. **17:00**：`.github/workflows/collect.yml` 读取 `collect.env`（或 Secrets 覆盖），调用智联招聘公开职位接口采集配置中的城市和岗位。
3. 按公司聚合后生成 `content/post/YYYY-MM-DD/index.md`，提交到 `main`。
4. **17:30**：`.github/workflows/deploy.yml` 构建 Hugo 站点，将 `public/` 推送到 `gh-page`；Vercel 监听 `gh-page` 自动完成线上部署。

采集和部署是分开的：采集提交不会触发部署，只有 17:30 的定时任务（或手动运行 **deploy**）才会发布线上版本。

### GitHub Trending 日报

日报列表：<https://todayjob.vercel.app/trending/>

独立的采集模块是 `scripts/collect-github-trending.mjs`。GitHub 没有公开的 Trending JSON API，模块直接抓取 `https://github.com/trending` 的 HTML 并解析。每次运行生成当天的一篇日报，日报内包含日榜、周榜、月榜三张表，每张表只展示四列：

| 仓库名 | Stars | 标签 | 时间 |
| --- | ---: | --- | --- |
| 仓库全名，点击跳转 GitHub | Star 总数 | 主语言（无语言时显示「未标注」） | 本次采集时间（北京时间） |

输出路径为 `content/trending/YYYY-MM-DD/index.md`。同一天重复运行会覆盖当天日报；之前日期的日报会保留，形成可翻阅的日报列表。

本地预览：

```bash
node scripts/collect-github-trending.mjs
# 指定语言 / 输出目录 / 输出文件
TODAYJOB_TRENDING_LANGUAGE=python node scripts/collect-github-trending.mjs
TODAYJOB_TRENDING_DIR=/tmp/trending node scripts/collect-github-trending.mjs
TODAYJOB_TRENDING_OUTPUT=/tmp/trending.md node scripts/collect-github-trending.mjs
```

可选环境变量：`TODAYJOB_TRENDING_LANGUAGE`（语言 slug，如 `python`、`rust`、`c++`、`c%23`）、`TODAYJOB_TRENDING_DIR`（默认 `content/trending`）、`TODAYJOB_TRENDING_OUTPUT`（调试时覆盖具体文件路径）。

### 评论系统

站点使用 [giscus](https://giscus.app/) 承载评论，评论存放在本仓库的 GitHub Discussions：

- 访客必须使用 GitHub 账号登录后才能留言，未登录只能阅读。
- 评论数据直接保存在本仓库的 Discussions，不经过额外的评论服务器。giscus GitHub App 只授权本仓库的 Discussions 读写权限。
- 站点本身不会发送邮件。仓库的 **Watch** 已设为 **Custom** 并关闭 **Discussions** 通知；如需调整，可在仓库首页重新选择通知范围。
- 评论管理：进入仓库 **Discussions**，找到对应页面路径的讨论，可回复、隐藏或删除。
- 每日岗位日报和公告页开启评论；GitHub Trending 日报保持关闭，避免每天自动生成新讨论。
- 配置位于 `config/_default/params.toml` 的 `[comments.giscus]`，当前使用 `General` 分类和 `pathname` 映射。

### 手动运行

在 GitHub Actions 页面选择 **collect** → **Run workflow**，可以手动采集；`date` 留空表示北京时间当天。修改 `collect.env` 后提交，下一次运行会自动使用新的城市和岗位集合。

GitHub Trending 日报可以在 **trending** → **Run workflow** 手动采集；需要立即发布时，再手动运行 **deploy**。

### 可选 Secret：`ZHAOPIN_COOKIE`

智联招聘接口在匿名状态下每个关键词最多返回 100 条（每页 20 条）；携带有效的浏览器 Cookie 时，每个关键词最多可返回 1000 条（每页 90 条）。

如需更完整的覆盖，在仓库 **Settings → Secrets and variables → Actions** 中添加 `ZHAOPIN_COOKIE`。推荐直接用 Cookie 小工具生成：

1. 打开 <https://todayjob.vercel.app/cookie/>。
2. 把「生成 Cookie」按钮拖到浏览器书签栏。
3. 登录智联招聘后，在 `www.zhaopin.com` 页面点击该书签；弹窗会读取并验证 Cookie。
4. 复制 Cookie，更新 `ZHAOPIN_COOKIE` Secret。

工具只在 `zhaopin.com` 页面读取 Cookie，不会上传；至少需要 `at`、`rt`、`x-zp-client-id`。未配置时脚本会自动回退到匿名模式，并在文章末尾注明覆盖范围有限。

脚本会串行请求、自动限速、按职位 ID 去重；遇到接口返回风控码 `2024` 会立即停止，不会重试。

### Cookie 过期邮件提醒

当 `ZHAOPIN_COOKIE` 已配置但接口返回空结果（通常是登录过期）时，`collect` 工作流会在采集完成后发送邮件提醒，并附上重新生成 Cookie 的链接。提醒最多每 3 天发送一次，避免重复打扰；Cookie 更新成功后自动停止。

在仓库 **Settings → Secrets and variables → Actions** 中添加：

| Secret | 说明 |
| --- | --- |
| `SMTP_USERNAME` | SMTP 账号，例如 QQ 邮箱地址 |
| `SMTP_PASSWORD` | SMTP 授权码（不是邮箱登录密码） |
| `ALERT_EMAIL_TO` | 收件邮箱；可选，默认使用 `SMTP_USERNAME` |

默认使用 `smtp.qq.com:465`（SSL）。如需其他服务商，可在 `collect.yml` 的提醒步骤中设置 `SMTP_HOST` / `SMTP_PORT`。

想单独测试邮件配置，可在 Actions 页面手动运行 **alert-test** 工作流，或本地执行：

```bash
SMTP_USERNAME=you@example.com \
SMTP_PASSWORD='your-smtp-auth-code' \
ALERT_EMAIL_TO=you@example.com \
python3 scripts/send-cookie-alert.py --test
```

### 可选 Secret：`TODAYJOB_PAT`

当前部署只由 `deploy` 工作流的每日 17:30 定时任务或手动运行触发，采集提交到 `main` 不会自动部署。`TODAYJOB_PAT` 是可选的：配置后，采集工作流推送 `main` 时也会以 PAT 身份推送；不配置时使用 `GITHUB_TOKEN`，不影响采集和 17:30 的统一部署。

## 部署

`gh-page` 分支保存构建后的静态文件，Vercel 监听该分支并自动部署。

- 每天北京时间 **17:30** 自动部署一次，把当天 16:30 的 GitHub Trending 日报和 17:00 的岗位日报一起发布。
- 采集工作流不再触发部署；如需立即上线，在 Actions 页面手动运行 **deploy**。
- `deploy` 会先等待正在运行的 **collect** / **trending** 任务结束（最多 20 分钟），再构建最新 `main`。

线上地址：<https://todayjob.vercel.app/>
