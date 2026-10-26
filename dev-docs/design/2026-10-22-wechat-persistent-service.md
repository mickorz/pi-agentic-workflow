# 微信 Bot 服务持久化需求（wechat 常驻后台）

> 日期：2026-10-22 · 状态：**需求已冻结**（两轮外部评审修订完毕，开发顺序见 §7.1），下一步执行计划
> 背景：`pi-workflow wechat start` 目前是前台进程，终端即生命周期
> 核心定位：**让已跑通的微信 Bot 稳定常驻，支撑业务闭环验证；不做通用服务管理框架**

## 1. 背景与问题

当前 `pi-workflow wechat start` 是前台阻塞进程，存在以下问题（2026-10-22 实测踩坑）：

| 问题 | 实际影响 |
|------|----------|
| 终端窗口即生命周期 | 关终端 / Ctrl-C / 误操作 → 服务静默消失 |
| 停机消息全部丢失 | 微信协议层不给 bot 补投离线消息，停机期间指令石沉大海（实案：翻译指令无答复，journal 无记录） |
| 无状态可查 | 服务是否在跑、为何退出，无从知晓 |
| 无自动恢复 | 进程崩溃后不会拉起，需人工发现、人工重启 |
| 同账号互踢无防护 | 两处启动同 bot 账号互踢掉线（实案：双机互踢） |
| **进程活着但 Bot 已失效**（评审补充） | 重连耗尽后 adapter 置 stopped 但宿主进程不退出，`status` 会假报健康 |

## 2. 目标

1. **常驻**：服务在后台持续运行，不依赖终端窗口存在
2. **可控**：一条命令启动 / 停止 / 查状态；停止走应用层指令（跨平台语义一致）
3. **自愈**：进程崩溃后由进程管理器自动拉起
4. **可观测**：日志落盘；状态区分「进程活着」与「Bot 真的在工作」
5. **服务于业务闭环**：微信发选题 → Agent 路由 → Workflow 生成 → 结果返回，链路可持续验证

## 3. 非目标（本期不做）

- 云端部署 / 公网 SaaS 化（与 V2 todo §2.1「明确不做项」一致）
- 跨机器账号互斥（不引入分布式锁/中心服务；约定**一台固定机器运行，另一台仅开发调试**）
- 通用服务管理框架 / 把服务能力产品化交付外部用户（届时再评估自研）
- 停机消息补拉（F9 维持 P2，协议能力待单独验证；**注意：后台运行 ≠ 不丢消息**，休眠/断网仍有接收空窗）

## 4. 功能需求（经评审修订后的优先级）

### P0（本期必须）

| 编号 | 需求 | 说明 |
|------|------|------|
| F1 | 后台运行 | **通过服务命令组**（见 §4.1）后台常驻；`wechat start` 保留为前台调试模式（解决原文 F1 与非功能需求的矛盾） |
| F2 | 服务生命周期命令 | `wechat service start/stop/status`（`restart` 归 F7/P1）。**停止机制锁定 PM2 `shutdown_with_message: true`**：Bot 进程监听 `process.on("message", "shutdown")` → 防重复停止 → `await app.stop()` → `exit(0)`；`kill_timeout` 超时后 PM2 强杀兑底。不自研 IPC 协议（PM2 官方推荐的 Windows 优雅停止方式） |
| F3 | 日志落盘 | PM2 stdout/stderr 日志 + **`pm2-logrotate`** 按天滚动（PM2 默认不轮转）；只维护这一套日志，Inbox/Outbox/audit 业务数据日志保留现有机制不另建 |
| F4 | 崩溃自动拉起 | 由 PM2 实现；配置项评审清单见 §7.2（`exp_backoff_restart_delay` / `min_uptime` / `max_restarts`；注意 `max_restarts` 限的是**连续不稳定重启**，非全时间窗总数） |
| F5 | 单实例防护（本机） | **锁机制在前后台共享的 Bot 启动层实现**（不是只查 PM2 进程表——`service start` 后再跑前台 `wechat start` 也必须被拦）：基于规范化 data 目录原子锁获取 + 陈旧锁恢复（进程崩溃残留），不只看 PID 文件是否存在。只承诺同机同 data 目录互斥；跨机互踢靠运维约定 |
| F11 | Bot 健康状态（新增） | **双维度判定契约**（见 §7.3）：Process（online/stopped/errored）与 Bot（connected/reconnecting/login_required/unhealthy/stopped）分离；Bot 维度记录状态更新时间、最近成功拉取时间、连续失败次数，进程重启后不把旧状态误报为当前健康。对外可聚合为简化综合状态 |
| F12 | 运行时启动入口整理（新增） | 理清 tsx reexec 与常驻进程关系：明确常驻的是哪个 Node 进程、能否脱离仓库 devDeps 独立启动、重启后 cwd/registry/data 路径一致性。**先稳定可重复的启动入口，再做后台包装** |

