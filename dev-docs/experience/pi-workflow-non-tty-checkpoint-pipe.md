# pi-workflow 无 TTY 管道下多个确认 readline 抢输入

## 问题现象

agent 通过 bash 工具（无 TTY）执行 `pi-workflow resume <runId>` 时，若途中有多个人工确认点
（resume 的副作用窗口确认 + workflow 内 `checkpoint()` 发布确认），即使
`printf 'y\ny\ny\n' | pi-workflow resume ...` 喂入多个 `y`，第二个 readline 仍立即 EOF，
进程退出，run 停回等待态。

## 排查过程

- `printf 'y\ny\n' | resume` 输出停在 checkpoint 的 `批准继续？[y/N]`，status 仍显示"无交互通道"。
- 读 `src/cli/commands/resume.ts` 与 `src/checkpoint/terminal-provider.ts`：
  两处各 `readline.createInterface({ input: process.stdin })`。

## 根因

Node readline 接上管道后在 flowing 模式一次性缓冲全部输入；第一个 readline close 后，
缓冲中未消费的行被丢弃，第二个 readline 面对的是已 EOF 的 stdin。

## 解决方案

- 用 `--yes` 跳过 resume 的副作用窗口确认（`resume.ts` 中 `!flags.yes` 分支），
  让全流程只剩 checkpoint 一个 readline，再精确喂一个 `y`：

  ```bash
  printf 'y\n' | pi-workflow resume <runId> --yes --json
  ```

- 全新 run（`pi-workflow run`）没有副作用窗口确认，管道喂一个 `y` 即可直接过 checkpoint。
- 注意：checkpoint 回复从管道读入的前提是 provider 走 readline（当前实现支持）；
  `--non-interactive` 则彻底无通道，只会进入等待态。

## 预防/注意事项

- agent 代跑发布类 workflow 的标准姿势：先 `--non-interactive` 发起（安全停在 checkpoint），
  人工批准后再 `printf 'y\n' | pi-workflow resume <runId> --yes`。
- 输出用 `--json` 时若终端是 GBK 代码页，中文可能混入导致下游 `json.loads` 失败；
  解析前先看 status（`pi-workflow status <runId>`）确认实际运行结果，别只信 stdout。
