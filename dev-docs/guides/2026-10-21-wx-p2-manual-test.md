# WX-P2 手动测试指南（可靠性闭环）

> 日期：2026-10-20 编写，供 **2026-10-21 早上**执行
> 范围：WX-P2 交付面（审批/任务控制/Outbox/恢复/断线/限额/重启/审计）+ P1 链路回归
> 约定：全局命令 `pi-workflow`（已 link，dist 已重建）；默认模型走 `~/.pi/agent/settings.json`，不传 `--model`

## 0. 前置检查（2 分钟）

```bash
cd /Users/michaelchang/Desktop/WorkProjects/pi-agentic-workflow
npm ci && npm run build        # dist 重建（bin 符号链接自动生效）
pi-workflow list | head -5     # CLI 可用
ls ~/.pi/agent/wechat-assistant/credentials.json   # 真机凭据（无则先 SOP 扫码）
```

真机 SOP（如凭据缺失）：`npx tsx dev-examples/wx-m0/standalone-adapter.ts --qr` 扫码登录。

## Part A：脚本套件（无需真机，5 分钟）

```bash
npx tsx dev-examples/wx-p2/manual-suite.ts
```

预期：`PASS 11 / FAIL 0`（S1-1 ~ S7-1，覆盖审批卡/幂等/澄清/跨用户/补偿查询/恢复确认/重启补投/频率限额/审计链脱敏）。
记录输出全文作为 PT 证据。

## Part B：真机用例（微信渠道，核心）

启动（终端 1，仓库根）：

```bash
pi-workflow wechat start \
  --registry dev-examples/wx-p2/registry.json \
  --scripts dev-examples/wx-p2 \
  --allow-user <你的wxid> \
  --rate-max 10
```

预期横幅：`wechat-dispatch 已启动（registry=3 个流程 …）`。用绑定微信号向 Bot 发消息逐条执行：

| # | 用例 | 发送内容 | 预期 | 对应 |
|---|------|----------|------|------|
| B01 | 审批卡触发 | `执行审批演示` | 受理回执 → 数十秒内收到「⏳ 任务等待你的审批」卡片（含 tb- 任务号与事项） | A11/EX-007 |
| B02 | 批准继续 | 在 B01 后发 `批准` | 「✅ 已批准（tb-…），任务继续执行」→ 完成通知含第二阶段结果 | A11 |
| B03 | 拒绝硬停 | 再次 `执行审批演示`，收到卡后发 `拒绝` | 「🛑 已拒绝」→ 任务按拒绝语义停止，**无第二阶段结果** | EX-008 |
| B04 | 重复批准幂等 | B02 完成后再发一次 `批准` | 「该审批已批准过…」或「当前没有等待你审批的任务」，不重复推进 | A12 |
| B05 | 进度查询 | `执行长任务演示` 后发 `进度如何` | 回复任务号 + 状态（运行中） | A13/EX-005 |
| B06 | 取消 | `取消刚才的任务` | 「🛑 已取消」；终端无新 agent 活动 | A13/EX-006 |
| B07 | 歧义澄清 | 连发两个 `执行长任务演示`，再发 `取消任务` | 列出两个 tb- 供选择，**不直接取消**；再发 `取消任务 tb-xxxx` 生效 | A14/IR-009 |
| B08 | 任务列表补偿 | 任意任务完成后发 `任务列表` | 列表含已完成项与摘要 | A15/NT-006 |
| B09 | 中断恢复 | 终端 1 按 Ctrl-C（任务运行中）→ 重启 wechat start → 发 `恢复任务` | 提示「⚠️ 恢复可能重复…回复：确认恢复 tb-…」；按提示回复后「▶️ 已恢复」 | A16/EX-009 |
| B10 | 停止≠取消 | 启动长任务后 Ctrl-C | 横幅说明任务不受影响；`pi-workflow list` 中 run 仍在，可 `pi-workflow resume <runId>` | A17/WG-007 |
| B11 | 并发上限 | 连发 3 个 `执行长任务演示` | 第 3 个收到「已达并发上限…」话术（默认 maxConcurrentRuns=2） | A18/EX-010 |
| B12 | 频率限制 | 10 秒内连发 12+ 条消息（--rate-max 10） | 超限消息收到「请求太频繁，请 N 秒后再试」 | A18/SC-005 |
| B13 | 重启不丢审批 | 发起 `执行审批演示`，收到卡后 Ctrl-C → 重启 wechat start | **不重发旧审批卡**（版本去重）；发 `批准` 仍可推进 | WX-1/CV-004 |

