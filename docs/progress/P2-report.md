# P2 执行报告 — Journal / Resume / Checkpoint

```text
Phase: P2
Target HEAD before: d116e3b（P1 提交）
Target HEAD after: 本阶段 commit（见 git log P2 提交）
Source pinned SHA: 3373d1ae9c5f4adeaaea5d223582532410fba8f3 (opencode-dynamicworkflows v0.11.2)
Pi SDK version: @earendil-works/pi-coding-agent@1.3.0
```

## 交付清单

| 类别 | 内容 |
|---|---|
| Runtime | journal 回放（确定性哈希 + 最长未变前缀 + 空文本不回放）、`checkpoint()`（确认型、等待态、硬停拒绝、回放确定性、计入配额） |
| 持久化 | `src/persistence/journal.ts`（append-only JSONL、损坏行容忍）、`src/persistence/run-store.ts`（manifest 原子写、死进程补偿态、runs 布局、result.json） |
| Checkpoint | `src/checkpoint/terminal-provider.ts`（readline y/N 通道抽象） |
| CLI | `list` / `status` / `resume`（哈希校验+副作用窗口确认）/ `stop`（SIGINT→SIGTERM）；run 持久化接线；`--non-interactive`；退出码 3（waiting） |
| 信号 | SIGINT/SIGTERM → 优雅取消 + manifest 状态落盘 |
| 示例 | `examples/checkpoint-demo.js`（审批 + 副作用窗口演示） |
| 测试 | 单元 91 用例（journal-resume 6 / checkpoint 7 / run-store 5 新增）；e2e 故障注入 1 用例（真实模型） |

## 验收结论

| 项 | 结果 | 证据 |
|---|---|---|
| P2-01 杀进程后 resume 不重复请求已提交节点 | ✅ | unit（resumeCalls=0）+ **真实 e2e**：SIGKILL 后 resume，节点标记 `n1(replayed), n2(replayed), n3` |
| P2-02 脚本/参数哈希变化拒绝复用 | ✅ | unit（prompt 变化重执行）+ CLI 实测：改脚本 → `[RESUME_MISMATCH]` exit 2 |
| P2-03 并行乱序完成不错误匹配 key | ✅ | unit（slow/fast 乱序完成，resume 全命中） |
| P2-04 中断后不静默重执行危险副作用 | ✅ | e2e：`resume --non-interactive` 无 `--yes` → 拒绝；交互确认 readline 落地 |
| P2-05 批准继续/拒绝停止/无终端等待态 | ✅ | unit checkpoint.test.ts（含拒绝不被 fallback 吞、回放确定性） |
| P2-06 取消/超时/子工作流中止传播 | ✅ | unit（resume 后 abort 生效）+ P1 既有中止面测试 |
| P2-07 回放节点 token 不重复计费 | ✅ | unit + e2e（n1/n2 无 tokens，n3 有） |

```text
Test commands:
  npm run typecheck / npm run build   # 0 错误
  npm test                            # 91 pass / 0 fail
  PI_WORKFLOW_INTEGRATION=1 npm run test:integration  # 4 pass
  PI_WORKFLOW_INTEGRATION=1 npx tsx --test tests/e2e/resume-e2e.test.ts
  # → ✔（10.9s）节点标记：n1(replayed), n2(replayed), n3；journal 3 条；manifest completed

Offline tests: 91 passed / 0 failed
Real SDK tests: 4 integration + 1 e2e（故障注入+恢复）passed（glm-5.3-flash）
Known limitations:
  - resume 不承诺 exactly-once：副作用窗口靠人工确认拦截（文档明示）
  - checkpoint 为确认型子集（y/N），无自由文本问答
  - stop 仅本机进程；无守护进程/远程能力
  - events.jsonl 留待 P3（P2 数据面为 manifest/journal/result）
Push result: 已 push 到 origin/master
Gate: PASS
```

## 兼容性决策（详见 docs/migration/compatibility.md 更新）

- checkpoint 无通道且无显式 default → **等待态**（参考实现缺省 `default ?? true` 自动通过；V1 执行文档红线覆盖该行为）。
- journal key/哈希身份面与参考一致（prompt/model/phase/agentType/schema；scope 前缀入 phase）。
- 中断恢复副作用窗口：resume 显式确认（`--yes` 或交互），非交互未决即拒绝。
