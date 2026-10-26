# PM2-托管-TS-进程三坑：bun 解释器、IPC 吊事件循环、unstable 重启计数

## 问题现象（P0-B T4 实测，Windows + PM2 7.1.0）

1. `pm2 start` 配置 `script: xxx.ts` + `node_args: --import tsx-loader`：显示 **online 但无 pid、零日志**，进程根本没起。
2. 进程打印错误后 `return 2`，前台秒退；**PM2 fork 下进程不死**，PM2 持续误报 online（假健康），永不触发重启。
3. 崩溃拉起验证中反复重启却一直不进 `errored`；去掉 `exp_backoff_restart_delay` 后又观察到 errored 应用被「复活」重启。

## 排查过程

- 现象 1：`pm2 describe` 看到 `interpreter: bun`——PM2 7 对 `.ts` 默认解释器是 bun，机器无 bun 时静默失败。
- 现象 2：`timeout 15 node --import tsx …` 前台 rc=2 正常退出；同命令在 PM2 fork（有 NODE_CHANNEL_FD IPC）下挂住
  ——PM2 fork 的 IPC channel 保持事件循环存活，`process.exitCode` 等 GC 不发生。
- 现象 3：PM2 只把「存活 < min_uptime 的重启」计为 unstable（max_restarts 只限 unstable）；tsx 冷启约 8s > 5s 的
  min_uptime → 被判「稳定重启」不计上限；`exp_backoff` 的 worker 有 30s 重置逻辑会把已 errored 应用重新调度。

## 根因

PM2 的 TS 默认解释器策略 / Node IPC channel 生命周期 / unstable 计数与 backoff worker 语义。

## 解决方案

1. ecosystem 配置显式 `interpreter: "node"`（PM2 7 对 .ts 默认 bun）。
2. 服务模式（`PI_WECHAT_SERVICE=1`）下 CLI 早退路径：`process.stdout.write("", () => process.exit(rc))` 冲刷后硬退出。
3. 失败场景验证配置：`min_uptime` 必须 **大于** 失败路径实际存活时长（含 tsx 冷启），不带 `exp_backoff_restart_delay`；
   生产配置保留 exp_backoff（真实崩溃退避有价值，errored 复活极端情况可接受，另有 status 可查）。
4. 附带发现：PM2 `pm2 kill` 在 Windows 上可能孤儿化应用进程（清理时需按命令行特征兜底扫杀）；
   `pm2 start <file>` 只认 `ecosystem.config.*` 文件名，其他名字当普通脚本执行。

## 预防/注意事项

- 任何「pm2 托管 node/TS 进程」的接入：三件套检查 interpreter / 早退硬退出 / min_uptime 与启动时长关系。
- 健康判定不能只看 PM2 status（online 假象两次实锤）——必须叠加进程 pid 实存 + Bot 业务状态（P0-C F11 落实）。
