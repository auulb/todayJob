# TodayJob

记录厦门每天发布的开发岗位。

- 每天北京时间 **17:00** 自动采集、分析并发布当天的岗位汇总。
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
config/_default/       Hugo 与 Stack 主题配置
themes/hugo-theme-stack Stack 主题（git submodule）
```

## 自动更新

每天北京时间 **17:00**（UTC 09:00），GitHub Actions 会自动执行：

1. `.github/workflows/collect.yml` 调用智联招聘公开职位接口，采集厦门当天发布的开发岗位。
2. 按公司聚合后生成 `content/post/YYYY-MM-DD/index.md`，提交到 `main`。
3. `.github/workflows/deploy.yml` 构建 Hugo 站点，将 `public/` 推送到 `gh-page`。
4. Vercel 监听 `gh-page`，自动完成线上部署。

### 手动运行

在 GitHub Actions 页面选择 **collect** → **Run workflow**，可以手动采集；`date` 留空表示北京时间当天。

### 可选 Secret：`ZHAOPIN_COOKIE`

智联招聘接口在匿名状态下每个关键词最多返回 100 条（每页 20 条）；携带有效的浏览器 Cookie 时，每个关键词最多可返回 1000 条（每页 90 条）。

如需更完整的覆盖，在仓库 **Settings → Secrets and variables → Actions** 中添加 `ZHAOPIN_COOKIE`，值来自已打开 `zhaopin.com` 的浏览器 Cookie（至少包含 `at`、`rt`、`x-zp-client-id`）。未配置时脚本会自动回退到匿名模式，并在文章末尾注明覆盖范围有限。

脚本会串行请求、自动限速、按职位 ID 去重；遇到接口返回风控码 `2024` 会立即停止，不会重试。

### 可选 Secret：`TODAYJOB_PAT`

`GITHUB_TOKEN` 推送 `main` 时不会触发其他 `push` 工作流。没有 PAT 时，部署由 `collect` 完成后的 `workflow_run` 触发，仍然可以正常发布。配置 `TODAYJOB_PAT`（fine-grained PAT，至少包含 Contents: Read and write）后，推送还会额外触发 `deploy` 的 `push` 事件。

## 部署

`gh-page` 分支保存构建后的静态文件，Vercel 监听该分支并自动部署。

线上地址：<https://todayjob.vercel.app/>
