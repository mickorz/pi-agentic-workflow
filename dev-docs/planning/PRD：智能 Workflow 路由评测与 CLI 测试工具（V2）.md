# PRD：智能 Workflow 路由评测与 CLI 测试工具（V2）

**文档版本：** v2.0
**文档状态：** 需求评审稿（V1 原稿《pi-agentic-workflow 智能 Workflow 路由 POC（V1）》已按冲突分析 V2 重定位修订）
**目标项目：** https://github.com/mickorz/pi-agentic-workflow
**修订依据：** [冲突分析 V2（commit eac981d）](../design/2026-10-20-router-poc-vs-wechat-dispatch.md)

---

## 0. V1 → V2 修订说明

V1 原稿定位为"新建智能路由系统"；经与微信调度系统（wechat-dispatch）冲突分析，
V2 重定位为**微信调度系统的独立 CLI 测试与评测工具**。核心差异：

| 旧需求（V1） | 新需求（V2） |
|---|---|
| 新建 Workflow Registry | 复用 `src/dispatch/registry.ts` |
| 新建 LLM Intent Router | 复用微信项目 IntentRouter |
| 直接调用 WorkflowEngine | 通过共享 Dispatcher 的 `execute()`（内部仍是 RunApplicationService） |
| 自建 30 条测试样本 | 复用并扩展现有 40 条样本（routing-samples.json 唯一样本库） |
| 验证能否路由 | 重点评估路由质量与优化方案（混淆矩阵/逐字段/A-B/多模型/规模） |
| 未来才接入微信 | 微信系统先完成（P0→P1→P2→PT），本工具后接入复用其能力 |

**前置条件：微信调度系统 P1 Gate-out 通过**（共享契约 §2.1 已落地：plan/execute 分离、
Intent/Action 分离、dispatch 层无 gateway 依赖、统一评测样本格式）。本工具不单独启动开发，
排在微信 PT 之后。

## 1. 项目背景与定位

wechat-dispatch **规划实现**（当前 P1 标记为待执行，共享模块尚不存在，开发前必须完成微信 P0→P1 并通过 Gate-out）：Registry、五意图 IntentRouter、参数补齐、plan()/execute() 两段式 Dispatcher、ModelRouter、微信接入与可靠性闭环。但缺少：

1. **CLI 调试入口**——不依赖微信即可调试同一套路由逻辑。
2. **量化评测工具链**——混淆矩阵、逐字段参数准确率、Prompt A/B、多模型对比。
3. **规模实验数据**——候选 3→10→30→100 时路由准确率/延迟/成本曲线（为 IR-010 检索升级供数）。

本工具补齐以上三项，最终交付**可重复使用的路由评测工具链**，而非第二套路由系统。

```text
微信 Bot        ——正式业务入口
本工具 CLI      ——调试、评测、性能实验
        │
        ▼
Shared Workflow Routing（src/dispatch/：IntentRouter + Registry + 参数校验）
        ▼
Workflow Dispatcher（plan() 无副作用 / execute() 显式执行）
        ▼
RunApplicationService → Workflow Runtime + ModelRouter
```

## 2. 核心目标

`User Prompt →（复用）LLM Router →（复用）Workflow Registry → 路由计划 → 可选显式执行`

通过真实数据回答：

1. 现有路由的准确率/耗时/成本基线是多少？（混淆矩阵与逐字段统计）
2. 不同模型、不同 Prompt 的路由质量差异如何？（A/B 与多模型对比）
3. 候选规模扩大后何时需要升级检索（关键词 → BM25 → Embedding）？（规模实验）
4. CLI 与微信两个入口的路由行为是否一致？（同一样本跨 channel 对比）

## 3. V2 功能范围

### 3.1 必须实现（全部为复用 + 新增工具层）

- 复用 `src/dispatch/registry.ts`（注册表实例由配置加载，本工具不新建 Registry）。
- 复用 `src/dispatch/intent-router.ts` 与 `dispatcher.plan()`（Dry-run 零执行副作用）。
- CLI 入口：`--text`（必填）、`--json`、`--model`（**可选**，缺省走 `~/.pi/agent/settings.json` 默认模型）、`--execute`。
- 评测器：routing-samples.json 全量回放、准确率/混淆矩阵/逐字段统计、Fake 与真实 LLM 双模式、
  区分"模型调用失败"与"合法 unsupported 决策"。
- Prompt A/B 与多模型对比：可切换提示词变体与模型，输出对比报告。
- 显式执行验收：`--execute` 走 `dispatcher.execute()`，验证真实执行与审批边界。
- 规模实验：候选集 3→10→30→100 的准确率/延迟/成本曲线报告。

