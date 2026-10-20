# Router POC 与微信调度系统冲突分析（V2 修订版）

> 日期：2026-10-20（V2 修订：融合外部审阅意见）
> 分析对象：
> - A：《PRD：pi-agentic-workflow 智能 Workflow 路由 POC（V1）》
> - B：微信调度系统 wechat-dispatch（PRD + 执行文档族 P0→P1→P2→PT）
> 既定时序：**B 先做完整、A 后做**；本文为 A 的 PRD 修订与 B 的 P1 契约补充提供依据

## 一、结论：确实存在冲突，需要调整开发方向

保留**微信调度系统作为主项目**，Router POC 改为它的**独立 CLI 测试与评测工具**，不开发第二套智能路由系统：

- **wechat-dispatch**：负责真正的智能调度能力——Registry、Intent Router、Dispatcher、模型选择、微信接入。
- **Router POC**：复用上述能力，负责 CLI 调试、批量测试、路由准确率评估、性能分析、大规模路由实验。

二者互补不互覆盖。最终架构：

```text
微信 Bot        ——正式业务入口
Router POC CLI  ——调试、评测、性能实验
        │
        ▼
Shared Workflow Routing（src/dispatch/：统一 IntentRouter + Registry + 参数校验）
        ▼
Workflow Dispatcher（身份、权限、风险策略、执行前校验）
        ▼
RunApplicationService（start / resume / checkpoint / cancel）
        ▼
Workflow Runtime + ModelRouter（执行 JS Workflow / 节点级智能选模）
```

微信与 CLI 共享 Registry、Router、Dispatcher、Runtime；测试系统可更换模型与提示词而不影响业务系统。

## 二、冲突严重程度

| 冲突点 | 程度 | 建议 |
|---|---|---|
| 两套 Workflow Registry | 高 | 合并，使用微信项目 Registry |
| 两套 Intent Router | 高 | 只保留一套五意图路由 |
| 两个 Workflow 执行入口 | 高 | 统一走 RunApplicationService |
| 两套路由结果数据结构 | 高 | 统一契约 |
| 两套测试样本 | 中 | 共享样本、统一评测口径 |
| CLI 与微信授权策略不同 | 中 | 入口策略与权限策略分离 |
| 模型路由与 Workflow 路由 | 无冲突 | 保持两个独立模块 |

## 三、仓库实际状态：现在调整成本最低

当前 `master`：`src/dispatch/`、`src/model-routing/`、`src/gateway/` 均**尚不存在**，
WX-P0/P1/P2 执行报告未产生，微信 P0/P1 标记"待执行"，Router POC 无实现代码。
即：目前只是**两套需求和执行计划的冲突**，没有需要重构的代码冲突——
在微信 P1 动工前锁定统一契约即可，避免重复开发。

## 四、三个隐藏设计问题（比"两入口复用"更关键）

### 4.1 路由决策与实际执行明确分离（plan / execute）

共享 Dispatcher 应提供两个逻辑操作：

```typescript
// 只分析，不产生 Workflow 副作用
const plan = await dispatcher.plan({ text: "帮我分析这个 GitHub 项目", context });

// 显式请求执行，重新检查身份与权限
const result = await dispatcher.execute(plan, { actor, authorization });
```

（建议接口，非现有实现。）

- Router POC 可只用 `plan()` 跑几百次分类测试，零执行副作用。
- **`plan()` 结果不能当永久执行授权**：`execute()` 前仍须重新确认注册表版本、目标脚本、参数与权限。
- 这同时是微信参数补齐多轮（CV）与 POC 批量评测共用的底座。

### 4.2 CLI 的 `--execute` 不能覆盖高风险审批

微信方案已定：`read-only` 授权用户自动执行；`write` / `external-side-effect` 必须显式确认。
旧 POC 的 `--execute` 只表示"用户愿意启动任务"，与"授予危险权限"不是一回事。

- `--execute` 定义为**启动请求**：即使传入，遇到需审批的 Workflow 仍必须走正式审批机制（P2 的 checkpoint 链路），不得跳过确认。
- 入口策略（CLI 谨慎 / 微信按风险分级）与权限策略（风险等级审批）分层，Dispatcher 以参数接收入口上下文。

