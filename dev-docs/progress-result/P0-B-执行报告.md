# P0-B 执行报告：PM2 常驻与生命周期（F1 + F2 + F4）

> 日期：2026-10-23 · 依据：dev-docs/design/2026-10-22-wechat-persistent-service.md §7.1 P0-B
> 提交：856fa4a（T1-T3）、8ab8064（T4 实测修复与验证）
> 结论：**P0-B 完成**——后台运行、shutdown message 优雅停止、崩溃拉起、混跑互斥全验证

## 交付

| 任务 | 交付物 | 验证 |
|---|---|---|
| T1 shutdown message 优雅停止 | src/gateway/service-shutdown.ts + wechat.ts 接线 | 单测 4 项（幂等/stop 失败释放锁/exit(0)） |
| T2 service 命令族 | src/cli/commands/wechat-service.ts（start/stop/status/restart，PM2 封装，runner 可注入） | 单测 11 项（混跑拒绝/配置契约/命令序列/jlist 杂音解析） |
| T3 单测 | tests/unit/service-shutdown.test.ts + wechat-service.test.ts | 15/15 |
| T4 程序化验证 | dev-examples/wechat-service/verify-p0b.py（支持单用例参数） | 4 用例全 PASS（见下） |

## 验收证据（对应需求 §7 门禁）

| 门禁场景 | 结果 | 证据 |
|---|---|---|
| 强制结束 Bot 子进程 → 自动拉起 | PASS（Windows） | verify-p0b 用例1：taskkill pid=31952 → PM2 拉起新 pid=38712（restarts=1，Bot 重连横幅在日志） |
| Windows 停止走 shutdown message | PASS（Windows） | 用例2：日志命中「收到停止指令（PM2 shutdown message）」；进程退出/锁释放/条目清/零孤儿 |
| 启动反复失败 → 上限/退避/日志 | PASS（Windows） | 用例3：坏 registry → too many unstable restarts → errored；err 日志定位「注册表不存在或为空」 |
| 前台+后台混跑被拦 | PASS（Windows） | 用例4：服务 online 时前台 wechat start 退出码 2 且报持有者 pid=41588 |
| 再次启动同一服务被拦 | PASS | service start 前置查锁（P0-A 锁复用），单测覆盖 |
| 重启后 registry/cwd/data 一致 | PASS | 生成配置显式绝对路径锚定（单测断言） |

## 实测踩坑（三炸点，均已修复并沉淀经验）

1. **PM2 7 对 .ts 默认 interpreter=bun**：无 bun 时静默起不来（online 假象/零日志/pid 缺失）→ 配置显式 `interpreter: "node"`。
2. **PM2 fork 的 IPC channel 吊住事件循环**：wechat start 早退路径（坏 registry/锁互斥/启动失败）return 后进程不退出，PM2 误判 online 假健康 → 服务模式（PI_WECHAT_SERVICE=1）早退冲刷后硬退出。
3. **PM2 unstable 重启计数语义**：只计「存活 < min_uptime 的重启」（设计文档预警实锤）；exp_backoff 的 30s worker 重置会复活 errored 应用——验证配置不带 exp_backoff，生产保留（真实崩溃退避有价值）。
4. 附带：taskkill /T 对 cmd 垫片子进程树无效（P0-D 直杀 manifest pid 绕开）；pm2 start 只认 ecosystem.config.* 文件名。

经验文档：dev-docs/experience/pm2-ts-bun-interpreter-and-ipc-hang.md

## 遗留

- macOS 侧复跑（P0-D 统一处理）
- restart 命令沿用现有配置（改参数走 stop+start，F7 P1 语义）
