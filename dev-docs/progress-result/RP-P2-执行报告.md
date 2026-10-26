# RP-P2 执行报告 — 真实执行验收

> 阶段：RP-P2 · 日期：2026-10-20 · 基线 HEAD：40882db（RP-P1）
> 结论：**PASS —— 三条典型 Workflow 真实执行 completed；高风险 --execute 无法绕审批（负向验证通过）**

## 交付

`route --execute [--scripts <dir>] [--data <dir>] [--user <id>] [--channel cli|wechat]`：

- plan → `Dispatcher.execute()`（重校验 Registry/Schema/风险）→ `RunApplicationService.start()` 唯一启动入口
- TaskBinding 入册（channel=cli，`.pi-wechat/tasks.jsonl`，与微信端同一存储语义）
- plan 非可执行态（追问/拒绝/闲聊/任务控制）→ 不启动、明确提示

## 安全边界（§3.3 执行前授权红线）

CLI 恒 `authorized=false`，**不提供任何授权绕过 flag**：

```text
$ pi-workflow route --text "部署服务上线" --registry dev-examples/wx-p1/registry.json \
    --scripts dev-examples/wx-p1 --execute
⛔ [NOT_AUTHORIZED] 流程 deploy-service 风险等级为 write，需要执行前显式授权（不允许先启动后确认）
（执行前授权需在微信端完成，CLI 不提供绕过手段）      exit=1
```

NOT_AUTHORIZED 在 `RunApplicationService.start()` **之前**抛出（Dispatcher 重校验 2），零 Run 产生（单测层另有 wx-dispatch 安全负向 0 漏洞覆盖）。

## 真实执行（三条典型 read-only）

| 文本 | 路由 | Run | 结果 |
|---|---|---|---|
| 分析 https://github.com/o/r | github-review / repoUrl 抽取 | run-mvgvk1pc-25wx | **completed** |
| 总结这个网页 https://example.com/a | summarize | run-mvgvj3zw-vgji | **completed** |
| 把 Hello world 翻译成中文 | translate / 参数抽取 | run-mvgvjanq-sgyu | **completed** |

TaskBinding 均入册（channel=cli）；`pi-workflow list` 可见三 run 终态。

## 顺带修复

demo 脚本 `meta.name` kebab-case 不合 snake_case 校验（github-review/approval-demo/long-demo → github_review/approval_demo/long_demo）——P1 遗留，真实执行才暴露。

## 回归

146/146 绿。