### 4.3 Intent 不得与执行状态（Action/Status）混淆

微信五意图保留，但契约中明确：**Intent 是用户表达的请求类别；Action 是系统接下来的动作**。

```text
用户："帮我翻译一下。"
Intent = execute_workflow（请求类别）
Action = ask_clarification（参数不完整，系统发起追问）
```

否则"用户正在回答上次追问"（Intent=clarify 的应答）与"系统需要发起追问"（Action=ask_clarification）会混在同一枚举里。
此修正在**微信 P1 的契约定义阶段**完成，Router POC 不得另发明枚举。

## 五、测试方案合并（修正：微信并非缺乏自动化评测）

修正前版分析的一处误判：微信 P1-T9 已规划 ≥40 条标注样本 + 自动评估脚本（准确率 ≥90% 是 P1 验收硬条件），PT 阶段还要复测量化验收。**Router POC 不是重建评测，而是增强评测深度：**

| 测试能力 | 微信 P1/PT | Router POC 增量 |
|---|---|---|
| 40 条基础样本 | 已规划 | 直接复用 |
| 意图分类准确率 | 已规划 | 细化混淆矩阵 |
| 参数提取正确率 | 基础验收 | 增加逐字段统计 |
| Prompt A/B 测试 | 未明确要求 | **新增** |
| 多模型对比 | 未明确要求 | **新增** |
| Token/路由耗时对比 | 部分已规划 | 自动统计与报告 |
| 3→10→30→100 规模实验 | V1 外 | **新增** |
| 微信真机验收 | 已规划 | 不重复 |

统一样本库约定：

- 一套 `routing-samples.json`，字段含 `scenario`、`channel`（cli/wechat）、`expectedIntent`、`expectedWorkflowId`、`expectedArgs`。
- 评测器同时支持 Fake LLM 与真实 LLM。
- 统计口径区分"**模型调用失败**"与"**合法的 unsupported 决策**"，避免把路由错误误记为正确拒绝。

## 六、文档修订与实施建议

改两份既有文档，不新增独立开发方案：

| 文档 | 调整 |
|---|---|
| Router POC PRD | 重定义为《智能 Workflow 路由评测与 CLI 测试工具（V1）》：去掉独立 Registry、IntentRouter、执行入口；改为复用 `src/dispatch/` 共享能力 |
| 微信 P1 执行文档 | 补充共享路由服务约束：无副作用分析接口（plan）、执行授权边界（execute/`--execute` 语义）、可复用评测数据格式（§五） |

Router POC 重定位后的精简阶段：

| 阶段 | 内容 |
|---|---|
| P0 | 共享契约检查：确认微信 Router/Registry/Dispatcher 可被 CLI 无副作用调用（plan()） |
| P1 | CLI 路由评测：复用 40+ 样本，输出路由结果、逐字段准确率与性能报告 |
| P2 | 真实 Workflow 执行验收：CLI 走正式 Dispatcher，测三条典型 Workflow 的真实执行与审批边界 |
| P3 | 路由规模与算法实验：候选规模增长 + 关键词/BM25/Embedding/LLM 混合路由性能对比（为微信 IR-010 检索升级供数） |

注意：微信 P1 本身要求准确率 ≥90%，**不能等 Router POC 才首次验证路由质量**——微信 P1 先完成基础验收，Router POC 再深入评测。

### 最终顺序

1. **微信调度系统**（优先）：P0 → P1 → P2 → PT，完成正式能力与可靠性验证。
2. **Router POC**：基于共享路由能力，新增 CLI 调试、模型对比、准确率评测与规模实验，用数据持续优化第一步的路由效果。

一句话：**微信调度系统把功能做出来；Router POC 证明功能做得是否足够准确、稳定、快速，以及如何继续优化。** 未来微信、Web 或其他 IM 通道，都受益于同一套经过评测的路由能力。

## 引用

- 《PRD：pi-agentic-workflow 智能 Workflow 路由 POC（V1）》dev-docs/planning/
- 《微信智能 Workflow 调度系统 — 需求文档（V1.0）》§6/§7/§11.3
- wechat-dispatch 执行文档族（总纲 + P0~P3 + PT）
- 外部审阅意见（2026-10-20，已融合为本 V2 修订版主体结论）
