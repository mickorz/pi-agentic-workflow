# RP-P0 执行报告 — 共享契约检查

> 阶段：RP-P0 · 日期：2026-10-20 · 基线 HEAD：ac1748b（WX-P2）
> 说明：按用户指示解除「排在微信 PT 之后」的串行门禁，RP 线与 WX-PT（真机手动验收挂起）并行开发；共享契约检查照常执行。
> 结论：**PASS —— CLI Dry-run 跑通，零 Run / 零 TaskBinding / 零通知产生**

## 交付

| 项 | 内容 |
|---|---|
| CLI 命令 | `pi-workflow route --text <s> [--registry <file>] [--model <spec>] [--channel cli\|wechat] [--json]`（`src/cli/commands/route.ts`，注册于 cli/index.ts） |
| 复用面 | WorkflowRegistry.loadFromFile + IntentRouter（同注册表/同提示词/同置信度门限），**未新建任何第二套 Registry/Router/执行入口** |
| 钩子 | IntentRouter 增 `promptBuilder` 可选依赖（A/B 评测注入缝，默认行为不变） |
| 异常处理 | 空输入 exit 2（INVALID_INPUT）；超长 >2000 拒绝；模型不可用/JSON 非法如实透传（unsupported + reason） |

## 验收证据（真实 LLM，默认模型）

```text
$ pi-workflow route --text "把 Hello world 翻译成中文" --registry dev-examples/wx-p1/registry.json
intent: execute_workflow / action: start_execution / workflowId: translate
args: {"text":"Hello world","targetLang":"中文"}  confidence: 0.95  latencyMs: 2960  tokens: 4067
$ 空输入 → exit 2；「你好呀今天天气怎么样」→ chat/chat_reply；「部署服务上线」→ plan 出 deploy-service（未执行）
$ ls .pi-workflows/runs → 0 条；.pi-wechat/ → 不存在
```

## 回归

146/146 单测绿（无新增 Run 依赖）；tsc/build 通过。
