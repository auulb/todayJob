# todayJob

一个「在 GitHub Issue 里发评论就能让 AI 写代码」的自动化实验仓库。
仓库里没有任何应用代码，只有两套 GitHub Actions 工作流，用来对比不同的 AI 编码 agent：

| 触发评论 | 工作流 | Agent | 模型 |
| --- | --- | --- | --- |
| `/pi ...` | `.github/workflows/pi.yml` | [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) | `deepseek/deepseek-flash` |
| `/oc ...` 或 `/opencode ...` | `.github/workflows/opencode.yml` | OpenCode | `deepseek/deepseek-flash` |

## 怎么用

在 Issue（或 PR）里发表一条以指令前缀开头的评论，工作流就会在云端跑起来：

```
/pi 把 JSON 结果转成 Markdown 并更新 README
/oc 修复这个 bug
```

`/pi` 的执行流程（见 `pi.yml`）：

1. **解析指令**：`parse` 步骤用 Python 提取 `/pi` 后面的正文，拼成提示词写入 `/tmp/pi-prompt.md`。
2. **准备分支**：分支固定为 `pi/issue-<编号>`。已存在就继续在上面迭代，不存在就从默认分支新建。
3. **安装并使用 pi**：`npm install -g @earendil-works/pi-coding-agent@1`，然后
   `pi --print --no-session -na --model "$PI_MODEL" "<提示词>"` 以非交互方式运行。
4. **提交并开 PR**：有改动才 `git commit` + `git push`，然后 `gh pr create`；
   再次触发时会复用已有 PR，因此同一个 Issue 可以多轮迭代。
5. **回帖**：把「是否产生改动 / PR 链接 / pi 的输出日志 / Actions 运行链接」评论回 Issue。

## 触发安全规则

两个工作流都做了同样的防护，避免误触发和自我触发：

- 只有仓库所有者本人的评论能触发（`github.event.comment.user.login == github.repository_owner`）；
- 评论必须是**以指令前缀开头**（用 `startsWith` 而不是 `contains`，防止 agent 回复里出现工作流路径时造成死循环）；
- 忽略机器人评论，也忽略带 `/actions/runs/` 链接的评论（即工作流自己的回复）。

`pi.yml` 还设置了 `concurrency`（同一个 Issue 串行执行、不取消进行中的任务）和
`timeout-minutes: 45` 超时保护。

## 需要的 Secrets

| Secret | 用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 调用 DeepSeek 模型（两个工作流都需要） |
| `PI_GITHUB_TOKEN` | 可选，PAT；没有就回退到内置 `github.token` |
| `OPENCODE_PAT` | OpenCode 工作流使用的 GitHub token |

密钥只从环境变量读取，仓库里不保存任何凭据。

## 目录结构

```
.github/workflows/pi.yml        # pi agent 工作流
.github/workflows/opencode.yml  # OpenCode agent 工作流
README.md                       # 本文件
```

## 备注

- 当前 pi 版本：`1.3.0`（工作流锁定在 `@1` 大版本）。
- pi 以 `--print` 无会话模式运行，因此不会跨评论保留对话上下文；需要延续任务时，
  在同一个 Issue 里再发一条 `/pi ...`，它会在同一个 `pi/issue-<编号>` 分支上继续改。
