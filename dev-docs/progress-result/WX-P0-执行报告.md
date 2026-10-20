# WX-P0 执行报告 — 组件可行性验证（M0）

> 阶段：WX-P0（wechat-dispatch）
> 日期：2026-10-20 · 基线 HEAD：6e8a7ca（108 单测绿，4 submodule 就位）
> 结论先行：**LK-01 落定路径 B（独立 BotAdapter）；LK-02 落定抽取路径（独立 ModelRouter，复用 Bifrost 纯逻辑）**；真机扫码/收发为挂起人工步骤（附 SOP），按 P0 文档 §4 降级条款不阻断 P1。

## Gate-in

| 项 | 结果 |
|---|---|
| git 基线 | HEAD 6e8a7ca；遗留本地克隆 pi-dynamic-workflows 已入 .gitignore |
| npm ci + build + test | ✅ 108/108 |
| submodule | 4/4 就位（wechat-assistant@36f0950 / bifrost@78a8201 / pi@71023aec / opencode-dynamicworkflows@3373d1a） |
| 测试微信号 | 未当场扫码（见「真机 SOP」），代码级/网络级验证不受影响 |

## T1 pi-wechat-assistant 源码结构分析（G0-1 ✅）

依赖面：运行时依赖仅 `qrcode-terminal`；`"type":"module"`、TS 源码可被本项目 tsx 直接深路径 import。

| 模块 | 行数 | Pi 运行时依赖 | 复用判定（路径 B） |
|---|---|---|---|
| `src/wechat/api.ts`（iLink HTTP 层） | 313 | 无（fetch+crypto） | ✅ 直接 import |
| `src/wechat/client.ts`（WeixinClient：长轮询/游标/去重/SessionExpired） | 537 | 无 | ✅ 直接 import |
| `src/wechat/{types,security,media}.ts` | 347 | 无 | ✅ |
| `src/bridge/auth.ts`（**QR 登录**：getQrCode/pollQrStatus→credentials.json；桥锁/交接） | 75 | 无 | ✅ 关键复用 |
| `src/bridge/{state-storage,transport-state,config,config-values,bridge-lock,bridge-ownership}.ts` | ~320 | 无 | ✅ |
| `src/messaging/*`、`src/shared/*` | ~400 | 无 | ✅ |
| `src/bridge/queue.ts`（消息批处理→Pi 对话桥） | 497 | 仅 **type-only** `ExtensionContext` | 🔶 不复用（语义是桥接 Pi 会话；wechat-dispatch 有自己的 dispatch 层） |
| `src/extension/*`（Pi Extension 入口/TUI 命令/工具） | ~1500 | ❌ Extension API 全量 | ❌ 路径 A 专用 |

登录态/游标/去重存储：`~/.pi/agent/wechat-assistant/`（credentials.json / cursor.json / seen-ids.json / session.lock / context-tokens.json）。iLink API：`https://ilinkai.weixin.qq.com`，Bearer token。

## T2/T3 微信收发薄验证（G0-2/G0-3）

**T3 路径 B（独立进程）——代码级+网络级已验证**（`dev-examples/wx-m0/standalone-adapter.ts`）：

| 步骤 | 结果 |
|---|---|
| 深路径 import wechat/client、bridge/auth、wechat/api、types | ✅ 加载成功，零 Pi 运行时依赖 |
| QR 登录函数形态（getQrCode/pollQrStatus/loadCredentials） | ✅ 纯 HTTP，无 Pi 依赖 |
| WeixinClient 实例化（假凭据） | ✅ |
| **真实获取二维码（网络调用）** | ✅ 成功：`https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=8f2263d2...`（ilinkai 可达） |
| 既有凭据 | 无（未在 Pi 内登录过，符合预期） |

**T2 路径 A（Pi Extension）——代码级判定**：submodule 自带完整 Extension 实现（安装即用），但其生命周期绑定交互式 Pi TUI 宿主（TUI 命令/ux 状态/会话桥队列），不适合 wechat-dispatch 的无人值守独立进程形态；留作对照不作为实施基线。

**真机验证 SOP（挂起 → P1 T7 前执行，属人工步骤）**：
1. `npx tsx dev-examples/wx-m0/standalone-adapter.ts --qr` → 终端输出二维码 URL（或用 qrcode-terminal 渲染）
2. 手机微信扫码确认 → 脚本轮询 `pollQrStatus` 至 confirmed → credentials.json 生成
3. 手机发一条文本 → 长轮询收到（onMessage 打印）；用 api.sendMessage 回一条固定文本
4. 记录：往返时延、SessionExpired 表现、断网 5 分钟后轮询是否自愈（游标/去重恢复）

