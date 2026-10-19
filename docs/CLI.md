# CLI 参考（P2）

> 二进制名：`pi-workflow`。命令：run / validate / list / status / resume / stop。

## validate

```bash
pi-workflow validate ./examples/smoke.js
```

校验 meta 信封、确定性约束与 JS 语法。合法时输出 `{ valid, file, meta }` JSON。

## run

```bash
pi-workflow run ./examples/smoke.js
pi-workflow run ./examples/parallel.js --cwd . --args '{"topics":["redis","sqlite"]}'
pi-workflow run ./examples/smoke.js --model "provider/modelId" --concurrency 4 --json
```

| 选项 | 说明 |
|---|---|
| `--cwd <dir>` | 工作目录（agent 会话与相对路径基准；缺省 process.cwd()） |
| `--args <json>` | 传给脚本的 `args` 全局（严格 JSON 校验） |
| `--model <spec>` | 运行级默认模型（脚本级 `model` 优先） |
| `--concurrency <n>` | 最大并发（1-16） |
| `--timeout <ms>` | run 级 agent 默认超时（0 = 无上限） |
| `--retries <n>` | run 级默认重试次数（0-3） |
| `--max-agents <n>` | 单 run agent 总数上限（含 checkpoint） |
| `--json` | 机器可读 JSON 输出（stdout） |
| `--non-interactive` | 无交互模式：checkpoint 进入等待态（绝不自动通过） |
| `--continue-on-failure` | 恢复静默继续旧行为（agent 耗尽失败返回 null 不终止） |

运行即持久化：manifest（created→running→终态）+ journal 追加 + 完成时 result.json。

## list / status

```bash
pi-workflow list                 # 全部 run（死进程补偿态显示 interrupted）
pi-workflow status <runId>       # manifest + journal 摘要 + result 摘要
```

## resume

```bash
pi-workflow resume <runId> [--yes] [--non-interactive] [--model <spec>]
```

- 脚本/args 哈希变化 → `[RESUME_MISMATCH]` 拒绝（退出码 2）。
- 命中 journal 的节点免模型回放（`replayed` 标记，不重复花 token）；首个未命中之后重执行。
- 中断恢复的副作用窗口：交互确认或 `--yes`；`--non-interactive` 未决则拒绝（不静默重执行写类副作用）。
- waiting_checkpoint 恢复时重新询问 checkpoint（或再次进入等待态）。

## stop

```bash
pi-workflow stop <runId>
```

仅本机活跃进程：SIGINT（优雅取消）→ 3s → SIGTERM；死进程标记 interrupted。不承诺跨主机/守护能力。

## 持久化布局

```text
.pi-workflows/runs/<runId>/
  manifest.json   # scriptHash/argsHash/status/pid（原子写：tmp+rename）
  journal.jsonl   # append-only 节点成功记录（损坏行读端跳过）
  result.json     # 终态摘要（原子写）
```

运行状态模型：`created → running → completed | failed | cancelled | waiting_checkpoint | interrupted`（crash 检测：status=running 且 pid 死 → interrupted）。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | completed |
| 1 | failed（agent 失败/超时耗尽/闸门终止） |
| 2 | invalid（脚本校验失败/CLI 参数错误/resume 哈希不匹配/副作用确认未决） |
| 3 | waiting_checkpoint（人工审批等待态，`resume` 恢复） |
| 130 | interrupted（SIGINT 取消） |

## 信号

run/resume 进程：`SIGINT`/`SIGTERM` → 优雅取消（manifest → cancelled，Abort 传播到全部进行中 agent）。

## 模型凭证

复用 Pi 的凭证发现（`~/.pi/agent/auth.json` 等）。无凭证时模型解析失败 → 退出码 1。
