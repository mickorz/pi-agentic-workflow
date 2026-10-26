# Windows 下 SIGINT/stop 信号语义与 MSYS 自动化限制

> 日期：2026-10-20 · 关联：V1/V2 手动测试 G2/H 组程序化执行

## 问题现象

程序化执行手动测试 G2（SIGINT 取消）时：

1. Git Bash(MSYS) 里 `kill -INT <pid>` 发出后 run **继续跑完**（✅ 完成，而非 cancelled）——信号像没发过一样。
2. H 组 `pi-workflow stop` 成功终止 run（终态 cancelled），但**被停进程 exit=1**，与指南预期的 130 不符。

## 排查过程

- `head` 全局 shim `/d/DevTools/npm-global/pi-workflow`：内容为 `exec node ...`，排除 wrapper 层吞信号。
- G2 的 run 日志显示三节点全部真实执行（tokens 齐全），确认 SIGINT 从未送达，不是 CLI 捕获逻辑问题。
- H 组 stop 侧日志显示 SIGINT 已"发出"且 run 被终止——说明 stop 走的是另一条路径。

## 根因

- **MSYS kill -INT 无法送达 Windows 原生进程**：POSIX 信号在 MSYS 里对原生 exe 仅在同 console 时模拟
  `GenerateConsoleCtrlEvent`；后台（`&`）启动的进程拿不到 CTRL_C_EVENT，信号静默丢失。
- **Windows 上 Node 无法投递可捕获的 SIGINT**：`process.kill(pid, 'SIGINT')` 对原生进程表现为直接终止，
  目标进程的 SIGINT handler 不执行。因此 CLI 的"SIGINT→3s→SIGTERM 优雅取消"在 Windows 上实际是
  **强杀 + 由 stop 侧做死进程补偿**（manifest 标 cancelled）。exit 130 是 POSIX 语义，Windows 下为非零（1）。

## 解决方案

- 跨平台断言以**终态为准**：stop/SIGINT 场景断言 `manifest=cancelled`，不断言 exit 130。
- 自动化脚本中 G2 在 MSYS 下标记 SKIP，以 PowerShell 终端手动 Ctrl-C 证据验收（run-mvg2yc5z-sera cancelled）。
- 自动化脚本：
  - `dev-examples/manual-test/run-resume-suite.sh`（G3/G4/G5：先测 G4/G5 再回放收尾，
    因为 resume 成功后 run 变 completed，无法再测拒绝路径）
  - `dev-examples/manual-test/run-stop-signal-suite.sh`（G2/H/I/J；I 组独立跑 01-smoke 取事件流，
    cancelled run 不会有 run.completed 事件，不能当样本）

## 预防/注意事项

- Windows 下写涉及信号/终止的自动化测试：能用 `pi-workflow stop` 就不要自己发信号；
  需要强杀时用 `taskkill /F /T /PID <pid>`（按 PID 树杀，禁止按镜像名批量杀）。
- 文档中 POSIX 特有的退出码（130 等）应标注平台差异。
- 断言 run 事件流前先确认 run 终态：只有 completed run 才有完整事件集（含 run.completed）。