### P1（本期尽量）

| 编号 | 需求 | 说明 |
|------|------|------|
| F7 | `wechat service restart` | 改配置后一键重启（在 F2 命令组内） |
| F8 | status 增强 | 最近收发时间、累计 token、最近崩溃原因（F11 健康分级优先于本项） |

### P2（记录，暂不做）

| 编号 | 需求 | 说明 |
|------|------|------|
| F6 | 开机自启 | 不进本期。**平台差异记录**：macOS 可用 `pm2 startup`；Windows 官方不支持，需 `pm2-installer` 等第三方方案——届时按平台分别接入，勿按单一前提开发 |
| F9 | 停机消息补拉 | 依赖 iLink cursor 能力验证（auth.ts 已有 transport-state）；单独立项验证 |
| F10 | 掉线自动重登 | 凭据失效只**报告 `login_required` 提示用户 rebind**，不自动操作 |

### 4.1 CLI 设计

```
# 原有模式：前台调试（保留，语义不变）
pi-workflow wechat start
pi-workflow wechat login
pi-workflow wechat rebind

# 新增：后台服务管理（初期为 PM2 封装）
pi-workflow wechat service start
pi-workflow wechat service stop
pi-workflow wechat service status
pi-workflow wechat service restart
```

## 5. 非功能需求

- **平台**：双平台（Windows 主用机 + macOS）；PM2 两平台行为一致，消除自研方案的信号语义差异
- **停止语义**：应用层 IPC 优先（Bot 收指令主动 `app.stop()`），信号/强杀只作超时兜底；不依赖 POSIX 信号在 Windows 的行为
- **兼容**：前台 `wechat start` 保留为调试模式；WG-007 验收定义**修正为**：停止 Bot 不*主动取消* Run；若进程终止导致 Run 中断，必须保留可恢复状态（Journal/Resume/Checkpoint）。未来若要求 Bot 重启期间任务无中断，再评估把执行引擎迁入独立 Worker（参考 RunSupervisor，但两者职责不同，不混用）
- **分层**：进程管理是**部署层**职责，不嵌入 Workflow Engine / 业务代码；PM2 只管进程，不感知微信业务
- **资源**：空闲 CPU 可忽略；内存与现状持平
- **依赖**：新增 PM2（全局部署工具，非业务依赖）；「零新增运行时依赖」降级为偏好而非硬约束

## 6. 裁决记录

### 第一次裁决（2026-10-22 上午）

| 问题 | 裁决 |
|------|------|
| Q1 平台范围 | 双平台 |
| Q2 开机自启 F6 | 不进本期 |
| Q3 实现方式 | A 自研 daemon |
| Q4 停机补拉 F9 | 接受停机丢失，维持 P2 |

### 第二次裁决（2026-10-22，采纳外部技术评审，**覆盖 Q3**）

| 问题 | 裁决 | 理由 |
|------|------|------|
| 实现方式 | **PM2 托管（方案 B 替换自研 daemon）** | `spawn detached` 不等于崩溃自动恢复（F4 需要常驻监督者，自研面大）；PM2 成熟、双平台、日志/拉起/状态自带；进程管理是部署层工具，不是要验证的产品价值 |
| 停止语义 | 应用层 IPC，非信号 | Windows 信号语义不可靠（Node 官方文档 + 仓库经验文档实锤） |
| F5 承诺范围 | 本机互斥 | PID 文件/锁无法跨机器；双机互踢靠运维约定解决 |
| 新增 F11/F12 | 进 P0 | 「进程活着 Bot 已死」假健康比缺统计更危险；启动入口不稳定则后台包装必踩坑 |

## 7. 验收标准（P0 门禁）

