# 微信工作流 Mock 标准化验收流程设计（WX-MOCK V2）

> 日期：2026-10-27（V2：吸收评审意见——三层测试/双模式/环境隔离/显式审批/终态断言/结构化失败报告/8 核心场景/实施优先级）
> 定位：所有工作流开发/测试必须先过 mock 验收；真机微信只做抽检。
> 评审采纳状态：6 项建议全部采纳（三层 Gate、Gate B 双模式、5 处设计修改、8 场景先行、目录结构、P0-P4 优先级）。

## 一、目标（评审原文锚定）

> 每次修改 Workflow、Router、授权或执行器之后，能不能不打开微信，就自动验证整个流程是否正常，并且在失败时直接定位到出问题的环节？

开发闭环：**开发功能 → 自动运行 Mock → 结构化失败报告 → Agent 修复 → 重跑 Mock → 通过后真机抽检 → 合并**。

## 二、三层测试门（评审第一节）

| Gate | 内容 | 依赖 | 频率 |
|---|---|---|---|
| A | 单元/契约测试：Router、Registry、参数解析、权限/状态机（现 44 例体系） | 无微信无 LLM | 每次提交 |
| B | WeChat Mock 端到端：模拟消息→路由→授权→执行→终态断言（本设计主体） | mock 通道 ± 真实 LLM | 每次工作流改动 |
| C | 真实微信抽检：登录/收发/绑定/重连 | 真机 | 里程碑级 |

**Gate B 双模式**（评审核心补强）：

| 模式 | 实现 | 用途 | 成本 |
|---|---|---|---|
| `deterministic` | mock 微信 + `--routing-mode legacy`（IntentRouter 关键词通道，**零 LLM**）+ Stub 外部服务（fixture provider/最小测试工作流） | 路由/授权/状态机高频回归，结果确定 | 秒级/零费用 |
| `integration` | mock 微信 + agent 模式（真实 LLM）+ 测试沙箱（`--data` 独立目录 + 真实 provider 或 fake） | 端到端真实 Agent 能力验收 | 分钟级/按需 |

`deterministic` 的关键洞察：仓库已有 `--routing-mode legacy`（IntentRouter 确定性通道），无需新造 LLM stub——legacy 模式天然跳过 agent 会话，正是确定性回归需要的形态。

## 三、P0 代码对齐（评审第二节，最高优先级）

评审核查 GitHub master 未找到 mock 实现属实：mock 通道在**本地提交 `23c1b51`**（2026-10-27，含 mock-client.ts / --mock-client / V8 driver），尚未推送。

| # | 动作 | 验收 |
|---|---|---|
| P0.1 | 推送本地提交到远端 master（含 23c1b51 + 本设计文档） | GitHub master 可见 mock-client.ts 与 --mock-client |
| P0.2 | 核对 master 近期路由修复（1b5c968 demo 关键词抢跑）与 mock 通道无冲突 | route-smoke 场景（见 3.6）在本地通过 |

## 四、设计修订（评审第三节 5 项）

### 4.1 环境隔离：独立测试实例，默认不碰运行中服务（替代 V1 的"停 pm2/恢复"）

- 每次 mock 运行使用独立数据目录：`wechat start --mock-client --data .pi-wechat-mock/<runId> --registry <场景指定 registry>`
- 服务锁按 dataDir 隔离（`--data` flag 已存在，已核实）→ **mock 实例与 pm2 生产实例可并存**，互不触碰
- 独立目录内自带：bound-user.json（绑定测试身份）、pending-actions、inbox journal、agent sessions（会话污染天然隔离，不再需要归档/清理前置）
- 仅当资源无法隔离（端口/浏览器会话类）才进入受控停机模式：记录原服务状态 → 停 → 测 → 按记录恢复
- Run 工作目录（文章目录等）亦用 fixtures 拷贝，不写真实文章目录

### 4.2 授权审批：显式匹配，自动批准仅限白名单场景

- 场景字段 `approval: "explicit" | "auto"`（缺省 explicit）
- **auto 也非绕过**：driver 检出审批卡后必须校验三元组——测试身份（userId 匹配）+ workflowId 匹配 + args 包含场景声明的锚点值（如 article_dir），三元组全中才回「批准」，否则 FAIL 并转储卡片
- 每次批准后断言 PendingAction 真实状态转移：`pending-actions.jsonl` 中该 actionId `pending → executing`（读状态文件，不信回执文案）
- 「拒绝」场景同构：拒绝后断言无 run 产生 + action 状态 rejected

### 4.3 完成判断：Run 终态 + 产物断言为准

- 以 `tasks.jsonl` 中该 taskBindingId 的 `status=completed` 为完成事实源（driver 从批准回执提取 tbId 后轮询状态文件），**bot 回复文本只用于审批卡解析，不作为成功依据**
- 产物断言（assertFile/assertJson）照旧；回复文本命中仅作提前收尾信号，终态不符仍 FAIL

### 4.4 deterministic 模式（见第二节）

- 路由回归/授权状态机/参数提取全部跑 legacy + fixture 工作流，零 LLM、零外部 API、秒级
- `integration` 模式才允许真实 LLM 与真实 provider（生图/文章类全链验收归此模式，配额消耗显式声明）

### 4.5 结构化失败报告

每次运行产出 `reports/<ts>-<scenario>/report.json`：

