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

## 部署

`gh-page` 分支保存构建后的静态文件，Vercel 监听该分支并自动部署。
