# wechat 常驻后台服务 P0-D 双平台手动测试指南（Windows + macOS）

> 日期：2026-10-23 · 范围：P0-D 双平台与真实业务验收（需求 dev-docs/design/2026-10-22-wechat-persistent-service.md §7）
> 已程序化完成的 Windows 证据：verify-p0b/p0c/p0d 全 PASS（progress-result/P0-B、P0-C、P0-D-执行报告.md）
> 本指南目的：① Windows 侧快速复跑确认（可选，~10 分钟）；② **macOS 侧全量验收（必做，~40 分钟）**；③ 真实业务项
> 纪律：**任何单步超 3 分钟先停下查逻辑**（参考 dev-docs/experience/；勿无脑重试加等待）

## 0. 双机互踢警告（重要，先读）

微信 Bot 同账号**一台机器在线会踢掉另一台**（设计 §3 非目标：跨机互斥不做，约定固定机运行）。
测试 Mac 前，先在 Windows 侧停服务：

```powershell
# Windows
pi-workflow wechat service stop
pi-workflow wechat service status   # 应显示 综合 stopped
```

Mac 测完后如需回到 Windows 常驻，反向同样先停 Mac。**两侧不要同时 service start。**

## 1. 环境准备（Mac 首次，~15 分钟）

```bash
# 1) 拉代码与构建（Mac 上没有仓库时）
git clone https://github.com/mickorz/pi-agentic-workflow.git && cd pi-agentic-workflow
git pull   # 已有仓库
npm ci && npm run build && npm link

# 2) 全局依赖（部署层）
npm i -g pm2
python3 --version          # macOS 自带；无则 xcode-select --install

# 3) 凭证：Mac 侧无 ~/.pi/agent/wechat-assistant/credentials.json 时先登录
pi-workflow wechat login   # 扫码；此步会踢掉任何其它机器的在线实例

# 4) 日志滚动模块（幂等，脚本内含校验）
python3 dev-examples/wechat-service/setup-logrotate.py
#    预期：[PASS] pm2-logrotate 已就绪 {...}
#    Mac 差异：pm2 模块安装器 spawn bun 走 shebang，无 Windows 的 bun.exe 垫片问题；
#    若报 bun ENOENT：brew install bun 或 npm i -g bun 后重跑
```

基线：`npm test 2>&1 | tail -3` 应全绿（Mac 上无 symlink 权限问题，应为 300/300）。

## 2. 程序化验收套件（Mac 全跑 / Windows 可选复跑）

三个脚本均支持单用例参数（如 `verify-p0b.py 3` 只跑用例 3），失败定位更快：

```bash
# ── P0-B：生命周期（~8 分钟，用例 1/2/4 起真 Bot 需凭证）──
python3 dev-examples/wechat-service/verify-p0b.py
# 预期：PASS=6 FAIL=0
#   用例1 崩溃拉起：强杀 → PM2 拉起新 pid（restarts+1）
#   用例2 优雅停止：日志「收到停止指令（PM2 shutdown message）」+ 锁释放 + 条目清
#   用例3 失败上限：坏 registry → errored + err 日志定位原因
#   用例4 混跑互斥：服务在线时前台 wechat start 退出码 2 报持有者 pid

# ── P0-C：健康与日志（~5 分钟）──
python3 dev-examples/wechat-service/verify-p0c.py
# 预期：PASS=4 FAIL=0（healthy 聚合 / 语义单测 / logrotate 配置 / 停止态）

# ── P0-D：中断恢复 + 服务冒烟（~5 分钟）──
python3 dev-examples/wechat-service/verify-p0d.py
# 预期：PASS=6 FAIL=0（interrupted 识别 → resume → completed；start→healthy→stop→stopped）
```

**Mac 预期差异**（verify 脚本已分支处理，遇异常对照）：杀进程用 `kill -9`（非 taskkill）；
探活 `kill -0`（非 tasklist）；`shutil.which("pi-workflow")` 解析无垫片问题。