| 测试场景 | 期望 |
|----------|------|
| 关闭启动服务的终端 | Bot 仍能接收并回复消息 |
| 强制结束 Bot 子进程 | 进程管理器自动拉起 |
| 再次启动同一本机服务（含前台 start） | 阻止重复实例 |
| 凭据过期 / 重连耗尽 | `status` 明确报告 `login_required`，不假报健康 |
| 停止时 Workflow 正在执行 | 不主动取消；若中断则状态可识别、可 `resume` |
| Windows / macOS 停止 | 均走 PM2 shutdown message 优雅停止，不依赖信号兼容性 |
| 重启服务后 | registry、工作目录、data 位置保持一致 |
| 启动反复失败 | 有重启上限/退避，可查错误日志 |
| 长任务真实验证 | 对运行中 Workflow 做一次真实长任务验证，不只看 manifest 状态 |
| 前台+后台混跑 | service start 后前台 start 被锁拦截并给出明确提示 |

### 7.1 开发顺序（冻结）

| 步骤 | 内容 | 完成标准 |
|------|------|----------|
| P0-A | F12 + F5：稳定启动入口与单实例锁 | Node 启动、路径解析、前后台互斥可靠 |
| P0-B | F1 + F2 + F4：PM2 常驻与生命周期 | 后台运行、shutdown message 优雅停止、崩溃拉起 |
| P0-C | F11 + F3：健康监测与日志 | 区分进程存活与微信实际可用；日志滚动生效 |
| P0-D | 双平台与真实业务验收 | Windows/macOS、长任务中断恢复、持续收发、公众号文章 Workflow 实测 |

### 7.2 PM2 配置评审清单

`exec_mode: fork`、`instances: 1`、`shutdown_with_message: true`、`kill_timeout`、`exp_backoff_restart_delay`、`min_uptime`、`max_restarts`。实施时逐项测试重启策略是否符合预期（尤其 `max_restarts` 只限连续不稳定重启）。

### 7.3 F11 健康双维度契约

| 维度 | 状态 | 说明 |
|------|------|------|
| Process | online / stopped / errored | 进程层，来源 PM2/OS |
| Bot | connected / reconnecting / login_required / unhealthy / stopped | 来源 adapter `onStatus` + 拉取心跳；记录更新时间、最近成功拉取时间、连续失败次数；进程重启后状态从零重建，不误报旧状态 |

### 7.4 实现风险备忘（转执行文档落实）

| 风险 | 执行时必须保证 |
|------|----------------|
| F12 tsx 入口 | PM2 托管**实际 Bot 进程**（单进程形态），不是容易出现父子进程生命周期问题的重执行包装进程 |
| F5 单实例锁 | 锁获取原子；崩溃后可安全恢复陈旧锁；接管前验证持有者存活，**不误删其他活跃实例的锁** |
| F11 健康判定 | 网络故障重试耗尽 → `unhealthy`，不得与凭据失效 `login_required` 混淆（P0-C 落实） |
| P0-D 长任务门禁 | 停止 Bot 后必须实际验证：运行状态正确识别为中断、Journal 可用、能安全 Resume——不能只看进程被重新拉起 |

## 8. 实施阶段（服务业务闭环）

1. **阶段 1：微信服务稳定**（本需求 P0）——持续收发、可恢复、可诊断为完成标准，不延伸成通用框架
2. **阶段 2：回归公众号业务闭环**——真实选题 → Agent 路由 → 文章生成 → 结果返回；记录成功率、人工修改次数、耗时、Token
3. **阶段 3：按真实使用决定基础设施投入**——服务问题仍阻碍则推进更强守护/远程管理；业务问题为主则优先文章质量与路由准确率

## 9. 实施架构

```
CLI / 本地开发者
  service start / stop / status / restart
        │
PM2 进程管理层（部署层，不进业务）
  进程监督 · 崩溃重启 · 日志 · 状态
        │
WeChat Service
  BotAdapter · AgentHost · Dispatcher
  Inbox / Outbox · RunMonitor
  RunApplicationService → Workflow Engine
  （现有 Journal / Resume / Checkpoint）
        │
本地持久化目录 .pi-wechat /（logs 等）
```

## 10. 参考资料

- WG-007 语义与修正定义：`src/cli/commands/wechat.ts` 头注释
- Windows 信号语义限制：`dev-docs/experience/windows-signal-semantics-stop.md`、Node.js 官方文档（signals 在 Windows 不支持跨进程 POSIX 语义）
- adapter 状态回调：`src/gateway/wechat/bot-adapter.ts` `onStatus`（connected/reconnecting/stopped）
- Web 侧 Worker 管理参考（职责不同不混用）：`src/server/worker-supervisor.ts`
- 协议层 cursor/transport-state：`thirdparties/pi-wechat-assistant/src/bridge/auth.ts`
- PM2 文档：https://pm2.keymetrics.io/
- 实测案例：双机互踢、停机消息丢失、假健康风险（2026-10-22 手动测试与外部评审）
