# image-use P1.6 接入与真实验收踩坑记录

> 日期：2026-10-27
> 关联：`dev-docs/progress-result/P1.6-执行报告.md`、`dev-docs/planning/2026-10-27-image-use-provider接入执行方案.md`

## 问题一：同一文件两个大小（339KB vs 346KB）

**现象**：上游 image-use 脚本，GitHub 页面看约 339KB，本地检出 346,697 字节，SHA256 对不上。

**排查**：本地克隆仓库 `core.autocrlf=true`——工作区检出为 CRLF（每行多 1 字节），git blob 是 LF。`git cat-file -s <blob>` 得 339,337B，工作区文件 346,697B，差值恰等于行数。

**根因**：行尾符检出策略差异，非内容差异。

**解决**：锁定来源时**同时登记两种形态哈希**（检出形态 + blob 形态），并注明 autocrlf 影响。校验脚本一致性用 `git diff` 而不是裸 SHA256 对比。

**预防**：vendoring/锁定第三方单文件时，先 `git config core.autocrlf` 看目标仓策略；跨机器同步后哈希对不上先查行尾符再查内容。

## 问题二：候选链提升不回写 prompt_hash（P1.5 遗留，重复计费级 bug）

**现象**：改 style_prefix 重新 preview（走候选链）后，batch 时该条目再次重新生成，多烧 1 张配额。

**排查**：manifest 中该条目 `prompt_hash` 与当前输入计算值不一致 → `reconcileEntry` 判 `inputChanged` → stale → 每次运行都重做。追溯写入点：`promoteEntry` 只更新 status/path/mime，不更新 prompt_hash；而候选链成功路径（runOne 的 isCandidate 分支）也未回写。

**根因**：候选链（stale→cand→promoted）语义上表示"该条目已按当前输入重生成"，但哈希字段停留在旧输入——状态与哈希脱节。主链路径无此问题（succeeded 时写当前 hash）。

**解决**：候选链成功提升后回写 `entry.prompt_hash = 当前输入哈希` 并落盘（generate.mjs，plan 构建时把 hash 存进 `step.__hash` 传入）。回归用例 IU-13：改风格重 preview 后二次 batch 零请求。

**预防**：双状态机里"表示输入已应用"的字段（哈希/指纹）必须在**每条**通往"已同步"状态的路径上写入；评审状态机时按路径逐条核对而不是只看主链。

## 问题三：制造 uncertain 演练时丢会话 URL

**现象**：故意调小超时制造"已提交未确认"后，需要从执行器 stderr 日志里拿 ChatGPT 会话 URL 走 recover——但管道 grep 过滤把 URL 行截掉了，进程已结束无法重看。

**根因**：真实场景中 uncertain 的恢复入口是"执行器 stderr 日志"，它是进程 stdout/stderr 的一部分，不落盘就没了。

**解决**：重做演练时 `> log 2>&1` 全量落盘。已写入验收指南。

**预防**：任何预期要看诊断输出的真实链路操作，一律先 tee/重定向落盘再 grep；对 unknown 恢复场景，日志文件就是资产。

## 问题四：Git Bash 找不到 chrome-use（PATH 时序）

**现象**：`which chrome-use` 失败，但 `image-use doctor` 在 cmd 下正常。

**根因**：chrome-use 安装器写的是注册表用户 PATH；已开着的终端（Git Bash 会话、pm2 长驻进程）继承的是启动时的 PATH 快照，不会热更新。

**解决**：新开终端即正常；长驻进程在 chrome-use 安装后重启一次。provider 无需特殊处理（spawn 继承父进程 PATH）。

**预防**：安装新 CLI 后"当前终端找不到命令"，先开新终端再排查别的。
