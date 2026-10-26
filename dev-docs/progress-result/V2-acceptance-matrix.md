# V2 Web 验收矩阵（E01–E18）

> 依据《pi-agentic-workflow-V2-Web开发执行文档》§8 验收矩阵。
> 判定日期：2026-10-22 · 环境：macOS (Darwin arm64) · Node v25.6.1（CI 矩阵另含 ubuntu/windows 的 Node 22）。
> 复跑入口统一在仓库根（除非另注）：`npm ci && npm run build && npm test`；浏览器门/故障注入需 macOS/POSIX 本地环境。

| # | 层 | 场景 | 判定 | 证据 |
|---|---|---|---|---|
| E01 | Unit | Event Store 写入/读取/seq 严格递增、断裂尾行可诊断 | PASS | `npm test`（tests/unit/engine.test.ts、tests/unit/event-*.test.ts 全绿，含游标读取与尾行诊断）；web 层：tests/unit/web-rest.test.ts「events after 游标」用例 |
| E02 | Unit | Snapshot + 重放：刷新后同状态、无双计数 | PASS | tests/unit/v1-manifest-compat.test.ts（resume 零重复执行、node.replayed×2、run.completed 恰一次）；web/src/lib/run-event-sync.test.ts「刷新重建」；浏览器 reload：web/e2e/e14-e16-app.spec.ts |
| E03 | Unit | Run 状态机非法迁移明确拒绝 | PASS | tests/unit/run-service.test.ts（RUN_STILL_ACTIVE/CONFLICT 族）；tests/unit/web-rest.test.ts「completed resume 409」 |
| E04 | Unit/集成 | Checkpoint 重复决策/版本冲突仅一次生效 | PASS | tests/unit/checkpoint-service.test.ts（同决策同版本幂等重放 200、不同决策 409）；tests/unit/web-rest.test.ts（expectedVersion=99→409）；dev-examples/v2-web/fault-suite.sh F4/F4b（真进程并发双 POST 恰一 200）；浏览器并发：web/e2e/e15-checkpoint.spec.ts 第三测 |
| E05 | Unit | Worker 崩溃 → interrupted，不假成功 | PASS | tests/unit/worker-supervisor.test.ts「E05 kill -9」用例（manifest interrupted+result reject）；dev-examples/v2-web/fault-suite.sh F1/F2（真进程 kill -9） |
| E06 | 集成 | CLI 旧命令全部可用 | PASS | dev-examples/v2-web/v1-cli-smoke.sh 15/15（validate/run/status/list/resume 真实 SDK 跑通+V2 Server 只读兼容）；tests/unit/cli-compat.test.ts；主仓 261 单测含全部 V1 用例 |
| E07 | 集成 | start 幂等键仅创建一个 Run | PASS | tests/unit/web-rest.test.ts「幂等单创建 replayed:true」；dev-examples/v2-web/gp1-gate.sh 断言 6；dev-examples/v2-web/demo-web.sh step8 |
| E08 | 集成 | SSE 断连重试不丢事件、前端去重 | PASS | tests/unit/web-sse.test.ts（E08 断连→重连合并无缺口）；dev-examples/v2-web/sync-e2e-suite.sh 12/12（真 kill Server→重连 openStream#2 补漏、序列 1..N 连续无重复） |
| E09 | 集成 | cancel 级联：Worker/Agent 结束、资源释放 | PASS | tests/unit/worker-supervisor.test.ts「取消升级→cancelled」（IPC→SIGTERM→SIGKILL 链）；fault-suite.sh F2（Server kill 后孤儿 Worker stdin EOF→gracefulShutdown 收敛）；tests/unit/engine.test.ts cancel 用例 |
| E10 | 集成 | resume hash mismatch 拒绝恢复 | PASS | tests/unit/run-service.test.ts:196「resume 哈希不匹配 → RESUME_MISMATCH」（脚本内容/args 哈希校验） |
| E11 | 集成 | 恢复副作用确认缺失不执行 | PASS | tests/unit/web-rest.test.ts E11 用例（409 SIDE_EFFECTS_UNACKNOWLEDGED→ack 后 200）；UI：web/src/components/RunActions.tsx 勾选门（绝不自动补 ack） |
| E12 | Security | 未授权请求/跨 Origin 拒绝 | PASS | tests/unit/web-security.test.ts（无/错 token 401、query token 401、evil Origin 403、限流 429）；tests/unit/web-security-extra.test.ts（413/429/脱敏扫描/XSS API 面）；dev-examples/v2-web/xplat-smoke.mjs（跨平台 10/10） |
| E13 | Security | path traversal/symlink 拒绝越权 | PASS | tests/unit/web-projects.test.ts（symlink 越权 403 FORBIDDEN_PATH）；gp1-gate.sh E13 断言（`../` 403）；web-rest.test.ts E13 |
| E14 | Browser E2E | Dashboard → New Run → Detail 状态正确 | PASS | web/e2e/e14-e16-app.spec.ts（Playwright mock 项目 8/8：执行树/状态 chip/用量/历史/reload/xss 字面渲染）；trace/screenshot 落 web/e2e-results/（retain-on-failure） |
| E15 | Browser E2E | checkpoint approve/reject 两路径正确 | PASS | web/e2e/e15-checkpoint.spec.ts（批准→已完成+已批准；拒绝→失败+已拒绝；UI/API 并发去重恰一次生效） |
| E16 | Browser E2E | reload/reconnect UI 可恢复 | PASS | e14-e16-app.spec.ts reload 用例（重建树+时间线+用量）；web/e2e/worker-independence.spec.ts（浏览器全关→API 轮询→重开历史可见）；sync-e2e-suite.sh（驱动层断流重连） |
| E17 | Real SDK E2E | Pi Agent 真正完成完整 workflow（真实结果/Token/状态核验） | PASS | `cd web && npm run e2e:real`：web/e2e/real-sdk.spec.ts 1/1——UI 已完成 + API result.agents[0].tokens>0（真实 token 消耗核验；fake runner 不产 tokens，为真实判据）；边界说明：agents[].model 记录 DSL 指定值，未指定时为空（默认模型），非缺陷 |
| E18 | Regression | P0–P2 原核心测试无退化 | PASS | 主仓 npm test 267/267（209 基线全保留+新增，含终态守卫 5 用例+approve 竞态回归 1 用例）；web vitest 13/13；CI 三平台全绿（run 39665822414，commit 95e408f：ubuntu/windows/macos Node 22，npm ci+typecheck+build+test+xplat-smoke+web vitest） |

## 复现命令速查

```bash
# 全量单测（主仓）
npm ci && npm run build && npm test

# 浏览器 E2E（mock + real SDK）
cd web && npm ci && npm run mock && npm run e2e:real

# 本地门（POSIX/macOS）
bash dev-examples/v2-web/gp1-gate.sh          # API 门 21 断言
bash dev-examples/v2-web/gp2-gate.sh          # 浏览器门 23 断言
bash dev-examples/v2-web/fault-suite.sh       # 故障注入 34 断言
bash dev-examples/v2-web/sync-e2e-suite.sh    # SSE 断连重连 12 断言
bash dev-examples/v2-web/v1-cli-smoke.sh      # V1 CLI 兼容 15 断言
node dev-examples/v2-web/xplat-smoke.mjs      # 跨平台最小 smoke
bash dev-examples/v2-web/perf-baseline.sh     # 性能基线采集
```

## 结论

E01–E18 全部 **PASS**，无 BLOCKED 项（真实 SDK E2E E17 在本机凭证下跑通）。
