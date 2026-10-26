# 同进程 cancel 后 resume 立即变 cancelled（V2 服务场景）

> 日期：2026-10-20 · 关联：`src/engine.ts` · 发现于 V2 手动测试补充用例（v2-extra-cases.ts）

## 问题现象

V2 应用服务（长驻进程）中：`cancel(runId)` 后把 manifest 置为 interrupted（模拟进程崩溃），
再 `resume(runId, { acknowledgeSideEffects: true })` —— resume 被调用后 run 状态
瞬间变为 `cancelled`，journal 不再增长，永远到不了 completed。

V1 CLI 的同场景（强杀后 resume 回放）行为正常。

## 排查过程

1. 起初怀疑 `RESUME_MISMATCH` 的 resume 副作用把 manifest 改回 running（先改状态后校验），
   通读 `engine.resume`：哈希校验在 `updateManifest(running)` **之前**，排除。
2. 又怀疑 cancel 的异步落盘竞态：cancel → abort → result.catch 写 cancelled，waitFor 通过
   后无迟到写入，排除（诊断脚本观察 cancel+2s / interrupted+2s 均稳定）。
3. 加轨迹等待（每 0.5s 打印 status+journalEntries）复现：`running journal=1 → cancelled journal=1`，
   确认新执行一启动就被 abort。
4. 定位 `engine.ts` 的 `attach(runId)`：活跃表按 runId 缓存 `ActiveRun`（controller/buffer/waiters/done），
   **run 结束后不删除**（注释：避免 GC 后 cancel 失效）。resume 复用旧 state → 新执行拿到的
   `controller.signal` 已 aborted → runWorkflow 立即抛 WORKFLOW_ABORTED → manifest=cancelled。

## 根因

`attach()` 无条件复用旧执行态；V1 CLI resume 是**新进程**（active 表为空）所以从不触发，
只有 V2 长驻服务同进程 cancel→resume 才踩中。

## 解决方案

`engine.resume` 在重建执行前 `active.delete(runId)` 丢弃旧执行态（controller/缓冲/waiters 全部
重挂）。三行修复，回归 108 单元测试 + demo 7 步 + extra 8 断言全过。

## 预防/注意事项

- 按 runId 缓存可复用资源的模式，"复用"与"状态残留"是一体两面：凡是"重新执行同一 id"的入口
  （resume/retry），先审计缓存态是否携带一次性语义（aborted、done、已消费的缓冲）。
- 测试中断场景时注意前置条件：cancel 发生在首个节点提交前 → journal=0 条 →
  `SIDE_EFFECTS_UNACKNOWLEDGED` 检查（`entries > 0 && !ack`）不会触发，未确认 resume 合法放行
  ——这不是 bug，是"零副作用无需确认"的正确语义；要测该拒绝路径必须先等 journal≥1 条。
- 排查此类"状态离奇变化"问题，加轨迹打印（每 0.5s 输出 status+关键计数）比静态读代码快得多。
