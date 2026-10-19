# CLI 参考（P0）

> 二进制名：`pi-workflow`。P0 提供 `run` / `validate`；`list` / `status` / `resume` / `stop` 在 P2 引入。

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
| `--max-agents <n>` | 单 run agent 总数上限 |
| `--json` | 机器可读 JSON 输出（stdout） |
| `--continue-on-failure` | 恢复静默继续旧行为（agent 耗尽失败返回 null 不终止） |

## 退出码

| 码 | 含义 |
|---|---|
| 0 | completed |
| 1 | failed（agent 失败/超时耗尽/闸门终止） |
| 2 | invalid（脚本校验失败 / CLI 参数错误） |
| 130 | interrupted（SIGINT 取消） |

## 信号

`SIGINT` → 中止当前 run（进程内 Abort 传播到所有进行中 agent）。跨进程 `stop` 属 P2。

## 模型凭证

复用 Pi 的凭证发现（`~/.pi/agent/auth.json` 等）。无凭证时模型解析失败 → 退出码 1。
