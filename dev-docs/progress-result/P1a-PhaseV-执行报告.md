# P1a Phase V（验收收口）执行报告

- 阶段：P1a · Phase V — 全链路验收 + 文档双更新（方案 §6 V / §7）
- 日期：2026-10-24
- 状态：✅ 本地可自动化部分全部完成；真机项移交用户（见「遗留」）

## 交付清单

| 交付物 | 位置 | 说明 |
|---|---|---|
| 全链路 E2E | `tests/unit/obsidian-e2e.test.ts` | 3 用例覆盖 §7.1/§7.2/§7.3 场景（本地等价模拟，无真机微信依赖） |

## E2E 链路（与生产装配同构，仅 agent runner 用 fake）

TaskControlFacade.executeWorkflow（预检+operationId 派生+argsDigest）
→ PendingActionStore（审批卡三要素+内容摘要/预览）
→ PendingActionService.confirm（authorized:true 唯一执行入口）
→ LaunchCoordinator（预写 attempt）→ Dispatcher（registry/args/authorized 重校验+透传）
→ RunApplicationService → engine（manifest.options.authorized 持久化）
→ runWorkflow（meta.capabilities 门 → obsidianWrite 注入）
→ vault_writer.py（O_EXCL/O_APPEND + .obsidian-ops/ledger.jsonl 台账）

## 验收断言明细（对照方案 §7）

| § | 场景 | 断言 | 结果 |
|---|---|---|---|
| 7.1 | 微信保存灵感 | 预检（目标不存在通过）→审批卡（流程/目标/操作+digest8/预览≤80字）→批准→run completed→O_EXCL 创建→**文件逐字节一致**→播报含 rel | ✅ |
| 7.1 | 冲突检查 | create+目标已存在 → 预检直接报错不建审批项（Phase W 单测+E2E append 缺失分支同构断言） | ✅ |
| 7.2 | 微信搜笔记 | obsidian-note-search 直启 completed→total=1→items[0].path=刚创建 rel；Reader 层同后端二次断言 | ✅ |
| 7.3 | 幂等-审批级 | 同 actionId 重复 confirm → alreadyExecuted + 同 runId，零二次启动 | ✅ |
| 7.3 | 幂等-写面级 | 同 operationId 同内容重试 createNote → status=idempotent，文件零变化；台账 started/done 事件成对落盘 | ✅ |
| 7.3 | unknown | 伪造 started-无-done 台账 → appendNote 返回 code=unknown+「人工核对」提示，且**不写文件** | ✅ |
| 7.4 | 同步语义 | 本机断言：写入落在 vault 根（生产=坚果云 CloudStorage 目录，由云盘接管同步）；跨机读取断言需真机 | ⚠️ 半（见遗留） |
| 7.5 | 回归 | 全量 393 tests 392 pass 0 fail（1 平台 SKIP）；build 零错；P0 resolver 门禁 18 PASS+1 SKIP 不降级 | ✅ |

## 技术备注

- fake runner 注入缝：`createRunApplicationService({baseDir, runner})`（run-service.ts:68 测试注入口），播报 agent 返回结构化 `{message}`；其余全部真实组件。
- engine 落盘顺序：updateManifest(completed) 先于 writeResult，E2E 轮询条件为 `completed && result!=null`。
- 快照 result 为 WorkflowRunResult 信封 `{meta, result, logs…}`，断言取 `envelope.result`。

## 遗留（移交用户，非本阶段代码缺陷）

1. **真机微信通道**（§7.1/§7.2 实发消息）：需用户在微信侧实发「保存灵感/搜笔记」验证端到端体验；本地已验证同一装配链路。
2. **跨机云同步断言**（§7.4 另一机可读）：vault 位于坚果云同步目录，写入成功已断言；另一机读取需用户在第二台设备确认。
3. **Windows 侧门禁**（Phase 0 遗留）：Windows 机执行 P0 套件 + 信号语义 SKIP 项。

## P1a 收口

按方案 §10：P1a 完成后**暂停 Obsidian 基础设施开发**。后续（P1b+）另行立项。
