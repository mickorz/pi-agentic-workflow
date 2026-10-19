# pi-agentic-workflow

基于 [pi coding agent](https://pi.dev) 的动态工作流编排 CLI Runtime：把一个请求变成跨隔离子 agent 分发、按任务路由模型、确定性检查、AI 对抗审查、人工审批、可中断恢复的编排执行。

```bash
npm install && npm run build
node dist/cli/index.js run examples/smoke.js --model "provider/modelId"
```

## 核心能力（V1）

- **DSL 原语**：`agent`（独立子会话/超时/重试/用量）、`parallel`、`sequence`、`fallback`、`race`、`workflow`（子流程）、`check`/`fileExists`/`commandSuccess`（确定性门禁）、`verify`（AI 对抗审查）、`retry`、`checkpoint`（人工审批）、`phase`/`log`/`args`
- **工具权限**：`explore` 只读白名单（read/grep/find/ls）/ `general` 可写（read/bash/edit/write）——执行层强制，不靠提示词
- **失败语义**：可恢复失败自动重试；耗尽后阶段失败闸门终止，**绝不静默成功**；拒绝是硬停止
- **Journal/Resume**：append-only journal 确定性回放（脚本/args 哈希校验、副作用窗口人工确认、中断恢复不重复花 token）
- **同源事件**：`run.*`/`node.*`/`checkpoint.*` JSONL 事件流，sequence 连续可游标回放（CLI 展示与 V2 SSE 同源）
- **公共引擎 API**：`createWorkflowEngine()`——启停/订阅/审批/历史，不依赖 CLI（见 [docs/web-api-contract.md](docs/web-api-contract.md)）

## 快速开始

```bash
npm install && npm run build

# 校验脚本
node dist/cli/index.js validate examples/quality-gates.js

# 执行（复用 Pi 凭证发现 ~/.pi/agent/auth.json）
node dist/cli/index.js run examples/nested.js --model <spec> --json

# 人工审批流：非交互首跑 → 等待态 → 恢复批准
node dist/cli/index.js run examples/feature-development.js --cwd <project> --non-interactive
node dist/cli/index.js resume <runId>        # 交互 y/N

# 中断恢复
node dist/cli/index.js list                  # interrupted 补偿态
node dist/cli/index.js resume <runId> --yes
```

## 命令与退出码

`run` / `validate` / `list` / `status` / `resume` / `stop`。退出码：0 completed / 1 failed / 2 invalid / 3 waiting_checkpoint / 130 interrupted。详见 [docs/CLI.md](docs/CLI.md)。

## 文档

- [DSL 参考](docs/DSL.md) · [CLI 参考](docs/CLI.md) · [V2 Web 接入契约](docs/web-api-contract.md)
- [迁移映射](docs/migration/source-map.md) · [兼容清单](docs/migration/compatibility.md)
- 阶段报告：[P0](docs/progress/P0-report.md) · [P1](docs/progress/P1-report.md) · [P2](docs/progress/P2-report.md) · [P3](docs/progress/P3-report.md)

## 目录结构

```text
src/
  cli/          CLI 命令（run/validate/list/status/resume/stop）
  runtime/      宿主无关编排核心（VM/调度/组合控制流/闸门）
  agent/        AgentSessionRunner 注入缝
  adapters/pi/  Pi SDK 适配（模型解析/工具profile/会话/用量/schema校验）
  persistence/  manifest + journal（append-only）
  events/       同源事件（types/emitter/JSONL/游标）
  checkpoint/   人工审批通道抽象
  engine.ts     WorkflowEngine 公共 API（Web Ready）
examples/       smoke/parallel/sequence/quality-gates/nested/feature-development
```

## 开发

```bash
npm run typecheck && npm run build && npm test
PI_WORKFLOW_INTEGRATION=1 npm run test:integration   # 真实 SDK（需凭证）
PI_WORKFLOW_INTEGRATION=1 npm run test:e2e           # 真实闭环验收（需凭证）
```
