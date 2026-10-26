# P0-C 执行报告：健康监测与日志（F11 + F3）

> 日期：2026-10-23 · 依据：dev-docs/design/2026-10-22-wechat-persistent-service.md §7.1 P0-C
> 提交：bfbe860
> 结论：**P0-C 完成**——进程存活与微信实际可用双维度判定、心跳陈旧检测、日志按天滚动

## 交付

| 任务 | 交付物 | 验证 |
|---|---|---|
| F11 Bot 状态状态机 + 落盘 | src/gateway/bot-status.ts（BotStatusMonitor + readBotStatus + aggregateServiceStatus） | 单测 8 项 |
| adapter 心跳钩子 | bot-adapter.ts 增 onPollOk（每轮成功拉取回调） | e2e 心跳时间戳刷新 |
| status 双维度聚合 | wechat-service.ts serviceStatus：PM2 进程态 + 锁持有者 + Bot 状态 → 综合状态 | verify-p0c 用例1/4 |
| F3 日志滚动 | setup-logrotate.py（pm2-logrotate 安装+配置：每日 0 点/保留 14/压缩/50M 兜底） | verify-p0c 用例3 |

## F11 契约落实（§7.3 / §7.4）

| 契约项 | 落实 |
|---|---|
| 双维度分离 | Process（PM2 online/stopped/errored）与 Bot（五态）独立来源、独立展示 |
| 五态映射 | connected/reconnecting 原样；stopped+attempt>0（重连耗尽，WG-006 凭据失效类）→ **login_required**（detail 带 rebind 指引）；自称 connected 但心跳 >120s 无成功拉取 → **unhealthy**（不与凭据失效混淆，§7.4） |
| 最近成功拉取时间 | lastPollOkAt（心跳节流 30s 落盘，不覆盖非 connected 态） |
| 连续失败次数 | attempt（reconnecting 时为退避轮次） |
| 进程重启不误报旧状态 | 状态文件带 pid+bootStartedAt；pid ≠ 当前锁持有者 → stale → starting |

## 验收证据

| 门禁场景 | 结果 | 证据 |
|---|---|---|
| 凭据过期/重连耗尽 → login_required 不假报健康 | PASS | 单测（映射/聚合/login_required≠unhealthy/rebind 指引）8/8 |
| 区分进程存活与微信实际可用 | PASS（真服务） | verify-p0c 用例1：综合 healthy（PM2 pid=38200 = 锁 pid = 状态文件 pid 三处一致 + Bot connected + 心跳新鲜）；用例4：停止后综合 stopped |
| 日志滚动生效 | PASS（Windows） | pm2-logrotate 3.0.0 online + 配置四项校验通过（每日/14 份/压缩/50M） |

status 退出码语义：查询总成功（0）；仅 login_required/unhealthy/errored 等异常健康态非零（1），供巡检脚本用。

## 踩坑

- pm2 7 模块安装器优先 spawn bun：Windows 下无 shell spawn 找不到 .cmd 垫片 → 需真 bun.exe 在 PATH
  （npm i -g bun 后复制 node_modules/bun/bin/bun.exe 到 npm-global 根）
- pm2 conf <module>:<key> 是设置帮助模板视图；写配置用 pm2 set，读单 key 用 pm2 conf <全key>

## 遗留

- login_required 真机全链路（需真凭据失效触发）未做 e2e——状态机语义已单测覆盖，留待真实过期时观测
- macOS 侧 logrotate/setup 复跑（P0-D）
