# 视频提取工作流：cdp-cli 换 chrome-use 可行性分析

- 日期：2026-11-14
- 对象：`dev-examples/videodigest/adapter`（抖音音频提取 CDP 方案 B 通道）
- 结论先行：**技术上可行、但不建议全量替换；推荐混合方案（cdp-cli 专用实例为主，chrome-use 作回落/增强）**。核心理由：两者浏览器实例模型不同，全量替换会把"无人值守可用性"从无依赖变成依赖"用户 Chrome 开着 + relay 在线"，是视频提取场景的 SLA 回退。

## 1. 现状盘点：cdp-cli 在 videodigest 的三处触点

| 触点 | 文件 | 职责 | 依赖的 cdp-cli 能力 |
|---|---|---|---|
| ① 音频抓取 | `lib/cdp-grab.ts` | `cdpLaunch` 起专用 Chrome（:9223 临时 profile）→ `new <视频页>` → `evalJs(PLAY_JS/GRAB_JS)`（play + 读 `video.currentSrc`/时长/标题） | 专用实例启动、按 page id 定向 eval |
| ② cookie 导出 | `lib/cookies.ts` | `cdpLaunch` → `new <站点>` → **裸 CDP WebSocket `Network.getAllCookies`** → 按域过滤 → Netscape cookies.txt（供 yt-dlp 回落通道） | 专用实例 + CDP 协议直连（含 httpOnly） |
| ③ 工具解析 | `lib/tools.ts` + `cli.ts` | `resolveTool('cdp-cli')`（PATH/别名探测）；Windows 下 `.cmd` 经 cmd 包装 | 二进制探测约定 |

关键特性：cdp-cli 路径用的是**一次性专用实例**（`/var/folders/.../cdp-cli-chrome-9223`）——与用户日常 Chrome 完全隔离、无登录态、跑完即弃、**不依赖用户 Chrome 是否开着**。

## 2. chrome-use 能力对照（2026-11-14 实测/手册核实）

| 能力项 | cdp-cli（现状） | chrome-use（relay 模式） | 差异判定 |
|---|---|---|---|
| 打开视频页 | `new <url>`（新标签，返回 page id） | `open <url>`（导航**活动标签**） | ⚠️ 语义差异：chrome-use 无按 id 定向 eval，多任务并发需全局锁串行（已有 `/tmp/piwf-chrome-collect.lock` 先例） |
| 页内 JS（play/currentSrc） | `eval <page> <js>` 定向执行 | `eval <js>`（活动标签执行） | ✅ 等价——2026-11-13 T0 的 `dy_collect.py video` 已在 chrome-use 上验证抖音视频页读取；currentSrc 抓取逻辑同源 |
| cookie 导出（含 httpOnly） | CDP `Network.getAllCookies` ✓ | `cookies get/set/clear`、`cookies export --from <profile>`（**macOS only**，解密式） | ⚠️ 功能可用但语义不同；Windows 侧 export 缺口；Netscape 格式需转换层 |
| 专用隔离实例 | `launch`（临时 profile，跑完弃） | 缺省 `--auto-connect` 连用户 Chrome；独立实例模式存在但**未经本仓实测** | ⚠️ 最大分野，见 §3 |
| 无人值守 | ✅ 不依赖用户 Chrome | ❌ relay 模式依赖用户 Chrome 开着 + 扩展在线（preflight_relay 检查项） | ❌ SLA 回退 |
| 跨平台 | mac ✓（Windows .cmd 已包装，chrome.exe 自启路径已有） | mac ✓ / win ✓（chrome-use 双机已装） | ≈ 持平 |
| 与用户会话隔离 | ✅ 临时 profile（风控指纹不关联真人账号） | ❌ 共享用户 Chrome（抖音登录态在、指纹关联真人） | ⚠️ 风控面变化（通常是利好，但出问题波及用户账号） |
| 依赖收敛 | 额外二进制 | 全仓已有标准（2026-11-12 浏览器通道定案：默认 chrome-use） | ✅ 替换可砍一个依赖 |

## 3. 核心风险（按严重度）

1. **无人值守可用性回退（高）**：视频提取是"用户任意时刻发链接"场景（含在公司网络触发家里 Mac）。cdp-cli 现状 7×24 可用；chrome-use relay 把"用户 Chrome 开着+relay 在线"变成新单点。市场分析方案已把同款依赖列为已知降级项（Chrome 未开→跳过小红书），但音频提取没有"跳过"选项——直接任务失败。
2. **共享浏览器争用（高，已有实证）**：image-use（生图走 ChatGPT）、collectors（三渠道采集）、videodigest 三方若共用用户 Chrome，活动标签语义下互相踩踏。E_CRASH 残留草稿事故（pitfalls #14）实证了争用后果；全局锁目前只覆盖 collectors，image-use 接锁是一直挂着的遗留项。再加 videodigest 等于三方争用。
3. **autoplay 与页面策略（中）**：用户 Chrome 的自动播放策略可能拦 `video.play()`（专用实例当前可行；chrome-use 上需 muted 起播验证）。currentSrc 修复后对播放的依赖已减弱，但时长（dur）仍需 metadata。
4. **yt-dlp 回落通道 cookie（中）**：非抖音平台走 yt-dlp+cookies.txt。chrome-use 的 cookies export 是"解密另一个 profile"模式（macOS only），与 CDP getAllCookies 语义不同，Windows 缺口需补。
5. **风控指纹关联真人账号（低-中）**：专用临时实例被抖音风控标记不影响用户；用户 Chrome 被标记影响真人。