### 3.2 明确不做

- 不新建 Registry、IntentRouter、Dispatcher、执行入口（无第二套）。
- 不实现微信/多轮会话/审批 UI（微信项目已覆盖，本工具只验证其行为）。
- 不修改 Journal/Resume/Runtime 既有语义。
- 不做 Web UI、Embedding 检索实现（规模实验只产数据与升级建议）。

### 3.3 安全语义（继承共享契约）

- **Dry-run 默认**：CLI 默认只调 `plan()`，不启动 Workflow、不创建 Run。
- **`--execute` 是启动请求，不是危险权限**：遇 `write` / `external-side-effect` 风险等级的
  Workflow，仍必须走微信项目正式审批机制，本工具不提供任何绕过手段。
  其中：**执行前授权在 `RunApplicationService.start()` 之前完成**——高风险 Workflow 不允许先启动再确认；
  Workflow 内 Checkpoint 属于运行中阶段审批，不能代替启动授权。
- `plan()` 结果不得缓存为执行授权；`execute()` 每次重新校验 Registry/参数/身份/权限。

## 4. CLI 需求

```bash
# Dry-run（默认）：输出 intent/action/workflowId/args/missingFields/reason/路由耗时
npx tsx dev-examples/router-poc/route-cli.ts --text "把 Hello world 翻译成中文"

# 显式执行（走正式 Dispatcher.execute()，含审批边界）
npx tsx dev-examples/router-poc/route-cli.ts --text "..." --execute

# 批量评测
npx tsx dev-examples/router-poc/evaluate.ts --samples routing-samples.json --report report.json
```

异常处理沿用 V1 要求：空输入报错、超长拒绝、模型不可用如实报告、JSON 不合法不得继续、
执行失败保留 Runtime 真实错误。

## 5. 测试与评测（复用 + 增强）

| 测试能力 | 来源 |
|---|---|
| 40 条基础样本与准确率验收（≥90%） | 微信 P1 已有，本工具复用同一套（routing-samples.json） |
| 意图混淆矩阵、参数逐字段准确率 | 本工具新增 |
| Prompt A/B、多模型对比 | 本工具新增 |
| Token/路由耗时自动统计与报告 | 本工具新增 |
| 候选规模 3→100 实验 | 本工具新增 |
| 微信真机验收 | 微信 PT 已有，不重复 |

样本格式遵循微信 P1 §2.1-4：`scenario/channel/expectedIntent/expectedAction/expectedWorkflowId/expectedArgs`；
本工具扩展样本时打 `channel: cli` 标签，样本库仍唯一。

## 6. 分阶段交付（精简版）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 共享契约检查 | 确认微信 Router/Registry/Dispatcher 可被 CLI 无副作用调用（plan()） | CLI Dry-run 跑通；无任何 Run 产生 |
| P1 CLI 路由评测 | 复用 40+ 样本回放，输出路由结果、逐字段准确率与性能报告 | 基线报告落盘（含混淆矩阵） |
| P2 真实执行验收 | CLI `--execute` 走正式 Dispatcher，测三条典型 Workflow 真实执行与审批边界 | 高风险 Workflow 无法被 `--execute` 跳过审批 |
| P3 规模与算法实验 | 候选规模增长 + 关键词/BM25/Embedding/LLM 混合路由对比 | 实验报告含升级建议（供 IR-010 决策） |

## 7. 完成标准

- [ ] 未新建任何第二套 Registry/IntentRouter/Dispatcher/执行入口。
- [ ] CLI Dry-run 零执行副作用（不产生 Run/TaskBinding/通知）。
- [ ] `--execute` 不绕过高风险审批（负向验证通过）。
- [ ] 与微信项目共用同一套 Intent/Action/参数/错误契约与样本库。
- [ ] 基线评测报告（混淆矩阵/逐字段/耗时/成本）与 A/B、多模型对比报告落盘。
- [ ] 规模实验报告含明确的检索升级建议。
- [ ] 现有 Runtime/主项目测试全部通过（零回归）。

## 8. 风险与约束

| 风险 | 处理 |
|---|---|
| 共享契约尚未落地（微信 P1 未完成） | 本工具排在 PT 之后，前置检查（P0）兜底 |
| 大规模评测成本 | Fake LLM 模式先行；真实模型按需分批 |
| 样本过拟合 Prompt | A/B 变体与多模型交叉验证；冻结样本集 |
| 与微信行为漂移 | 同一样本库跨 channel 对比纳入常规评测 |

---

**定位一句话：微信调度系统把功能做出来；本工具证明功能做得是否足够准确、稳定、快速，以及如何继续优化。**