## 3. 服务级手动用例（两平台同表，逐条等回执/输出）

启动基线：

```bash
pi-workflow wechat service start
pi-workflow wechat service status   # 等到 综合 healthy（进程+Bot+心跳，~30-60s）
```

| # | 用例 | 操作 | 预期 | 平台 |
|---|------|------|------|------|
| H1 | 关终端存活 | service start 后**直接关闭启动服务的终端窗口** | `service status` 仍 healthy；微信发「你好」能回复 | 双 |
| H2 | 崩溃自愈 | `pm2 pid wechat-bot` 取 pid → `kill -9 <pid>`（Win：任务管理器结束 node） | 数十秒内 status 恢复 healthy，restarts+1 | 双 |
| H3 | 优雅停止 | `pi-workflow wechat service stop` | 秒级完成；status 综合 stopped；`.pi-wechat/service.lock` 消失 | 双 |
| H4 | 日志滚动 | 查 `<data>/logs/`（wechat-bot-out.log 有内容）+ `pm2 conf pm2-logrotate:retain` 输出 14 | 日志在 data 目录；滚动配置生效 | 双 |
| H5 | 长任务中断恢复 | 服务 healthy 时微信发「帮我跑一下长任务演示」→ 收到受理回执后立即 `service stop` → `service start` → 微信发「刚才那个任务进度如何」 | 任务被识别为 interrupted 且可恢复语义（不重复启动）；`pi-workflow resume <runId>`（终端）可续跑至 completed | 双 |
| H6 | 健康态观感 | service status 全字段 | 综合状态/PM2 进程/单实例锁/Bot 连接 四行齐全，pid 三处一致 | 双 |

## 4. 真实业务项（微信渠道，双平台任一完成即可）

| # | 用例 | 操作 | 预期 |
|---|------|------|------|
| B1 | 持续收发 | 服务 healthy 挂机 ≥10 分钟，期间随意微信对话 3+ 条 | 每条均有回复；status 一直 healthy；无掉线 |
| B2 | 公众号文章链 | 微信发「把 E:/Obsidian/newsky/60_Workspace/写作/单篇/AI名词解释/<某目录> 这篇文章发布到公众号草稿箱，跳过确认」→ 回「批准」 | 完成通知含 media_id；公众号草稿箱多一篇（Windows 已于 10-22 验证过一次，Mac 侧可选） |
| B3 | 凭据失效语义（可选，会踢号） | `pi-workflow wechat rebind` 前置：另一台机器登录同账号踢掉本机 → 观察数分钟 | 最终 status 综合 login_required（非 unhealthy），提示 rebind 处置 |

## 5. 观测记录表（测完填，作为 P0-D 报告附件）

| 用例 | 平台 | 结果 | 耗时 | 备注（pid/restarts/异常） |
|------|------|------|------|--------------------------|
| verify-p0b（Mac） | mac |  |  |  |
| verify-p0c（Mac） | mac |  |  |  |
| verify-p0d（Mac） | mac |  |  |  |
| H1 关终端 |  |  |  |  |
| H5 长任务恢复 |  |  |  |  |
| B1 持续收发 |  |  |  |  |
| B2 公众号链 |  |  |  |  |

## 6. 已知问题对照（不是 Bug）

- Windows `npm test` 1 例 symlink EPERM 失败：非管理员会话建符号链接受限，环境项，与功能无关。
- 服务 stop 后 PM2 条目即删（有意设计：下次 start 不撞同名）；`pm2 list` 里只应看到 pm2-logrotate。
- `pm2 kill` 在 Windows 可能孤儿化应用进程（经验文档有记录）；正常路径一律走 `wechat service stop`。
- Bot 空闲时心跳约 30s 一跳（长轮询节流），status 的 lastPollOkAt 隔一会儿才更新属正常。
