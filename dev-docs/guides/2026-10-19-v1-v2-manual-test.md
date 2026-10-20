# pi-agentic-workflow V1/V2 手动测试指南

> 日期：2026-10-19 · 配套脚本：`dev-examples/manual-test/`
> 覆盖：V1 全量（CLI 六命令 + DSL 原语 + 审批 + 恢复 + 事件）与 V2-P0（应用服务层）
> 约定：每条用例给出**步骤 / 预期 / 证据**；结果记入文末测试记录表。

## 0. 环境准备

```bash
cd /Users/michaelchang/Desktop/WorkProjects/pi-agentic-workflow   # 仓库根
npm ci && npm run build            # 生成 dist/
cd dev-examples/manual-test        # 所有用例在此目录执行（.pi-workflows/ 产物落本目录）

# 两个快捷变量（后续命令直接引用）
WF="node ../../dist/cli/index.js"
MODEL="cc-switch-zhipu-glm/glm-5.3-flash"    # 替换为你本机可用的模型 spec
```

- 凭证：复用 Pi 发现（`~/.pi/agent/auth.json`）；`$WF run 01-smoke.js --model $MODEL` 跑通即凭证 OK。
- 产物目录：`.pi-workflows/runs/<runId>/{manifest.json,journal.jsonl,events.jsonl,result.json,checkpoints.jsonl}`。
- 用例脚本清单：

| 脚本 | 覆盖用例 |
|---|---|
| `01-smoke.js` | B1 冒烟 |
| `02-parallel.js` | B3 args、C1 并行 |
| `03-sequence.js` | C2 顺序链 |
| `04-fallback-race.js` | C3/C4 故障注入（内置坏模型 spec） |
| `05-nested-parent.js` + `05-nested-child.js` | D1 子流程 |
| `06-check-verify.js` | E1 确定性门禁 + AI 审查 |
| `07-checkpoint-demo.js` | F 组人工审批（含写文件副作用） |
| `08-resume-three-nodes.js` | G/H 恢复与停止 |
| `09-timeout.js` | J 超时失败路径 |
| `v2-service-demo.ts` | V2-P0 应用服务全链 |

## 1. 五分钟冒烟（先跑通再逐组细测）

```bash
$WF validate 01-smoke.js                 # 预期：valid:true JSON，exit 0
$WF run 01-smoke.js --model $MODEL       # 预期：✅ 完成，agents:1，结果含 "manual test smoke ok"，exit 0
```

## 2. V1 CLI 手动测试用例

### A 组：validate（脚本校验）

**A1 合法脚本**
```bash
$WF validate 01-smoke.js
```
预期：stdout `{valid:true, meta:{name:"mt_smoke",...}}`；exit 0。

**A2 非法 meta（首语句不是 export const meta）**
```bash
printf 'const x = 1\n' > /tmp/bad1.js && $WF validate /tmp/bad1.js
```
预期：stderr `校验失败：脚本首条语句必须是...`；exit **2**。

**A3 确定性违例（Date.now/Math.random）**
```bash
printf 'export const meta = { name: "bad" }\nconst t = Date.now()\nawait agent("x")\n' > /tmp/bad2.js && $WF validate /tmp/bad2.js
```
预期：`确定性重放` 报错；exit 2。证据：解析期快检在执行前拦截。

### B 组：基础执行

**B1 冒烟**：见 §1。证据：`agents[0].tokens > 0`、sessionId 回填（`--json` 查看或 status）。

**B2 机器可读输出**
```bash
$WF run 01-smoke.js --model $MODEL --json | head -30
```
预期：单一 JSON（meta/result/logs/phases/agents/agentCount/durationMs/runId），可被 `jq` 解析。

**B3 args 注入**
```bash
$WF run 02-parallel.js --model $MODEL --args '{"topics":["docker","nginx"]}'
```
预期：日志首行 `topics = ["docker","nginx"]`；两个 agent 标签 `explain-docker`/`explain-nginx`；结果 answers 与 topics **按索引对应**。

### C 组：控制流

**C1 并行重叠（02-parallel.js）**
```bash
$WF run 02-parallel.js --model $MODEL --json | grep -E '"startedAt"|"durationMs"' | head
```
预期：3 个 agent 的 startedAt 相互重叠（非串行接力）；状态全 ok。

**C2 顺序链（03-sequence.js）**
```bash
$WF run 03-sequence.js --model $MODEL
```
预期：完成；结果 tagline 中包含第一个 agent 发明的产品名（第二节点收到了前项结果）。