```json
{
  "scenario": "route-smoke", "mode": "deterministic", "caseId": "R1",
  "runId": "run-mvq…", "verdict": "FAIL", "failedStage": "expect",
  "steps": [{ "caseId": "R1", "expected": "workflowId=github-research", "actual": "workflowId=github-review", "ok": false }],
  "diagnostics": { "lastBotReply": "…", "serviceLogTail": "…", "pendingActions": "…", "tasksTail": "…" },
  "logs": ["mock-service.log", "mock-outbox.jsonl", "report.json"]
}
```

- stdout 保持 `PASS/FAIL` 文本契约（仓约定）+ 单行 report.json 路径——Agent 可直接读结构化报告定位，不翻千行日志

## 五、8 个核心回归场景（评审第四节，第一批）

全部用最小 fixture 工作流 / Stub 外部服务，`deterministic` 模式，不消耗真实图片 API：

| caseId | 场景 | 断言核心 |
|---|---|---|
| R1 路由识别 | 用户输入命中正确 workflowId | 分发的 workflowId == 预期 |
| R2 关键词冲突 | demo 流程不得抢跑真实流程（1b5c968 回归固化） | 冲突输入分发给真实流程 |
| R3 参数提取 | GitHub URL / 文章目录等参数正确进入 args | args 字段逐个比对 |
| A1 授权通过 | 产生审批 → 批准 → 执行 | PendingAction pending→executing + run 启动 |
| A2 授权拒绝 | 拒绝后不启动 Workflow | action rejected + 零 run |
| E1 执行成功 | Run completed 且产物存在 | tasks 终态 + assertFile |
| E2 执行失败 | 失败返回可诊断错误 | tasks 终态 failed + 错误信息结构化 |
| X1 中断恢复 | 恢复后不重复执行已完成步骤 | 恢复链重放/续跑断言（复用 A09 语义） |

fixture 工作流：最小 Node/JS workflow（如 am-p0 现有 demo 改造或新建 `mock-echo`），注册于 `scenarios/fixtures/registry.json`（场景专用 registry，与生产 registry 解耦）。

## 六、目录与接口（评审第五节）

```
dev-examples/manual-test/wechat-mock/
  engine.py               # 通用引擎（重构自 wechat-mock-driver.py）
  scenarios/              # 场景 JSON（8 核心 + 业务全链）
    fixtures/             # fixture 工作流 + 场景专用 registry + 测试文章目录模板
  reports/                # 运行报告与产物副本（gitignore）
  README.md               # 场景规范与运行手册
```

运行方式（--mode 为新增接口）：

```bash
python3 dev-examples/manual-test/wechat-mock/engine.py --scenario scenarios/route-smoke.json --mode deterministic
python3 dev-examples/manual-test/wechat-mock/engine.py --scenario scenarios/github-research.json --mode integration
```

保留 V1 已验证的设计：Python stdlib、JSON 场景、assertJson/assertFile、启动横幅就绪判定、进程树托管。不引入复杂 DSL。

## 七、实施优先级（评审第六节）

| 阶段 | 工作 | 验收要求 |
|---|---|---|
| P0 | 对齐代码（推送 23c1b51）+ 隔离方案验证（--data 独立目录起服务，pm2 不受扰） | 不影响运行中 WeChat Bot |
| P1 | 泛化 Driver → engine.py + JSON 场景引擎 + report.json | 自动执行 + 结构化报告 |
| P2 | 8 个核心回归场景（deterministic，fixture 工作流） | 全过、失败可定位 |
| P3 | 接入真实流程（github-research / article-image-generate 全链，integration 模式） | 真实 Agent 链路自动跑通 |
| P4 | WX-MOCK 写入 CLAUDE.md（手动测试约定第 6 条） | 开发完成后必须先过 mock |

暂不做：CI、并行测试、可视化平台。

## 八、与 V1 差异速览

| 项 | V1 | V2（本版） |
|---|---|---|
| 测试分层 | Gate A/B/C 三层（同） | Gate B 内分 deterministic/integration 双模式 |
| 服务隔离 | 停 pm2 → 测 → 恢复 | 独立 --data 实例，并存不互扰；受控停机仅兜底 |
| 审批 | autoApprove 关键词触发即批 | 三元组显式匹配 + PendingAction 状态转移断言 |
| 完成判定 | expect 文本命中 | tasks.jsonl Run 终态 + 产物断言为准 |
| 场景 | 生图 V8 单场景迁移 | 8 核心回归场景先行（fixture，零费用），业务全链 P3 |
| 失败输出 | 文本诊断 | report.json 结构化（caseId/runId/expected/actual/stage/logs） |
| 代码基线 | 未声明 | P0 先对齐（本地 23c1b51 推送远端） |

## 九、引用说明

- 评审意见：2026-10-27 WX-MOCK V1 评审（三层测试/双模式/隔离/显式审批/终态断言/8 场景/P0-P4）
- 实践来源：`dev-docs/progress-result/P1.6-执行报告.md`（V8-mock 实践与 4 问题）
- 通道实现（本地待推送）：commit `23c1b51`（src/gateway/wechat/mock-client.ts、wechat.ts --mock-client）
- 路由冲突修复参照：commit `1b5c968`（demo 关键词抢跑真实流程——R2 场景的回归靶点）
- 约定挂载点：`CLAUDE.md` 手动测试约定（P4 新增第 6 条）
