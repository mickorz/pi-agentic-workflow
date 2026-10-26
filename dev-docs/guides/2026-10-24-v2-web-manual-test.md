# V2 Web 手动测试指南（P1 Server / P2 工作台 / P3 端到端）

> 日期：2026-10-24 · 覆盖：V2 Web 线三层（本地 Server + React 工作台 + 端到端质量）
> 前置：仓库根 `npm ci && npm run build && npm link`；模型不传（走 `~/.pi/agent/settings.json` 默认）
> 约定：命令在**仓库根目录**执行；`dev-examples/` 下脚本为开发期装置，随时可删不承担责任。
> 关联：V2-P0 服务层旧指南见 `guides/2026-10-20-v2-manual-test.md`（本篇是其 Web 线续篇）

## 0. 被测对象

| 层 | 入口 | 说明 |
|---|---|---|
| Web Server | `pi-workflow web [--port N] [--config DIR]` | Fastify 13 REST+SSE，仅监听 127.0.0.1；token 启动时打印（也可 config 文件固定） |
| Worker | Server 内部 fork | 每 run 一个子进程，IPC JSON-lines；kill Server/Worker 均可恢复 |
| Web 工作台 | `cd web && npm run dev` → http://localhost:5173 | React+Vite；`/api` 代理到 `PI_WORKFLOW_WEB_PROXY_TARGET`（缺省 4317） |
| 程序化门 | `dev-examples/v2-web/*.sh` + `web/` Playwright | 一键断言套件（Part A） |

**免 LLM 快测**：给 Server 进程加 env `PI_WORKFLOW_TEST_RUNNER=fake PI_WORKFLOW_FAKE_DELAY_MS=300`，agent 节点按固定延迟假执行（不产 tokens）；不加则走真实 SDK。

## Part A. 程序化门（一键回归，先跑这个）

| 脚本 | 覆盖 | 预期 |
|---|---|---|
| `bash dev-examples/v2-web/gp1-gate.sh` | API 门：幂等键/SSE 游标重连/cancel/checkpoint 决策/重启历史/穿越与跨 Origin 拒/401 | `PASS=21 FAIL=0` |
| `bash dev-examples/v2-web/gp2-gate.sh` | 真浏览器门：TokenGate→New Run→实时树→审批(批/拒)→完成→刷新重建→关浏览器 Worker 存活→pageerror=0 | `PASS=23 FAIL=0` |
| `bash dev-examples/v2-web/fault-suite.sh` | 真进程故障注入：kill -9 Worker/Server、journal 尾损、checkpoint 并发决策 | `PASS=34 FAIL=0` |
| `bash dev-examples/v2-web/sync-e2e-suite.sh` | SSE 断连重连（真 kill Server→重连补漏→序列无缺口） | `ALL PASS`（12 断言） |
| `bash dev-examples/v2-web/v1-cli-smoke.sh` | V1 CLI 兼容（validate/run/status/resume **真实 SDK**）+ V2 Server 跨轨只读 | `PASS=15 FAIL=0` |
| `node dev-examples/v2-web/xplat-smoke.mjs` | 纯 Node 跨平台冒烟（无 bash 依赖，CI 同款） | `PASS=10 FAIL=0` |
| `cd web && npm run mock` | Playwright 正式 E2E（fake runner：全流程/审批/Worker 独立/XSS 字面渲染） | `8 passed` |
| `cd web && npm run e2e:real` | Playwright 真实 SDK（tokens>0 核验） | `1 passed` |
| `npm test`（仓库根） | 主仓单测（209 V1 基线+V2 全部） | `267/267` |
| `cd web && npx vitest run` | 前端单测（runModel/useRunEvents） | `13 passed` |

> `dev-examples/v2-web/demo-web.sh`：终端版 9 步 API 演示（curl 逐条），可当 API 面教学材料。
> `dev-examples/v2-web/cp-last-probe.mts`：checkpoint 为最后节点的双写竞态复现装置（ed0c059 修复的回归证据）。
> 性能基线：`bash dev-examples/v2-web/perf-baseline.sh`（2026-10-24 采集：启动 755ms / 5-agent run 1914ms / SSE 首帧 50ms / RSS≈141MB）。

