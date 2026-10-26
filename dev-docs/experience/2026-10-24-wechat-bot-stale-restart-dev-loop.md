# 微信 Bot 改码后旧进程仍在跑——开发期后台服务的正确重启姿势

日期：2026-10-24
关联设计：`dev-docs/design/2026-10-22-wechat-persistent-service.md`（P0-B T2 后台服务）
关联代码：`src/gateway/service-lock.ts`、`src/cli/commands/wechat.ts`、`src/cli/commands/wechat-service.ts`

## 一、问题现象

开发迭代期（P1a ObsidianService 真机验收阶段）反复出现同一类问题：

1. **僵尸旧进程**（10-24 上午）：发消息"没反应"，排查发现 bot 是 **10-23 20:37 启动**的进程（PID 66729）——早于全部 P1a 提交，内存里还是旧 registry（无 obsidian 工作流）；叠加 WeChat 桌面桥接僵尸，`bot-status.json` 自报 `connected` 但实际收不到消息。
2. **手动重启繁琐易漏**：每次改功能后的重启是裸命令 `kill $(…) → nohup pi-workflow wechat start … &`，靠记忆拼参数，容易漏 kill、漏 flag（本日两次重启都靠 agent 手打）。
3. **启动失败无感知**：`nohup … &` 后不看 `/tmp/wechat-bot.log`，若 start 因单实例锁被拒（exit 2「已在运行」）根本不知道，误以为"重启好了"，实际还是旧进程在服务。

## 二、排查过程（现有机制盘点）

### 1. 单实例锁（`src/gateway/service-lock.ts`）

- `acquireServiceLock`：`openSync(lock, "wx")` 原子建锁。
  - 锁持有者 **pid 存活** → 新 start 返回 `acquired:false`，**直接拒绝，不接管不 kill**（`wechat.ts:163` 打印持有者 pid/startedAt 后 exit 2）。
  - pid 已死/锁损坏 → rename 陈锁后重建，**自愈接管**。
- 结论：锁防的是"双进程"，**不解决"旧进程该换新代码"**——重启永远要人为触发。

### 2. 两种运行形态

| 形态 | 命令 | 跑的代码 | 生命周期管理 |
|---|---|---|---|
| 前台/裸后台 | `pi-workflow wechat start …`（nohup） | **dist/**（`pi-workflow` bin 链接 `dist/cli/index.js`），改码须 `npm run build` + 重启 | 无：手动 kill + 重新 nohup |
| **PM2 托管** | `pi-workflow wechat service start/restart/status/stop` | **src/ 源码直跑**（ecosystem `node --import tsx src/cli/index.ts`），改 TS 后 restart 即生效，**连 build 都不用** | PM2：一键 restart/stop，status 聚合健康 |

### 3. 已有但被遗忘的解法：`wechat service` 子命令（`src/cli/commands/wechat-service.ts`）

- `service start [flags]`：生成 `<data>/ecosystem.config.cjs`（绝对路径锚定 registry/scripts/data）→ pm2 start → `pm2 save`。**混跑互斥**：活锁存在时拒绝并给出"一步 restart"或"两步指引"提示。
- `service restart`：**一条命令用现有配置重启**——就是"改码后忘了 kill 旧 pid"的直接解药。
- `service status`：聚合 PM2 进程态 + 单实例锁 + Bot 连接/心跳（`lastPollOkAt`）+ 运营统计 + 崩溃 err 尾行；**退出码契约**：unhealthy/login_required/errored → 1，天然可接巡检脚本。
- `service stop`：shutdown message 优雅停止（10s 强杀兜底）+ 注销 + save。
- 本机 pm2 6.0.14 已全局可用。

### 4. 配置热加载区分（哪些改动需要重启）

| 改动 | 是否需重启 |
|---|---|
| `src/**/*.ts`（service 形态） | 需要，但**无需 build**，`service restart` 即生效 |
| `src/**/*.ts`（前台 nohup 形态） | 需要，且**先 `npm run build`** |
| registry JSON | **需要**（启动时一次性 loadFromFile 进内存） |
| `obsidian.config.json`（vault 锚定别名） | **不需要**（facade 每次预检现读） |
| `.aws-article/config.json` | **不需要**（Python 后端每次调用现读） |
| workflow 脚本 `dev-examples/**/*.js` | **不需要**（每次运行现读脚本文件） |

## 三、根因

开发期沿用了**裸 nohup 前台形态**——它是无生命周期管理的调试形态：没有统一重启命令、失败无感知、跑 dist 需要 build。而仓库在 P0-B T2 已交付 PM2 托管形态（`wechat service`），**问题不是缺机制，是没用上机制**。

## 四、解决方案（推荐动作）

### 立即：迁移到 service 形态（一次性，在测试间隙执行）

```bash
# 1) 停掉当前前台 nohup 实例
kill $(python3 -c "import json;print(json.load(open('.pi-wechat/service.lock'))['pid'])")