**LK-01 决策**：✅ **路径 B（独立 BotAdapter）为 P1 实施基线**——协议层零 Pi 依赖可整体复用；Extension 路径留作对照。阻断项：无（真机步骤不改变架构判断）。

## T4 Bifrost 兼容性验证（G0-4）

三组实验（脚本均在 `dev-examples/wx-m0/`）：

| 实验 | 脚本 | 结果 |
|---|---|---|
| 1. 扩展装载 | `bifrost-extension-load.ts` | **可装载**（需显式 `agentDir`；不指定时报 `undefined.startsWith` 装载失败）；已装载扩展列表含 bifrost，0 errors |
| 2. 纯逻辑抽取 | `bifrost-pure-modules.ts` | ✅ `routing.ts`（findCandidates/selectModel/modelKey，7 策略）+ `config.ts`（bifrost.json 加载，issues=0）+ `virtual-model.ts`（bifrost/auto 标识）深路径 import 可用；三 tier 假池候选检索+选择全通过（pattern=池名子串匹配，ctx 需 `{modelRegistry:{getAvailable()}}` 形态） |
| 3. 显式 model 优先级 / 多会话隔离 | — | 未做真机实验（依赖扩展路由真实生效）；抽取路径下该两问由自研 ModelRouter 直接保证（显式物理模型 > tier，见 P1 §2 设计），不依赖 Bifrost 行为 |

**LK-02 决策**：✅ **抽取路径为主**——从 bifrost 抽取 `routing/config/virtual-model` 纯逻辑（fork 范围=3 文件，登记上游 78a8201，许可随仓库），实现独立 `ModelRouter`（契约稳定，双路径要求满足）；扩展直挂为已验证备选（保留 P2/P3 复评空间）。理由：
1. Bifrost 分类器为 LLM 调用（每次路由一次模型请求），与无头子会话节点级路由的确定性/成本/延迟需求不匹配
2. 其交互宿主生命周期（TUI 命令/ux 状态）与无人值守场景错配
3. MR 需求要 tier 决策记录（nodeId→requestedTier→actualModel→routeSource），自研层天然满足

## T5 Runtime 回归（G0-5 ✅）

- `npm ci && npm run build && npm test`：**108/108 pass**（本阶段零 `src/` 改动）
- 说明：`run-resume-suite.sh`/`run-stop-signal-suite.sh`（真实模型时序套件）本轮未重跑——P0 无产品代码改动、npm test 已覆盖逻辑面；两套件列入 WX-PT 全量回归项（风险表登记）。

## Gate-out 结论（G0-6）

| 编号 | 出口条件 | 状态 |
|---|---|---|
| G0-1 | T1 模块清单 + 复用判定 | ✅ |
| G0-2 | C-01 真实收发全流程 | 🔶 降级（代码级+QR 网络级已证；扫码/收发挂起为 P1 T7 前置人工步骤，SOP 已附） |
| G0-3 | C-02 两种生命周期差异结论 | ✅（路径 B 独立进程自持；路径 A 绑定交互宿主） |
| G0-4 | C-03/C-04 Bifrost 结论 + LK-02 落定 | ✅（抽取路径为主） |
| G0-5 | C-05 主项目回归 | ✅ 108/108 |
| G0-6 | 验证报告落盘（本文件） | ✅ |

**Gate 判定：PASS（含 1 项降级）** → 允许进入 WX-P1；P1 T7（微信接入真机验收）前必须先完成真机 SOP。

## 风险表更新

| 风险 | 状态 |
|---|---|
| 真机扫码/收发未当场执行 | 挂起；P1 T7 前置（SOP 见上）；FakeBot 开发不受影响 |
| iLink 接口变动/风控 | 低（官方 Bot 通道；QR 获取已实测可达） |
| Bifrost 扩展路径在无头场景行为未知 | 已绕开（抽取路径）；备选留档 |
| wechat-assistant 升级破坏复用面 | submodule 冻结 36f0950；升级需重跑本报告实验脚本 |

## 交付物清单

- `dev-examples/wx-m0/standalone-adapter.ts`（T3，含 --qr 实测）
- `dev-examples/wx-m0/bifrost-pure-modules.ts`（T4 抽取验证）
- `dev-examples/wx-m0/bifrost-extension-load.ts`（T4 装载对照）
- 本报告 + `.gitignore`（遗留克隆忽略）