## Part B. 真浏览器手动链路（默认真实 SDK）

### B0 启动

```bash
# 终端 1：Server（token 在启动横幅打印；也可 --config <目录> 固定）
pi-workflow web --port 4317
# 终端 2：前端
cd web && npm run dev
```

浏览器开 `http://localhost:5173`（vite 只绑 localhost，勿用 127.0.0.1）。

### B1 TokenGate → Dashboard

| 操作 | 预期 |
|---|---|
| 首屏粘贴 token，点「连接」 | 跳转 Dashboard；header 出现「在线」状态点 |
| 故意粘错 token | 停留并提示 401（token 仅 Authorization/X-PI-Workflow-Token 头，绝不读 URL query） |

### B2 New Run 表单

| 操作 | 预期 |
|---|---|
| 打开 New Run | projects 下拉=Server 白名单（缺省 `examples/`）；workflows 级联枚举，坏脚本标「（解析失败）」 |
| 选中任一 workflow | validate 预览显示 meta 名/描述/阶段数 |
| args 填非法 JSON | 前端拦截提示，不发请求 |
| 启动 | 跳 RunDetail，状态「实时连接中（SSE）」 |

### B3 实时进度（真实 SDK）

| 观察 | 预期 |
|---|---|
| 执行树 | phase 分块 → 节点行随 node.started/completed/failed 变 ✅❌⏳；重试节点显「第 N 次」徽标 |
| 用量面板 | 终态后 tokens/cost/耗时汇总（checkpoint 节点不计入 agent 数） |
| 断开 Server（Ctrl-C）再重启 | header 显「连接已断开自动重连中」→ 自动退避重连补漏，序列无缺口不重复 |

### B4 Checkpoint 审批

用含 `checkpoint("允许继续吗？")` 的 workflow（如 `examples/checkpoint-demo.js`）：

| 操作 | 预期 |
|---|---|
| Run 到 waiting_checkpoint | Dashboard「待审批」区出现；RunDetail 出现 Checkpoint 审批卡片（问题文本+版本徽标） |
| 点「批准…」 | 变「确认批准？副作用将真实执行」——**二次确认才生效，绝不自动批准** |
| 确认 | run 继续 → 已完成；历史决策列表「已批准」×1 |
| 换一 run 点「拒绝…」确认 | run **失败**（人工拒绝=强停止，不可降级重试）；manifest.error 含「人工拒绝」 |
| 两个标签页同 run 同时批准 | 恰一处生效，另一处提示「已在别处处理」自动刷新，不重复执行（乐观锁） |

### B5 刷新重建（E16）

| 操作 | 预期 |
|---|---|
| 已完成 run 的页面 F5 | 磁盘事件全量重建：状态 chip「已完成」+「已同步完成」+ 时间线完整 + 用量回填 |

### B6 取消与恢复

| 操作 | 预期 |
|---|---|
| 运行中 run 点「取消…」确认 | 终态「已取消」；执行中 agent 被中止，已执行副作用不回滚 |
| kill -9 Worker 进程（pid 见 run 目录 manifest） | run 变「已中断」，**不假成功** |
| 对已中断 run 点「恢复…」 | 展示副作用说明；**不勾选确认框** → 409 停住不自动重试；勾选后才真正恢复，journal 回放去重 |

## Part C. 观测记录表

| 日期 | 用例 | 结果 | 断连/重连次数 | 端到端延迟 | tokens | 备注 |
|---|---|---|---|---|---|---|
| | B1~B6 全链路 | | | | | |
| | B4 双标签竞争 | | | | | |
| | B3 kill Server 重连 | | | | | |

## 常见问题

- **401**：token 错/没带；token 在 Server 启动横幅或 config 文件 `web.token`。
- **403 跨 Origin**：直连 4317 但 Origin 是别的端口——开发请走 vite 5173 代理。
- **429**：限流（600 次/60s 每 IP）或并发上限（缺省 2）。
- **409 SIDE_EFFECTS_UNACKNOWLEDGED**：恢复需副作用确认，属预期。
- **页面 000/拒绝连接**：vite 只绑 localhost；`npm run build` 后才可用全局 `pi-workflow` 新特性。
