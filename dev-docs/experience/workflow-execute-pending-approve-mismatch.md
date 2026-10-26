# workflow-execute-pending-批准绑定错位

## 问题现象

微信 agent 模式下发起 write 级流程（如 article-insert-images-meta），用户回复「批准」后，
agent 仍报新的待批 actionId（例：pa-f43914bf）并提示「之前的批准没有绑定成功」，形成批准-重发的空转循环。

## 排查过程

1. 审计链路：确定性通道（wechat-app.ts `handleInboundAgent`）裸「批准」经 `parseApprovalDecision`
   解析后绑定 `pendings[0]`（该用户**最老**的一条 pending）——入口本身幂等、状态机（pending-action.ts）严格单调。
2. 反查 pending 生成侧：`TaskControlFacade.executeWorkflow` 高风险分支**每次调用无条件 `pending.create()`**。
3. 对照实际行为：LLM 在一个 Turn 内重试 `workflow_execute`、或用户"重新发起"同请求 → 同语义请求生成
   pa-1 / pa-2 / pa-3 多条 pending；用户批准了最老的一条，agent 话术引用的是最新一条 → 错位。

## 根因

生成侧缺同请求去重 + 消费侧（裸批准）按最老绑定，两者叠加导致「批准的项」与「引用的项」不是同一条。

## 解决方案

`executeWorkflow` 高风险分支：同 `userId + workflowId + argsDigest` 且状态 pending → 复用已有
actionId（不刷新 TTL，originMessageId 保留首次值）；不同 argsDigest 仍新建。
提交 70ef4a6（含回归测试：重复发起同 actionId / 不同参数新建）。

## 预防/注意事项

- 新增任何「生成待确认项」的入口时，先问一句：同请求重复到达是否幂等？去重键是什么？
- 用户侧恢复：重启 `wechat start` 后旧 pending 10 分钟 TTL 自然过期，重新发起一次即可正确绑定。
- 排查此类问题先看落盘文件 `.pi-wechat/pending-actions.jsonl`（jsonl 追加式，末条生效），比看话术快。