注意事项：
- B09/B10/B13 的 Ctrl-C 时机若不好控制，可改用脚本化方式（参照 `dev-examples/manual-test/run-stop-signal-suite.sh` 的看门狗写法）。
- 真机 Token 预算用例（A18 第三层）依赖真实用量累计，门槛高，已由单测 A18c + 脚本套件 S6 覆盖代码路径；真机不强制。
- 首条消息如遇「模型调用失败」，检查 `~/.pi/agent/settings.json` 默认模型可用（`pi-workflow run examples/hello.js` 预热）。

## Part C：状态文件抽验（3 分钟）

真机用例后检查 `.pi-wechat/`（WX-1/WX-2/WX-3 证据）：

```bash
# 任务映射完整（含 status/summary/approvalNotifiedVersion）
cat .pi-wechat/tasks.jsonl | tail -3
# 审计按 runId 串链：intent.route → run.start → checkpoint.requested → checkpoint.approve
grep "<B01的runId>" .pi-wechat/audit.jsonl
# Outbox 状态机（sent/failed；完成≠送达）
tail -5 .pi-wechat/outbox.jsonl
# 脱敏抽查：以下必须无输出
grep -E "sk-[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9]" .pi-wechat/audit.jsonl && echo "❌ 泄露" || echo "✅ 干净"
```

## Part D：Router 工具链 CLI 冒烟（无需真机，2 分钟）

RP-P0~P3 已完成开发与真实数据验收，以下为快速冒烟（完整证据见 RP 执行报告）：

```bash
# D1 Dry-run（零副作用）：正确路由 + 参数抽取
pi-workflow route --text "把 Hello world 翻译成中文" --registry dev-examples/wx-p1/registry.json
# 预期：workflowId=translate，args 含 text/targetLang，exit=0
# 验证零副作用：
ls .pi-workflows/runs | wc -l   # 数量不变

# D2 高风险不可绕：
pi-workflow route --text "部署服务上线" --registry dev-examples/wx-p1/registry.json \
  --scripts dev-examples/wx-p1 --execute
# 预期：⛔ NOT_AUTHORIZED，exit=1

# D3 真实执行（read-only）：
pi-workflow route --text "总结这个网页 https://example.com/a" \
  --registry dev-examples/wx-p1/registry.json --scripts dev-examples/wx-p1 --execute
# 预期：🚀 已启动；pi-workflow list 里读 run 最终 completed

# D4 评测器回归（确定性管线）：
npx tsx dev-examples/router-eval/evaluate.ts --mode fake --label smoke-fake
# 预期：准确率≥90%，gate=PASS
```

## 通过标准（更新）

> 2026-10-21 执行注记（无需真机部分已闭环）：Part A 11/11 PASS；Part D D1~D4 全过
> （D1 translate 正确路由零副作用；D2 NOT_AUTHORIZED exit1；D3 summarize 真实执行 completed；
> D4 fake 90.5% gate=PASS）。执行中发现并修复 Windows 双盘符路径 bug（三处 evaluate 脚本
> import.meta.url.pathname → fileURLToPath，见 experience/windows-import-meta-url-pathname.md）。

> 2026-10-21 晚 Part B/C 执行注记：B01 真机审批卡 ✓；B02~B04 程序化决策链 5/5 ✓（批准
> completed+第二阶段/两任务拒绝硬停/重复批准幂等；微信直通交互真机已验澄清列表）；
> B09 ✓（resume journal 2 条回放+step-3 真实执行）；B10 ✓（服务终止 run interrupted 可查）；
> B13 ✓（重启不重发旧卡+决策推进 completed）。B05~B08/B11/B12 为手机一句话操作，逻辑已由
> Part A 11/11 覆盖，留用户窗口补真机证据。Part C ✓（tasks/audit/outbox/脱敏干净；程序化决策
> 通道不记 checkpoint.approve 审计属预期，真机路径 105156b9 已证完整）。
> **发现并修复产品缺口**：跨进程决策恢复（decideCheckpoint delivered=false → resume 重挂+重放，
> B13 重启场景同源），新增回归测试，150 单测全绿（scripts: batch-decide.ts / b-seq.ts）。

- Part A：11/11 PASS
- Part B：B01~B13 全部符合预期（B09/B10/B13 允许时序重试一次）
- Part C：审计链完整、脱敏抽查干净
- Part D：D1~D4 全部符合预期
- 全部通过 → WX-PT + RP 线验收闭环；任何 FAIL → 记录到 `dev-docs/troubleshooting/` 并回修后重跑