**C3 fallback 故障切换（04，真实故障注入）**
```bash
$WF run 04-fallback-race.js --model $MODEL
```
预期：日志含 `fallback[0] 候选返回 null 且有耗尽失败登记，视为候选失败换下一个`；结果 `fallback = "fallback-second-candidate-ok"`；agents 中 `fb-bad` 为 failed、`fb-good` 为 ok。**失败被显式吸收，run 不报错。**

**C4 race 胜出（04 同一脚本）**
预期：结果 `race = "race-winner-ok"`；`race-bad` failed、`race-good` ok；坏分支快速失败未获胜。

### D 组：子流程

**D1 嵌套 workflow（05）**
```bash
$WF run 05-nested-parent.js --model $MODEL --args '{"a":"redis","b":"sqlite"}'
```
预期：日志含 `workflow("mt_nested_child") 启动（key=wf0...）` 与 `workflow("child-b") 启动（key=wf1...）`；两个子 agent 的 phase 带 `▸` 前缀；结果含两份 `{topic, summary}`。

### E 组：质量门禁

**E1 check + verify（06）**
```bash
$WF run 06-check-verify.js --model $MODEL
```
预期：`nodeOk=true`、`pkgOk=true`、`verdict.real=true`（2 reviewer 投票）；agents 含 `verify 1/2` 且 outputType=structured。

### F 组：人工审批（07-checkpoint-demo.js）

**F1 交互批准**
```bash
$WF run 07-checkpoint-demo.js --model $MODEL
# 终端出现：⏸ checkpoint 人工确认：... 批准继续？[y/N]
# 手动输入：y
```
预期：exit 0；结果 `approved=true, exists=true`；本目录生成 `manual-test-note.txt`（含第一个 agent 拟的一句话）。测后 `rm manual-test-note.txt`。

**F2 交互拒绝（硬停止）**
```bash
$WF run 07-checkpoint-demo.js --model $MODEL    # 输入 n
```
预期：exit **1**，`checkpoint 被人工拒绝`；manifest=failed；**write-note agent 未执行**（agents 只有 draft + checkpoint）。

**F3 非交互等待态 → resume 批准**
```bash
$WF run 07-checkpoint-demo.js --model $MODEL --non-interactive
echo "exit=$?"                                   # 预期 3
$WF list | tail -1                               # 预期 waiting_checkpoint
RUNID=$(ls -t .pi-workflows/runs | head -1)
printf 'y\n' | $WF resume $RUNID                 # 管道输入 y
```
预期：首跑 exit **3** + `⏸` 提示「resume 后重新询问」；resume 后 exit 0、completed、note 文件生成；**checkpoint 在 resume 后重新询问过一次**（checkpoints.jsonl 中该 id 的 version=2）。

**F4 拒绝的确定性回放**
```bash
# 在 F2 的拒绝 run 上（或重跑 F2 拿 RUNID）
printf 'y\n' | $WF resume $RUNID
```
预期：即使输入 y，仍 exit 1（`人工拒绝（回放）`）——拒绝已记 journal，改 prompt 文本才会重问。

### G 组：持久化与恢复（08-resume-three-nodes.js）

**G1 list / status**
```bash
$WF list
RUNID=$(ls -t .pi-workflows/runs | head -1)
$WF status $RUNID
```
预期：list 表格含各 run 状态（死进程显示 interrupted）；status 输出 scriptHash/argsHash/journal 条数/result 摘要。

**G2 SIGINT 取消**
```bash
$WF run 08-resume-three-nodes.js --model $MODEL --timeout 120000
# 第一个节点完成后按 Ctrl-C
```
预期：`收到 SIGINT，正在取消……`；exit **130**；manifest=cancelled。

**G3 强杀 + resume 回放（核心恢复用例）**
```bash
# 终端 1：观察 journal（等出现 2 行后执行下一步）
RUNID=$(ls -t .pi-workflows/runs | head -1)   # 先启动下面的 run 再取
$WF run 08-resume-three-nodes.js --model $MODEL &
watch -n1 "wc -l < .pi-workflows/runs/$RUNID/journal.jsonl"   # 到 2 时：
kill -9 %1                                    # 强杀
$WF list | tail -1                            # 预期 interrupted
$WF resume $RUNID --yes --non-interactive --model $MODEL
```
预期：resume 日志 `journal 2 条可回放`；结果中 **n1/n2 带「journal 回放」标记且无 tokens**，n3 真实执行有 tokens；exit 0；journal 最终 3 行。

