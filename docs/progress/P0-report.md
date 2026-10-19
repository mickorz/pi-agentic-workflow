# P0 执行报告 — CLI + Pi SDK + 基础 DSL

```text
Phase: P0
Target HEAD before: 8c87c4a1a0a4fbdc6c61ac93305020008eaab7fa
Target HEAD after: 本阶段 commit（见 git log P0 提交）
Source pinned SHA: 3373d1ae9c5f4adeaaea5d223582532410fba8f3 (opencode-dynamicworkflows v0.11.2)
Pi SDK version: @earendil-works/pi-coding-agent@1.3.0 (npm ^1.2.0 解析结果)
```

## 交付清单

| 类别 | 文件 |
|---|---|
| runtime | `src/runtime/{errors,semaphore,vm,node-contract,agent-result,types,workflow-runtime}.ts` |
| 注入缝 | `src/agent/session-runner.ts`（AgentSessionRunner 接口，零 Pi 依赖） |
| Pi Adapter | `src/adapters/pi/{tool-profiles,model-resolver,pi-agent-adapter}.ts` |
| CLI | `src/cli/index.ts` + `src/cli/commands/{run,validate}.ts`（bin: pi-workflow） |
| 公共 API | `src/index.ts`（Core 不依赖 CLI） |
| 示例 | `examples/{smoke,parallel,sequence}.js` |
| 测试 | `tests/unit/{vm,parallel,sequence,agent,tool-profiles}.test.ts`（32 用例）+ `tests/integration/pi-adapter.test.ts`（4 用例） |
| 文档 | `docs/migration/source-map.md`、`docs/DSL.md`、`docs/CLI.md` |

P0 原语：`agent`（配额/超时/重试/中止/用量统计/sessionId 回填）、`parallel`（塌缩 null）、`sequence`（composite 三态）、`phase`/`log`/`args`/`setConcurrency`、阶段失败闸门。

## 验收结论

| 项 | 结果 | 证据 |
|---|---|---|
| P0-01 validate 拒绝错误 meta/非法脚本 | ✅ | unit vm.test.ts（8 用例）+ CLI 实测：合法 exit 0 / 非法 exit 2 |
| P0-02 smoke 真实 Agent 完成且结果非空 | ✅ | integration P0-02（glm-5.3-flash，4.2-8.5s，结果 "pi-workflow smoke ok"） |
| P0-03 parallel 真实重叠 + 次序稳定 | ✅ | unit parallel.test.ts（150ms 延迟重叠判定 + 乱序完成按索引返回） |
| P0-04 sequence 第二节点收到前项结果 | ✅ | unit sequence.test.ts（echo:got:echo:first 链） |
| P0-05 explore 不可写 / general 可写 | ✅ | integration P0-05/05b：隔离 tmp 目录，explore 后无 pwned.txt；general 后 made.txt 存在 |
| P0-06 失败/取消不伪装成功 | ✅ | unit（abort→WORKFLOW_ABORTED、超时→闸门、模型缺失→失败）+ integration（model not found）|
| P0-07 build/typecheck/test 全绿 + bin 可用 | ✅ | 见下方命令；`node dist/cli/index.js validate` 实测通过 |

```text
Test commands:
  npm run typecheck   # tsc --noEmit → 0 错误
  npm run build       # tsc → dist/ 生成
  npm test            # tsx --test tests/unit/*.ts → 32 pass / 0 fail
  PI_WORKFLOW_INTEGRATION=1 npm run test:integration  # 4 pass / 0 fail（真实 glm-5.3-flash）
  npx tsx src/cli/index.ts run examples/smoke.js --model cc-switch-zhipu-glm/glm-5.3-flash
  # → ✅ 完成（run=run-mvfe7ddx，1 agent，14.8s，tokens=3103，exit 0）

Offline tests: 32 passed / 0 failed / 0 skipped（另有 integration 4 用例需凭证）
Real SDK tests: 4 passed / 0 failed（模型 cc-switch-zhipu-glm/glm-5.3-flash；Node v25.6.1, macOS）
Key evidence: 见上表；CLI 真实运行输出与 token 统计齐全
Known limitations:
  - schema 结构化输出为本地解析（无完整 JSON Schema 校验，P1 补）
  - 无 journal/resume/checkpoint（P2）；无 fallback/race/workflow/check/verify/retry（P1）
  - stop 仅支持本进程 SIGINT（跨进程属 P2）
  - 集成测试仅在 macOS + Node 25 实测；Windows/Linux 基础验证待 P3
Push result: 已 push 到 origin/master
Gate: PASS
```

## 兼容性决策（详见 docs/migration/source-map.md）

- sequence 对 agent 耗尽失败的 null 传递语义与参考实现一致（闸门终止，非序列中断）。
- 未知 agentType 结构性报错；tier 不迁移；sessionId 为 adapter UUID。
