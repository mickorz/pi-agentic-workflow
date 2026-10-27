# 微信审批「批准」死循环：actionId 无限轮换 + 过期 pending 陷阱（2026-10-27）

## 问题现象

用户在微信里对 github-research（diagram-design 仓库）连续回复「批准」「都批准」「批准 diagram-design」，Bot 始终无法推进，且每次失败后待审批 actionId 都在轮换：

```
pa-dcd016ce → pa-65bb8ca8 → pa-226dfe56 → pa-91691ae2（第 4 次被拒）
```

用户报告：「每次执行都卡住」。

## 排查过程

1. **audit.jsonl 时间线**（.pi-wechat/audit.jsonl）：
   - 11:06:44 一个 agent turn（`am.turn.completed`）同时创建 pa-ea5fbadb + pa-65bb8ca8（6ms 内两条）；
   - 每次轮换出的新 pending 的 args 里都带着 `approved:true` + `approvalActionId:<前一个 actionId>`；
   - 多数「批准」其实真实执行了 run（runs 存在），但 run 因旧版图片下载 bug 失败（另案已修），叠加新 pending 涌现，用户感知为「被拒」。
2. **唯一一次成功**：全会话只有 1 个待批项时，精确回复「批准」→ `approved:true` 提交成功。
3. **当前死锁现场**：pa-91691ae2 status=pending、expiresAt=14:39Z 已过期，但清扫器 `expirePending()`（src/agent-host/pending-action.ts）**全仓库无任何调用点**（仅测试引用）。

## 根因（三层叠加）

1. **LLM 伪授权轮换**：非精确「批准」（「都批准」「批准 diagram-design」）不匹配 `parseApprovalDecision` 的窄正则 → 掉进 LLM agent turn → LLM 幻觉地携带 `approved:true` + `approvalActionId` 重新 `executeWorkflow` → 这些**未在 argsSchema 声明的键**改变 argsDigest → task-control-facade 的同参去重（workflowId+argsDigest 相同复用 pending）失效 → 新建 pending（actionId 轮换）。恶性循环：用户越重试，LLM 越多地带着新 approvalActionId 重新提交。
2. **过期 pending 陷阱**：`pendingFor()` 只滤 `status==="pending"` 不滤 `expiresAt` → 过期死项永远占据列表第 1 位 → 用户后续每次「批准」都绑到死项 → claim 时 `claimSync` 检查过期 → 永远回「授权已过期」。**用户永久卡死**（不会自愈）。
3. **github-research 不在 --auto-approve 白名单** → 每次 LLM 重提交都要再走审批，放大轮换。

## 解决方案（commit 83548dd 后续修复，本次提交）

1. **`src/agent-host/task-control-facade.ts`**：`executeWorkflow` 在 digest 计算前剥除 argsSchema 未声明的键——LLM 伪授权参数改变不了 digest → 去重命中 → 不再新建 pending。注入发生在剥除之后，不受影响。
2. **`src/agent-host/pending-action.ts`**：`pendingFor()` 增加 `expiresAt > now` 过滤——死 pending 不再出现在待审批列表/审批卡/确定性通道，序号稳定。claim 处的过期兜底保留。
3. **`src/gateway/wechat-app.ts`**：`parseApprovalDecision(text, pendings)` 强化（覆盖面必须足够宽，否则又掉回 LLM）：
   - 都批准/全部批准/批准全部/两个都批准 → `approve_all` 逐项确认（带 seen 护栏防 validation_failed 不消费 pending 死循环）；
   - 批准 <名称片段>：按 workflowId/resolvedTarget/args JSON 子串消歧（点号等标点双侧归一）；唯一命中→该项；多命中→回清单要序号；0 命中且片段短(≤12字)→回清单，长片段→交回 Agent；
   - 批准第N项/第N个；
   - 护栏：>80 字符不劫持；「批准+长指令」不劫持；拒绝不猜意图。
4. **运营面**：`--auto-approve` 追加 github-research（用户明示「首先去掉审批」）；服务停止期间向 pending-actions.jsonl 追加 expired 记录清掉死项 pa-91691ae2（store 按 actionId 最新态加载）。

## 验证

- 新单测 tests/unit/approval-decision.test.ts（形态全覆盖）+ am-p0-tools 剥离回归 + am-p0-pending-flow 过期过滤回归：496 pass / 0 fail。
- 服务 stop → 清死 pending → start（全 flags + github-research）：healthy、live pending 空。

## 预防/注意事项

- **给确定性通道加形态时，先问「用户实际会怎么说」**：真机第一条用户消息就是「都批准」，窄正则直接把它送进了 LLM。LLM 是幻觉放大器，审批词一律确定性解析。
- **append-only 账本必须有消费侧过滤**：写侧的过期清扫器没人调用等于没有；消费侧（listFor/pendingFor）必须自带 `expiresAt` 判断。
- **服务端参数面 = argsSchema 声明面**：任何未声明键（尤其 LLM 编造的 approved/approvalActionId）必须在 digest/快照前剥除，否则去重与审批绑定全被绕过。
- 改 --auto-approve 等启动参数必须 `service stop` + `start`（restart 沿用旧 args）；改完 `grep -o '"--auto-approve","[^"]*"' .pi-wechat/ecosystem.config.cjs` 确认。