**G4 哈希不匹配拒绝**
```bash
# 用 G3 的 run：修改脚本一个 prompt 后 resume
sed -i '' 's/node-3-done/node-3-CHANGED/' 08-resume-three-nodes.js
$WF resume $RUNID --yes --non-interactive
git checkout -- 08-resume-three-nodes.js      # 还原脚本
```
预期：`[RESUME_MISMATCH] 脚本内容已变化`；exit **2**。

**G5 副作用确认未决拒绝**
```bash
$WF resume $RUNID --non-interactive           # 不带 --yes
```
预期：`非交互模式需显式 --yes 确认`；exit 2（不静默重执行写类副作用）。

### H 组：stop（跨进程终止）

```bash
# 终端 1：长任务
$WF run 08-resume-three-nodes.js --model $MODEL --timeout 120000 &
# 终端 2：
$WF list                                     # 取 running 的 runId 与 pid
$WF stop <RUNID>
```
预期：stop 发 SIGINT→（3s）→SIGTERM；run 终态 cancelled；`$WF status <RUNID>` 确认。

### I 组：事件流（同源/连续）

```bash
RUNID=<任一已完成 run>
cat .pi-workflows/runs/$RUNID/events.jsonl | jq -r '.sequence' | tail -5
cat .pi-workflows/runs/$RUNID/events.jsonl | jq -r '.type' | sort | uniq -c
```
预期：sequence 从 1 **连续递增无断裂**（含 resume 拼接）；类型含 `run.started/node.started/node.completed/agent.session.created/run.completed`（审批 run 另有 `checkpoint.requested/resolved`）。

### J 组：退出码速查（回归确认）

| 场景 | 命令 | 预期 exit |
|---|---|---|
| 完成 | B1 | 0 |
| 超时耗尽（闸门） | `$WF run 09-timeout.js --model $MODEL` | 1（`AGENT_TIMEOUT`→重试耗尽→阶段失败闸门） |
| 非法脚本 | A2/A3 | 2 |
| 审批等待 | F3 首跑 | 3 |
| SIGINT | G2 | 130 |

## 3. V2-P0 应用服务手动测试（无终端全链）

```bash
cd /Users/michaelchang/Desktop/WorkProjects/pi-agentic-workflow
npx tsx dev-examples/manual-test/v2-service-demo.ts $MODEL
```

脚本内置 7 步断言（真实模型）：

| 步骤 | 验证点 | 预期输出 |
|---|---|---|
| 1 start | 无终端启动 | runId 打印 |
| 2 等待审批 | manifest→waiting_checkpoint + checkpoints.jsonl 记录 | `状态=waiting_checkpoint ... v1 status=pending` |
| 3 错误版本 | expectedVersion 不匹配 | `✓ CONFLICT` |
| 4 批准→完成 | 决策唤醒 + 终态 + journal/events 计数 | `状态=completed，journal=3，events=11` |
| 5 幂等重放 | 同决策同版本再提交 | `✓ status=approved（不重复唤醒）` |
| 6 V2 事件映射 | seq 连续 + checkpoint.requested | 前 6 条事件列表 |
| 7 并发限额 | 活跃 run 占额度（等待态不占） | `✓ RUN_LIMIT_REACHED` → 末行 `✅ ... 全部通过` |

终行出现 `✅ V2-P0 应用服务手动测试全部通过`（exit 0）即本组通过。

## 4. 测试记录表（执行时填写）

| 用例 | 结果(P/F) | 证据（runId/输出摘要） | 备注 |
|---|---|---|---|
| A1/A2/A3 | ☐ | | |
| B1/B2/B3 | ☐ | | |
| C1/C2/C3/C4 | ☐ | | |
| D1 | ☐ | | |
| E1 | ☐ | | |
| F1/F2/F3/F4 | ☐ | | |
| G1/G2/G3/G4/G5 | ☐ | | |
| H | ☐ | | |
| I | ☐ | | |
| J | ☐ | | |
| V2 步骤 1–7 | ☐ | | |

## 5. 常见问题

- **`model not found`**：`--model` 用全称 `provider/modelId`；裸 id 需在可用模型中唯一。
- **checkpoint 直接失败而非等待**：确认没有同时给脚本级 `default`（显式默认会直接采用）。
- **resume 报 RESUME_MISMATCH**：脚本或 args 变过；还原或新开 run。
- **G3 kill 时机**：journal 不足 2 行就 kill 属正常中断，回放 0 条也合法；断言核心是「已提交节点不再请求」。
- **端口/环境**：V1 无网络端口；V2-P0 为进程内服务（Web Server 属 V2-P1，未实现）。
