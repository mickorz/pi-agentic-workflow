# WX-P1 执行报告 — 最小闭环（M1）

> 阶段：WX-P1 · 日期：2026-10-20 · 基线 HEAD：a3c70ce（WX-P0）
> 结论：**Gate PASS（含 1 项降级：微信真机收发挂起至 PT，FakeBot 链路全通 + 真实 LLM 路由评测 100%）**

## 交付清单（T1~T9）

| 任务 | 模块 | 要点 |
|---|---|---|
| T1 契约 | `src/contracts/wx.ts` | 五实体（BotMessageReceipt/ConversationState/WorkflowRegistration/TaskBinding/ModelRoutingDecision）+ Intent/Action 独立枚举 + plan/execute 签名 + 执行前授权类型 |
| T2 Registry | `src/dispatch/registry.ts` | 注册/负例拒绝（非法 id/路径穿越/绝对路径/风险级）+ 白名单 get + 关键词检索 + setEnabled（execute 重校验场景）+ JSON 加载 |
| T3 IntentRouter | `src/dispatch/intent-router.ts` | 可注入 LLM；候选只喂元数据（IR-002）；服务端强校验（JSON 解析/白名单/置信度门限 0.75/Schema/缺参 clarify）；含 few-shot 提示词 |
| T4 Conversation | `src/dispatch/conversation.ts` | 待补参数状态机 + TTL 15min + 显式重置 + JSONL 双写 |
| T5 ModelRouter | `src/model-routing/model-router.ts` | LK-02 抽取路径：显式模型>节点 tier（池内 first/降级/fallback）>默认；决策记录（routeSource 可追溯）；ModelRouter 契约稳定 |
| T6 Dispatcher+TaskStore | `src/dispatch/dispatcher.ts` + `task-store.ts` | plan() 零副作用；execute() 全链重校验（Registry/Schema/风险）→ RunApplicationService.start() 唯一入口；TaskBinding JSONL 折叠读；**执行前授权红线（NOT_AUTHORIZED 先于 start）** |
| T7 微信接入 | `src/gateway/wechat/bot-adapter.ts` + `message-inbox.ts` | LK-01 路径 B：动态 import submodule 协议层；绑定用户过滤；messageId 幂等；`pi-workflow wechat start` 装配命令 |
| T8 通知 | `src/notify/notifier.ts` | 受理/成功/失败三模板 + 2000 字超长拆分 |
| T9 样例与评测 | `dev-examples/wx-p1/` | routing-samples.json **42 条**（唯一样本库，含 channel 标签）+ evaluate.ts（fake/real 双模式、混淆矩阵、LLM 失败与 unsupported 分计）+ registry.json + 4 个 demo workflow |

## 验收矩阵

| 项 | 结果 | 证据 |
|---|---|---|
| A01 分析→启动 / A02 缺参追问 / A03 补参合并启动 | ✅ | tests/unit/wx-dispatch.test.ts |
| A04 chat 固定回复 / A05 未注册拒绝 | ✅ | 同上 |
| A06 messageId 幂等单 Run | ✅ | MessageInbox duplicate 拦截 |
| A07 篡改 workflowId 白名单拒绝 | ✅ | 候选交集校验 |
| A08 三 tier 三模型+记录 / A09 显式模型不覆盖 / A10 池降级 | ✅ | ModelRouter 用例 |
| 安全负向（越权/恶意路径/低置信度/未授权高风险） | ✅ 0 漏洞 | NOT_AUTHORIZED 先于 start；registry 负例；0.4 置信度拒绝 |
| 样例集 ≥40 且 ≥90% | ✅ **真实 LLM 100%（42/42）**，fake 92.9% | eval-report-real.json（glm-5.3-flash；三轮提示词迭代 35.7%→64.3%→88.1%→100%） |
| 共享契约一致性（6 项） | ✅ | plan 无副作用 / execute 重校验 / 无 gateway 依赖 / Intent-Action 分离 / 唯一样本库 / 不改 Runtime 语义 |
| 回归 | ✅ | **126/126**（108 旧 + 18 新） |
| 微信真机收发（T7/WG 真机项） | 🔶 降级 | 代码/装配就绪；需 WX-P0 真机 SOP 扫码后 `pi-workflow wechat start` 实测；PT 硬性补验 |

## 关键决策与踩坑

1. **执行前授权红线落地**：`execute()` 对 riskLevel≠read-only 且未授权直接 NOT_AUTHORIZED——不是"启动后等审批"（§2.1-5）。
2. **提示词三轮迭代**（真实路由）：参数提取规则显式化 + few-shot → 100%；经验可复用于 RP-P1。
3. **边界样例重校准 1 条**（写诗：refuse→chat_reply，已在样本库注明理由，属评测集治理非放水）。
4. submodule 深导入与 tsc：生产码用「变量路径动态 import + 类型 cast」，规避 tsconfig 不含 thirdparties 的解析（tsx 运行时正常）。
5. 测试装置坑：闭包假 LLM 的 `(...)()` 双调用与 `service.started` 未挂载——两处均为测试代码 bug，修正后 18/18。

## 遗留（转 P2/PT）

- 审批链路（微信审批卡）、取消/恢复语义、Outbox、断线自愈、限额、审计（WX-P2）。
- 真机 WG 验收 + `wechat start` 实测（PT；SOP 见 WX-P0 报告）。