## 4. 三个方案

| 方案 | 内容 | 判定 |
|---|---|---|
| A 全量替换 | cdp-grab/cookies 全改 chrome-use（relay） | ❌ 不推荐：SLA 回退 + 三方争用 + cookie 语义重写，换来的只有"砍一个依赖" |
| B 维持现状 | cdp-cli 不动 | ✅ 可接受（零成本），但与"浏览器通道默认 chrome-use"定案并存两个工具，且 cdp-cli launch 偶发失败时无回落 |
| **C 混合（推荐）** | 主路保留 cdp-cli 专用实例；**launch/抓取失败时回落 chrome-use**（preflight_relay 判 CONNECTED 才回落）；全局锁扩展覆盖 videodigest | ✅ 兼得：无人值守不回退、多一层自愈、依赖不增 |

与 2026-11-12「浏览器通道优先级定案」的关系：该定案约束的是**需要用户登录态的采集/操作**（市场分析三渠道、mp/xhs article collect——它们本质上必须用用户 Chrome）；videodigest 抖音抓取是**免登录+受益于隔离**的另一类需求，专用实例不是对定案的违反，而是互补的工具形态。定案条目可补一句备注说明这一分层。

## 5. 若实施 C：要点与验收

1. `cdp-grab.ts` 增加 `extractViaChromeUse()` 回落：preflight（relay 探测，复用 `preflight_relay.py` 判定）→ 取全局锁 → `open` 视频页 → `eval` GRAB_JS（muted play）→ 产出同 `CdpMediaInfo` 形态
2. 回落触发条件限定：`cdpLaunch`/`new`/`evalJs` 报错且 relay CONNECTED；不作为主路（保住无人值守）
3. 全局锁扩展：videodigest 回落路径与 collectors 共用 `/tmp/piwf-chrome-collect.lock`；image-use 接锁为前置任务（历史遗留）
4. 验收：①正常路回归（现有 pytest/链路）②模拟 cdp-cli 不可用（PATH 移除）→ 回落路全链出 wav ③并发用例（采集进行中发视频链接 → 回落路排队不互踩）
5. 待验证假设（实施前实测）：chrome-use 独立实例模式（非 relay）能否等价替代 cdp-cli 专用实例——若成立，方案 C 可演进为"chrome-use 双模式"彻底收敛依赖

## 6. 附：本次核实证据

- cdp-cli 触点 grep（adapter/src 五文件）；cookies.ts 的 CDP WebSocket getAllCookies 实现行
- chrome-use 手册：`open/eval` 活动标签语义、`cookies get/set/export --from`（macOS 标注）、`--auto-connect` 缺省共享会话、`--state/--session-name`
- 2026-11-13 T0 实测：chrome-use 用户 Chrome 上抖音视频页标题/互动数/currentSrc 路径可读（`dy_collect.py`）

## 附录：方案 C 实施记录（2026-11-14 当晚落地）

**用户定案**：机器与 Chrome 长期开启、保持登录、暂无并发多类型任务（并发治理已登记 `dev-docs/todos/2026-11-14-浏览器任务并发争用治理.md`）→ 批准混合方案 C，chrome-use 作兜底（动因：11-13 凌晨两次任务失败，CDP 偶发降级 + yt-dlp 回落死路 + 重试同链路全灭）。

**已落地**（`cdp-grab.ts` + `cli.ts`）：
- 回落链：CDP 专用实例 → **chrome-use（用户 Chrome）** → yt-dlp（三层）
- chrome-use 兜底实现：全局锁（与 collectors 同路径）→ open 视频页 → muted play（用户 Chrome autoplay 策略）→ GRAB_JS → 广告过滤+轮询 → 产出同 CdpMediaInfo
- `VD_FORCE_CHROME_USE=1` 调试开关（跳过 cdp-cli 直测兜底）
- 锁健壮性：写崩溃残留（空文件）立即接管；acquire 进 try 带标志位

**当晚实测新发现（重要，后续维护者必读）**：
1. **登录态前置广告**：用户 Chrome 播抖音先出广告（currentSrc=`v95-aw-web` 广告 CDN、dur null、标题空），专用实例无登录无广告——两通道页面行为本质不同
2. **广告 CDN 偶发挂起**：该晚广告实例无限 loading（readyState 0 恒持），正片永不开始；已加"卡广告→重开重掷一次"，但当夜网络态下兜底通道未胜出（错误链清晰落 yt-dlp）
3. SSR RENDER_DATA 无播放地址（客户端 API 拉取，需 a_bogus 签名，未深挖）；广告元素 remove/ended 事件伪造均骗不过播放器内部状态机
4. **防误取设计**：audioUrl 命中广告 CDN 直接报错放弃（宁失败不取广告音频）
5. 反复自动化重载会触发降级壳页（0 video 元素）——兜底重掷上限 1 次是有意的

**结论修订**：兜底通道对"CDP 降级壳页"场景（11-13 失败模式）有独立成功概率，但对"广告位挂起"场景无效——两者都是抖音侧偶发，互为补充。主路（cdp-cli 无登录实例）仍是抖音最稳通道。
