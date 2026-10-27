# WX-MOCK — 微信工作流 Mock 标准化验收

设计：`dev-docs/design/2026-10-27-wechat-mock-标准化验收流程设计.md`（V2）
三层门：Gate A 单测（`node --test`）→ **Gate B 本目录（mock 端到端）** → Gate C 真机抽检。

## 一条命令验收

```bash
# deterministic（零 LLM：Stub 路由 + fixture 工作流，秒级）
python3 dev-examples/manual-test/wechat-mock/engine.py --scenario dev-examples/manual-test/wechat-mock/scenarios/route-smoke.json

# integration（真实 LLM 语义路由/agent 会话）
python3 dev-examples/manual-test/wechat-mock/engine.py --scenario dev-examples/manual-test/wechat-mock/scenarios/approval-pass.json --mode integration
```

全量回归：

```bash
for s in route-smoke keyword-conflict param-extraction execution-success execution-failure checkpoint-resume; do
  python3 dev-examples/manual-test/wechat-mock/engine.py --scenario scenarios/$s.json
done
# integration 两个（approval-pass / approval-reject）加 --mode integration
```

## 超时纪律（硬约束）

- 单步等待 ≤ **180s**（缺省）；特殊步骤 ≤ 300s 且场景须声明 `special.justified + reason`，引擎硬拒 >300s
- 服务就绪 30s；任一步超时立即转储诊断（bot 最后回复/服务日志尾/挂起授权/tasks 尾）并 FAIL
- **超时是诊断信号，不是重试信号**

## 隔离原则

引擎以 `wechat start --mock-client --data <runDir>/data --registry <场景registry>` 起**独立实例**，
服务锁按 dataDir 隔离，与 pm2 生产实例**并存互不触碰**；会话/授权/journal 全部随独立目录天然隔离。

## 场景规范

```jsonc
{
  "name": "…", "mode": "deterministic",          // deterministic | integration
  "registry": "fixtures/registry.json",           // 场景专用 registry（可被 registryPatch 临时改）
  "requiresWorkflows": ["mock-echo"],             // 引擎前置预检（enabled 校验）
  "vars": { "outFile": "{runDir}/work/out.json" },// 两遍渲染（可引用 runDir/runStamp/userId）
  "routeStub": [                                   // deterministic 专用：Stub 路由规则
    { "ifPromptContains": ["…"], "reply": "<IntentRouter JSON，支持 {var}>" } ],
  "steps": [
    { "caseId": "R1", "send": "…",
      "approve": "never | auto | reject",          // auto=批准；reject=拒绝（均带 workflowId 匹配守卫）
      "expect": { "type": "replyContains|taskCompleted|taskFailed|pendingActionStatus|fileSettled", "timeoutSec": 180 },
      "assertFile": ["…"], "assertFileContains": [{ "file": "…", "contains": "…" }],
      "assertJson": { "file": "…", "path": "a.b", "equals|contains": "…" },
      "assertAbsent": ["…"], "assertPending": { "workflowId": "…", "status": "executed", "argsContain": ["…"] } },
    { "caseId": "X1b", "kind": "kill" },           // 特殊步骤类型：kill / restart / resumeRun
    { "caseId": "X1d", "kind": "resumeRun", "workflowId": "…" } ]
}
```

## 核心 8 场景（P2 基线，全绿基线 2026-10-27）

| caseId | 场景文件 | 覆盖 |
|---|---|---|
| R1 | route-smoke | 路由识别 → 分发 → 执行 → 产物 |
| R2 | keyword-conflict | demo 靶子在册时真实流程仍胜出（1b5c968 回归） |
| R3 | param-extraction | 参数提取与产物逐字一致 |
| A1 | approval-pass (integration) | 审批卡 → 显式批准 → PendingAction executed → 产物 |
| A2 | approval-reject (integration) | 拒绝 → rejected → 零执行 |
| E1 | execution-success | Run completed + 产物 |
| E2 | execution-failure | Run failed + 错误双源断言（tasks/run-manifest） |
| X1 | checkpoint-resume | kill → interrupted → resume → journal 回放不重执行 |

## 新工作流接入清单（Gate B 过门条件）

1. 场景 JSON 与工作流同 PR（deterministic 优先；涉及真实 LLM 语义才用 integration）
2. registry 注册项 enabled + keywords 含 ≥2 个短词（query-contains-keyword 检索语义）
3. 引擎全 PASS + report.json 归档（reports/ 已 gitignore）
4. 真机抽检（Gate C）留里程碑级

## 已知边界

- fixture workflow 禁用 `check(布尔, …)`（check 条件须为函数）；脚本 throw 由 runtime 捕获转 run.failed
- 微信传输线协议与真实用户绑定不在 mock 覆盖内（Gate C）
- `pi-workflow resume` 与微信「确认恢复」同一 runtime 恢复语义（后者为 agent 模式确定性通道）
