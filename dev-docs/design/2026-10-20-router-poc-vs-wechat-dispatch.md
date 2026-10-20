# Router POC 与微信调度系统冲突分析

> 日期：2026-10-20
> 分析对象：
> - A：《PRD：pi-agentic-workflow 智能 Workflow 路由 POC（V1）》
> - B：《微信智能 Workflow 调度系统》（wechat-dispatch，执行文档族 P0→P1→P2→PT）
> 前提：用户既定时序为 **B 先做、A 后做**（A 的 PRD §14 原以为微信在后，实际顺序对调）

## 1. 结论速览

**无根本性冲突，但按 A 的 PRD 原样实施会造成大面积重复建设与契约分裂。**
A 本质是"B 的路由子系统（Registry + 意图路由 + 参数提取 + 校验执行）的 CLI 前置验证"；
时序对调后，A 的"必须实现"清单约 70% 已被 B 的 P1 覆盖。正确做法是把 A 重定位为
**"复用 B 的路由层 + 新增 CLI 入口与评测框架"**，而不是按原 PRD 新建 `src/routing/`。

## 2. 能力重叠矩阵

| 能力 | A（Router POC） | B（wechat-dispatch P1） | 关系 |
|---|---|---|---|
| Workflow Registry | FR-01，固定 3 条（summarize/translate/article） | WR-001~004，含 riskLevel/权限/标签 | **A ⊂ B**（A 少 riskLevel、allowedUsers） |
| 意图分类 | FR-02：execute/clarify/none 三决策 | IR-001：chat/execute_workflow/clarify/task_control/unsupported 五类 | **A ⊂ B**（A 缺 chat 与 task_control） |
| 参数提取/缺参澄清 | FR-05 + missingInputs | IR-005/006 + CV-001~003（含 TTL/多轮） | **A ⊂ B** |
| 决策结构校验 | FR-04（服务端强校验） | IR-003/007（服务端强校验） | 语义相同，**字段命名不同**（见 §3.2） |
| 执行入口 | FR-07：`createWorkflowEngine()` 直调 | EX-001：`RunApplicationService.start()` | **入口冲突**（见 §3.1） |
| 安全负向 | R08/R12 等注入/越权用例 | B 组安全负向 + SC-001~004 | 语义相同，两套用例 |
| 评测样本 | ≥30 条 cases.jsonl | ≥40 条 routing-samples.json | 能力重复，**格式/位置两套** |
| 模型路由 | 明确不做（3.2） | MR 全组（Bifrost） | 无重叠 |
| 微信/多轮/审批 | 明确不做（3.2） | 核心范围 | 无重叠 |

## 3. 具体冲突点

### 3.1 执行入口违反 B 的硬约束（最需要处理）

A 的 FR-07 直接 `engine.start()`；B 总纲贯穿性硬约束 #1 规定"一切 Workflow 启动走
`RunApplicationService.start()/resume()`"（限额、checkpoint 记录、副作用确认都在该层）。
A 直调 engine 会绕过 B 已建立的应用服务层能力，形成第二执行入口。

### 3.2 契约字段分裂

| 概念 | A | B | 风险 |
|---|---|---|---|
| 意图字段 | `decision`（枚举 3 值） | `intent`（枚举 5 值） | 两套结构并存，上层（评测/审计）要写两套解析 |
| 参数 | `arguments` | `args` | 同上 |
| 缺参 | `missingInputs` | `missingFields` | 同上 |
| Registry 类型 | `WorkflowDefinition`（src/routing/） | `WorkflowRegistration`（src/dispatch/registry.ts） | **同名能力两个类型、两个目录** |

### 3.3 目录冲突

A 建议 `src/routing/{workflow-registry,llm-router,routing-service}.ts`；B 已规划
`src/dispatch/{registry,intent-router,dispatcher}.ts`。职责完全相同，两处实现。

### 3.4 安全策略差异（可共存，需参数化）

- A：默认 Dry-run，`--execute` 显式授权才执行。
- B：LK-03，`read-only` 自动执行；`write`/`external` 需确认。
- 不矛盾（CLI 谨慎、微信按风险分级），但共享 Dispatcher 时授权策略必须做成入口参数，不能各写一套。

### 3.5 CLI 约定小冲突

A 的 `--model` 为必填；本仓库 CLAUDE.md 已约定"模型一律不传 `--model`，走
`~/.pi/agent/settings.json` 默认模型"。A 实施时应改为可选。

### 3.6 评测口径

A 的 30 条与 B 的 40 条样例集高度同质（中文路由/缺参/注入/无匹配）。各自独立维护会导致
准确率口径不可比；合并为一套样本库（按入口打标签）更合理。

## 4. 时序对调带来的机会

B 先完成后，A 的真正增量只剩三块，恰好是 B 没做或弱做的：

1. **CLI 入口**（`route-cli.ts`：--text/--json/--execute/Dry-run 默认）——B 只有微信入口。
2. **评测框架**（evaluate.ts：冻结样本、逐条回放、准确率/耗时/Tokens 统计、报告生成）——
   B 只有 PT 阶段的手动/脚本化验收，没有可重复的量化评测工具。
3. **规模实验前置**（A §14 V2：候选 3→10→30→100 的准确率/延迟/成本曲线）——B 的
   IR-010 检索升级正好需要这条数据支撑决策（关键词 vs BM25 vs 向量）。

## 5. 建议（A 实施时执行，PRD 可按此修订）

| 编号 | 建议 |
|---|---|
| RC-1 | Registry 复用 `src/dispatch/registry.ts`，A 的 3 条 Workflow 作为注册表配置实例；删除 A 的独立 Registry 实现 |
| RC-2 | 意图路由复用 `src/dispatch/intent-router.ts`（五意图超集）；CLI 场景 chat 落固定回复、task_control 落"不支持"即可 |
| RC-3 | 统一契约字段：以 B 的 `intent/args/missingFields` 为准（B 先落地为既成事实），A 的 PRD 示例仅作历史参考 |
| RC-4 | 执行入口改走 `RunApplicationService.start()`，`--execute` 映射为授权标志位传入 Dispatcher（满足 3.4 的策略参数化） |
| RC-5 | 样本库合并：A 的 cases.jsonl 并入 B 的 `routing-samples.json` 格式（带入口标签 cli/wechat），共用一套评估脚本 |
| RC-6 | `--model` 改可选，缺省走 settings.json 默认模型 |
| RC-7 | `src/routing/` 目录不建；A 的新增代码只放 `dev-examples/router-poc/`（CLI+评测）与 `tests/unit/`（如需） |
| RC-8 | A 的 P0~P3 阶段相应压缩：P0（契约复用+Fake 单测回归）→P1（CLI+评测框架+30 样本）→P2（--execute E2E 3 条）→P3（规模实验报告） |

## 6. 引用

- 《PRD：pi-agentic-workflow 智能 Workflow 路由 POC（V1）》dev-docs/planning/
- 《微信智能 Workflow 调度系统 — 需求文档（V1.0）》§6/§7/§11.3
- wechat-dispatch 执行文档族：总纲（LK-01~07、贯穿性硬约束）+ P1（目录契约）
