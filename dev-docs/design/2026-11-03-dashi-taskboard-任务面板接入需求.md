# dashi-taskboard 任务面板接入需求（登记稿）

- 日期：2026-11-03
- 状态：需求登记，未排期（待方案讨论后转 planning）
- 来源：坚果云剪藏 `Clippings/AICoding/chuspeeismdashi-taskboard 现代化可灵活嵌入的任务面板，支持 Codex、DeepSeek Harness.md`（2026-11-03）
- 上游仓库：https://github.com/chuspeeism/dashi-taskboard

## 1. 它是什么

本地优先（local-first）的 issue 任务看板，一套 HTTP API 同时驱动 React Web UI 与 `taskctl` CLI，另配 Agent Skill 教 Agent 管任务：

| 能力 | 说明 |
|---|---|
| Web 看板 | React UI，本地 127.0.0.1:47823，SQLite 存储（.data/taskboard.sqlite） |
| taskctl CLI | project/issue 增改查，`CODEX_TASKBOARD_URL` 指向本机或 LAN 服务——Agent 走 CLI 与人走 UI 操作同一数据源 |
| Agent Skill（manage-taskboard） | 状态机纪律：inspect → in_progress（乐观版本）→ verify → in_review；**done 只在用户明确确认验收后落** |
| 实时协同 | SSE 广播 task/comment/attachment 变更，断线重连全量刷新；LAN 直开共享（无鉴权，仅限可信网络） |
| 云协同（可选） | Cloudflare Workers + D1（权威库）+ R2 附件 + Basic Auth；本地能力（Git/worktree、Codex、Skill）不下云 |
| 嵌入 Codex | CDP 注入脚本 / 独立 CDP 端口 / Tauri App（macOS DMG、Windows NSIS、Linux deb/AppImage），侧边栏注入面板 |
| Git 绑定 | 每个 issue 可绑一个 branch 或 worktree；会话经 CODEX_THREAD_ID 归属到 issue（Codex 特有） |
| Markdown | GFM + 只读 mermaid 渲染，HTML 注释隐藏 |

技术要求：Node.js 22.5+；App 构建需 Rust/Tauri 工具链（纯 npm start 跑服务不需要）。

## 2. 与本仓库的关系（候选接入场景，待定案）

我们不是 Codex 宿主（主 harness 是 pi，终端 TUI），CDP 注入嵌入那一路线不适用；但"本地服务 + HTTP API + CLI + Skill 纪律"的架构与 Agent 无关，可整体复用：

| 场景 | 内容 | 适配代价 |
|---|---|---|
| A 开发任务看板 | 本地起 taskboard 作为 pi-agentic-workflow 的开发任务面板，替代/补充 dev-docs/todos 与 scratchpad；pi agent 经 taskctl 建改任务，人在 Web UI 看板操作 | 小；纯使用 |
| B 挂进 pi-workflow web 工作台 | gzh-preview 工作台（Fastify SPA）反代 /taskboard 路径，与花生编辑器并列成一个入口 | 中；路由与鉴权边界 |
| C wechat 任务可视化 | .pi-wechat/tasks.jsonl → taskboard API 的适配层，微信任务在面板上看板化 | 中偏大；双写/单向同步要定 |
| D 流程借鉴 | manage-taskboard 的验收状态机（in_review 卡住、done 需人工确认）与 wechat workflow 任务生命周期互相借鉴 | 零成本；只取设计 |

倾向：**A 起步**（先纯使用验证价值），B 视 A 的使用频率决定，C/D 单独评估。

## 3. 约束与开放问题

- **鉴权边界**：LAN 模式无账号鉴权（绑 127.0.0.1 规避）；云协同暂无需求，不引入
- **与现有任务载体的关系**：dev-docs/todos（文档）、scratchpad（会话级）、.pi-wechat/tasks.jsonl（微信任务）三者与看板的数据边界要先定，避免第四个孤岛
- **Node 版本**：要求 ≥22.5，本机 Node 版本需确认
- **会话归属**：CODEX_THREAD_ID 归属是 Codex 特有；pi 侧对应物（runId/会话 id）接入时要自行映射
- **许可**：README 未见 LICENSE 明示（待查上游 repo），引入前确认

## 4. 建议下一步（P0 试用，未排期）

1. 本地 `npm install && npm run build && npm start` 起服务，用 taskctl 建 2-3 条本仓库真实任务（如 scratchpad 现存待办），人肉走一轮 todo→in_review→done
2. 试用结论（是否值得接）+ 场景定案（A/B/C 取舍）后转正式方案（planning/）
3. 若定 B：在 gzh-preview 工作台加 /taskboard 反代与入口，安全模型沿用工作台既有约定
