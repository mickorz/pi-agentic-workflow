# Windows 专属命令混入跨平台脚本（wx-mock engine taskkill / fixture ping -n）

**日期**：2026-10-27
**现象**：Windows 侧新提交的 WX-MOCK 验收引擎（651ac7f）在 macOS 全部无法运行或行为错误。

## 问题一：engine.py 进程树强杀用 `taskkill`

- 现象：任何场景一跑就 `FileNotFoundError: [Errno 2] No such file or directory: 'taskkill'`。
- 根因：`MockService.kill()` 无条件调用 `taskkill /F /T /PID`（Windows 专属），违反 CLAUDE.md「脚本一律跨平台」约定。
- 解决（engine.py）：
  1. `Popen(..., start_new_session=True)`——POSIX 建独立进程组（Windows 忽略该参数，不影响）；
  2. `kill()` 平台分支：`os.name == "nt"` 走 taskkill；否则 `os.killpg(os.getpgid(pid), SIGKILL)`（组杀覆盖 worker 子进程），`ProcessLookupError/PermissionError` 吞掉；
  3. `[KEEP]` 提示文案同步分平台。

## 问题二：mock-slow fixture 用 `ping -n 12` 当 sleep

- 现象：checkpoint-resume 场景 X1d 失败「未找到 interrupted 任务」——任务秒完成，没有可中断窗口。
- 根因：`ping -n <秒>` 是 Windows 惯用 sleep 技巧；macOS 上 `ping -n` 是「不做 DNS 解析」，`12` 被当目标主机参数，语义完全不同，不产生预期阻塞。
- 解决（fixtures/mock-slow.js）：sleep 改 `node -e "setTimeout(() => process.exit(0), 11000)"`（node 已是 fixture 运行依赖，天然跨平台）。
- 教训：**跨平台 sleep 一律用 `node -e "setTimeout(...)"` / Python `time.sleep()`，绝不用 ping 技巧**。

## 问题三（顺带）：registry 存量计数测试过期

- `tests/unit/obsidian-workflows.test.ts` 断言 wx-article 16 / am-p0 22，github 线并入后实际 19 / 24——Windows 侧改了 registry 没同步计数基线。已更新断言（19/24）。

## 预防

- 新脚本/fixture 提交前至少在另一平台跑一次冒烟（本项目双机 Mac+Windows 协作）；
- 涉及进程/信号的平台差异见 `dev-docs/experience/windows-signal-semantics-stop.md`，CLAUDE.md「平台差异注意」条款同样适用于测试 fixture。