# 2) PM2 托管启动（参数锚定进 ecosystem，之后不再拼）
pi-workflow wechat service start \
  --registry dev-examples/am-p0/registry.json \
  --scripts dev-examples \
  --routing-mode agent \
  --auto-approve obsidian-note-create

# 3) 确认
pi-workflow wechat service status
```

### 之后的开发循环（标准三步）

```bash
# 改完 TS 代码 / registry 后：
pi-workflow wechat service restart   # 一条命令，幂等，不存在"忘了 kill"
pi-workflow wechat service status    # 确认 connected + 新 pid + restarts+1
```

- 改 `src/**` 无需 `npm run build`（tsx 直跑源码）。
- 改启动参数（registry 路径等）：`service stop` 后重新 `service start`（restart 沿用旧配置）。

### 可选增强（后续迭代，当前不做）

1. **版本指纹**：`service status` 增加 git HEAD + registry 摘要输出——防"bot 报 connected 但跑的是旧代码"无从判断（本日僵尸案例的教训）。
2. **start 接管语义**：`wechat start --restart` 自动停旧起新（目前活锁直接拒绝，语义保守正确，可保持）。
3. **巡检脚本**：cron 轮询 `service status` 退出码（Python，遵守仓库脚本约定），非零即告警。

## 四.5、执行结果（2026-10-24 当日落地）

按外部复审意见（优先级 P0/P1）当日完成：

1. **P0 修复**（`src/cli/commands/wechat-service.ts`）：
   - status/stop/restart 的 dataDir 解析链：`--data` flag > PM2 注册 args（`pm2_env.args` 提取）> 默认 `.pi-wechat`，不再硬编码；
   - ecosystem `args` 改**数组形态**（原先 `args.join(" ")` 拼字符串，含空格路径/Windows 会拆错）；
   - status 退出码修正：**非 healthy 一律 1**（unregistered/stopped/starting 此前误归 0，巡检脚本无法判定"未就绪"）。
2. **P1 增强**：
   - status 版本指纹：`版本：git <HEAD>；registry <路径>（N 条，sha 前8位）`——一眼识别"跑的是哪个版本+哪份注册表"；
   - stop/restart 活跃 workflow 守卫：扫描 `.pi-workflows/runs` 非终态 run，有则默认拒绝（exit 2 列出 runId），`--force` 覆盖——避免中断生成/发布中的任务。
3. **PM2 迁移完成**：前台 nohup 已停；`wechat service start`（registry 16 条 + agent 模式 + auto-approve 白名单）→ status=healthy（pid 40436，心跳新鲜）。
4. 回归：412 tests 411 pass；build 零错；P0 门禁 18 PASS。
5. P2（文件变化自动重启）确认不做——显式 restart 两步循环已够，精力回归业务闭环。

## 五、预防 / 注意事项

1. **别混跑**：service 形态启动会拒绝前台活锁（反之亦然）；切换形态先停另一种。`service status` 显示 `unregistered + 锁存活` = 前台形态在跑。
2. **Ctrl-C 只停前台 Bot**，PM2 托管进程不受影响（启动横幅有提示）。
3. **bot-status.json 的 `connected` 不可全信**（桥接僵尸仍报 connected），以 `lastPollOkAt` 新鲜度 + 实际收发为准；`service status` 已聚合。
4. **测试中途不要切形态/重启**——重启会丢运行中任务上下文（可用 `pi-workflow resume <runId>` 恢复）。
5. PM2 重启风暴保护：`min_uptime 30s + max_restarts 10 + exp_backoff`，反复崩会停在 errored，`service status` 退出码非零。
