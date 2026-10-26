# AM 执行序列 — WX-PT 收口 → AM-P0（已评审锁定，待 6 点后启动）

> 日期：2026-10-21 · 状态：架构评审三轮闭环（V2.1 + 收口补丁 `9bb563a`），**文档冻结，待执行**
> 依据：AM-P0-执行计划 V2.1（`91f9df4` + `9bb563a`）

## 0. 当前状态快照

| 项 | 状态 |
|---|---|
| WX-P0/P1/P2 | ✅（P0 真机已补测，G0-2 全绿） |
| RP-P0~P3 | ✅（基线 97.6% 等） |
| WX-PT Part A | ✅ 11/11 |
| WX-PT Part D | ✅ D1~D4（含 bot-adapter 真机修复、审批直通修复） |
| **WX-PT Part B** | ⏳ 服务运行中（审批直通/序号/批量已修复），等 `批准 1 拒绝 2` 续跑 |
| **WX-PT Part C** | 未开始（依赖 B 完成） |
| 149 单测 | ✅ 全绿 |

## 1. 执行序列（严格顺序）

| 步 | 内容 | 出口条件 |
|---|---|---|
| S1 | **WX-PT Part B 真机 13 用例**（B01 卡片已过；续跑 B02~B13：批准/幂等/拒绝/进度/取消/歧义/列表/恢复/停止≠取消/并发/频率/重启不丢审批） | B01~B13 全符合预期（B09/B10/B13 允许时序重试一次） |
| S2 | **WX-PT Part C 状态抽验**（tasks/audit/outbox 链路 + 脱敏检查） | 审计链完整、无凭据明文 |
| S3 | **WX-PT 收口**：`WX-PT-执行报告.md` + 进度表更新 + 旧路由基线锁定（routing-samples 可重复评测） | 通过标准全绿 → V1 交付 + AM-P0 Gate-in 达成 |
| S4 | **AM-P0 T1 契约先行**：类型契约 + FakeAgentSession + PendingAction 纯状态机 + 单测（**不接微信、不启真实 Workflow**） | 状态机全转换路径单测绿；agent-host 不 import gateway |
| S5 | AM-P0 T2~T8 模块实现（按 T1 契约，每任务一 commit） | 各任务验收锚点绿 + 149+ 回归不破 |
| S6 | **AM-P0 T9 真机**：AM-1~AM-14 + legacy/agent 对照 + 四项观测指标 | 报告落盘（含非 exactly-once 表述约束） |

## 2. 执行期硬约束（评审锁定，不再议）

1. 启动不确定态 = **方案 B**：unknown 禁自动重试、人工核对；报告表述"不自动重复执行"，**不得称 exactly-once**。
2. 数据契约三阶段：RunLaunchAttempt → TaskBinding（不变）→ run-links。
3. Inbox 恢复：完整消息快照、从 Journal 恢复、不确定副作用禁重调 Agent。
4. 每用户单活动 Turn（排队），不用 followUp()。
5. **四项观测指标**（成功率/延迟/Token/人工干预 + 工具调用轨迹）决定 AM-P1/P2 投入。

## 3. 待办清单（todolist 同步）

- [ ] S1 WX-PT Part B（B02~B13）
- [ ] S2 WX-PT Part C 抽验
- [ ] S3 WX-PT 执行报告 + 基线锁定
- [ ] S4 AM-P0 T1 契约与 Fake
- [ ] S5 AM-P0 T2 AgentHost / T3 五工具 / T4 PendingAction / T5 启动关联 / T6 双层预算 / T7 WechatApp / T8 CLI
- [ ] S6 AM-P0 T9 测试与真机验收
