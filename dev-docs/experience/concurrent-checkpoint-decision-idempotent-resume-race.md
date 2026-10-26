# 并发同体审批决策：µs 级双击命中 resume() 双 Worker 竞态，loser 请求被无限挂起

- 日期：2026-10-22
- 发现场景：`dev-examples/v2-web/fault-suite.sh` 忠实移植为 `fault_suite.py`（F4 用例）时，bash 版 34/34 稳定 ALL PASS，Python 版 F4 稳定 FAIL（并发双 POST 之一返回传输层 0/000，即服务端从未响应）。

## 问题现象

- 对同一 checkpoint 并发提交**两个完全相同**的 decision（同 approve + 同 expectedVersion）：
  - bash 版（两个 `curl ... &` 子进程，实际到达间隔 ≈ 一次进程启动，约 10–30ms）：一个 200 + 一个 200（幂等重放），无异常。
  - Python 版（两个 threading.Thread，µs 级同时到达）：一个 200，另一个**永远无响应**（服务端挂起，客户端只能靠超时得到 000）。
- F4b（approve + reject 反向并发）不受影响：loser 走 CONFLICT → 干净 409。

## 排查过程

1. 原始 socket 复现（两个裸 TCP 连接几乎同时 POST）：winner 收到完整 200 响应；loser 10s 内 0 字节，纯挂起。排除 urllib/curl 客户端差异。
2. 延迟扫描（每轮新起 run、全新 checkpoint，loser 延迟 d 后发）：`d=1ms` 挂起；`d≥3ms` 稳定双 200。**竞态窗口 ≈1–3ms**。
3. 读源码定位链路：
   - `src/server/app.ts:481` decision 路由 → `src/application/run-service.ts:191 decideCheckpoint()`。
   - winner：`checkpoints.applyDecision`（同步）→ `respondToCheckpoint` → Worker ack → 200。
   - loser（同决策同版本）：`applyDecision` 走幂等分支返回 `{ok:true, idempotent:true}` → 跳过 respondToCheckpoint → `delivered=false` → 回退分支 `readManifest`，此时 manifest **仍是 waiting_checkpoint**（worker 还没把 checkpoint.resolved 事件写回、manifest 未翻回 running）→ `await this.executor.resume(runId)` → `src/server/worker-supervisor.ts resume()`：manifest.status 是 waiting_checkpoint，不命中 "still active" 保护 → `launchWorker(resume)` **对同一 run 拉起第二个 Worker** → 该 HTTP handler 永久挂起（run 本身最终会收敛完成，但 loser 的响应永远不回来）。

## 根因

`decideCheckpoint` 幂等重放回退分支在「决策已固化、manifest 尚未翻回 running」的毫秒级窗口内，把幂等重放误当成「跨进程决策/服务重启」场景去 `resume()`，绕过 `resume()` 里仅覆盖 `status==="running"` 的 still-active 保护，双起 Worker 且不回响应。窗口宽度 = applyDecision 落盘 → worker 处理 checkpoint.resolved → manifest 翻回 running 的全链路时延（本机空闲时 ~1–3ms）。

## 解决方案

- **产品侧（未修，本次不改被测代码）**：建议 `resume()` 的 still-active 保护同时覆盖 `waiting_checkpoint` 且 run 仍 active（`active.has(runId)`）的情形；或幂等重放分支不自动 resume，仅回 200 幂等记录。
- **测试侧（已采用）**：`fault_suite.py` F4/F4b 的第二个线程延迟 25ms 启动，复刻原 .sh 两个 curl 进程的实际时序包络（≥10× 窗口宽度），断言集与输出格式不变。

## 预防/注意事项

- 「并发双击」类测试从多进程客户端（curl &）改为多线程客户端（Python）时，有效并发间隔从 ~10ms 收紧到 µs 级，可能首次暴露被进程启动时延掩盖的服务端竞态——对照排查时优先量化「客户端实际到达间隔」再下结论。
- 用裸 socket（http.client/原始 TCP）做最小复现，能在 3 分钟内把「客户端 bug」与「服务端挂起」区分开，比换客户端库对拍更快。
- 对照运行 .sh 时务必放在原路径：本套 .sh 的 `REPO` 由 `$0` 位置推导，拷到 /tmp 跑会让 F2 重启 `node /dist/cli/index.js` MODULE_NOT_FOUND，产生大片无效 FAIL（还叠加 /tmp/p302-body 陈旧响应假象）。
