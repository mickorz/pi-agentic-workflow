# WX-P6 执行报告：微信审批「批准」死循环修复（去审批 + 根因三层修复）

- 日期：2026-10-27
- 状态：✅ 完成（代码 + 门禁 + 服务部署 + 真机待用户回归）
- 前置：GH-P2（github_kb 图片预算修复，83548dd）已合入；本次为审批链独立修复。

## 背景（用户报告）

微信里 github-research 审批卡死：多次「批准」「都批准」「批准 diagram-design」全部失败，actionId 无限轮换（pa-dcd016ce → pa-65bb8ca8 → pa-226dfe56 → pa-91691ae2，第 4 次被拒）。用户要求：**①去掉审批 ②查原因**。

## 根因（详见 dev-docs/experience/2026-10-27-wechat-approval-rotation-deadlock.md）

1. LLM 伪授权轮换：非精确「批准」掉进 LLM → 携带 approved/approvalActionId（未声明键）重新提交 → argsDigest 变 → 去重失效 → 无限新建 pending。
2. 过期 pending 陷阱：expirePending 无调用点 + pendingFor 不滤过期 → 死项永远占首位 → 「批准」永远回「授权已过期」。
3. github-research 不在 --auto-approve → 每次重提交都再审批，放大轮换。

## 交付清单

| 项 | 内容 |
|---|---|
| task-control-facade.ts | digest 前剥除 argsSchema 未声明键（掐断轮换源头） |
| pending-action.ts | pendingFor 过滤过期项（死项不再占位劫持） |
| wechat-app.ts | parseApprovalDecision 强化：都批准/approve_all（逐项确认+seen 护栏）、批准 名称片段 消歧（唯一命中直批；0/多命中回清单要序号）、批准第N项、>80 字与长指令不劫持；ambiguous 分支回清单 |
| 运营配置 | --auto-approve 追加 github-research；清死 pending pa-91691ae2（账本追加 expired 记录） |
| 测试 | tests/unit/approval-decision.test.ts 新增；am-p0-tools 加伪授权剥除回归；am-p0-pending-flow 加过期过滤回归；全套 496 pass / 0 fail |
| 文档 | 经验文档（见上）+ 本报告 + 执行进度.md |

## 验证记录

- 解析形态全量真机化用例（批准/序号/纯数字/都批准族/URL 名称/消歧/第N项/长文本护栏）全部符合预期（tsx 直跑验证）。
- npm run build 干净；npm test 496/496。
- 服务 stop → 清账本 → start（--auto-approve 含 github-research、--agent-limits 60,100,900000 等全 flags）：healthy（pid 87884，14:47:52Z 起），live pending 空，registry 24 条 sha f32b3df1。
- 真机回归：待用户重发 diagram-design 链接（预期：直接执行不再出审批卡）；多 pending 场景待自然复现验证 approve_all。

## 遗留问题

- expirePending() 清扫器仍无周期调用点（消费侧过滤已兜底；如后续做 pending 生命周期管理可补定时器）。
- 历史 audit 里 11:06:44 同 turn 双 pending 的 LLM prompt 来源未深挖（服务端剥键已免疫，无论 LLM 怎么编参数都不再轮换）。
