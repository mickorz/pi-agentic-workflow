# P1 执行报告 — 控制流 + 自动验收

```text
Phase: P1
Target HEAD before: fd61441（P0 提交）
Target HEAD after: 本阶段 commit（见 git log P1 提交）
Source pinned SHA: 3373d1ae9c5f4adeaaea5d223582532410fba8f3 (opencode-dynamicworkflows v0.11.2)
Pi SDK version: @earendil-works/pi-coding-agent@1.3.0
```

## 交付清单

| 类别 | 内容 |
|---|---|
| 控制流 | `fallback`（串行竞争+闸门归因）、`race`（首胜+局部中止面取消兄弟）、`workflow`（子流程：自环/深度/structuredClone/共享配额与并发） |
| 自动验收 | `check`（三态语义）、`verify`（对抗式评审，独立 session，schema 结构化输出）、`retry`（有界重试糖）、`fileExists`/`commandSuccess` |
| Schema | `src/adapters/pi/schema-validator.ts`：JSON Schema 子集完整校验（type/required/properties/items/enum/范围/长度/additionalProperties，嵌套路径报告） |
| 路径解析 | workflow() 相对路径**父脚本目录优先**、cwd 次之；runWorkflow 新增 `scriptPath` 选项，CLI 自动传入 |
| 示例 | `examples/quality-gates.js`、`examples/nested.js` + `examples/nested-child.js` |
| 测试 | 单元 73 用例（新增 fallback 6 / race 5 / workflow-child 6 / check-helpers 7 / verify 4 / schema-validator 9 / retry 5） |
| 文档 | DSL.md（P1 原语）、migration/compatibility.md（DSL 兼容清单）、source-map 更新 |

## 验收结论

| 项 | 结果 | 证据 |
|---|---|---|
| P1-01 fallback 可恢复失败换候选；结构性错误直接抛 | ✅ | fallback.test.ts（含 null+登记归因回滚） |
| P1-02 race 仅成功分支获胜、失败不获胜、其余被取消 | ✅ | race.test.ts（slow 分支收到 abort） |
| P1-03 嵌套 workflow 无死锁、共享并发、阻断循环 | ✅ | workflow-child.test.ts（并发峰值≤上限、自环/深度阻断、journal key 含 wf0 段） |
| P1-04 check 编译失败不报告 success | ✅ | check-helpers.test.ts（sequence 停止 + deploy 不执行） |
| P1-05 verify 独立 Agent Session、预定义语义 | ✅ | verify.test.ts（3 reviewer 3 session）+ 真实运行 votes 结构 |
| P1-06 Schema 缺字段/类型错误被拒绝（嵌套级） | ✅ | schema-validator.test.ts（.meta 缺键、tags[1] 类型、.meta.source 类型） |
| P1-07 可取消/不可恢复/可恢复的重试次数正确 | ✅ | retry.test.ts（3 次尝试、结构性 1 次、取消 1 次） |

```text
Test commands:
  npm run typecheck        # 0 错误
  npm run build            # OK
  npm test                 # 73 pass / 0 fail
  PI_WORKFLOW_INTEGRATION=1 npm run test:integration  # 4 pass / 0 fail
  npx tsx src/cli/index.ts run examples/nested.js --model cc-switch-zhipu-glm/glm-5.3-flash --timeout 120000
  # → ✅ 2 子流程并行完成（4.9s，tokens 3144/3127，key=wf0/wf1）
  npx tsx src/cli/index.ts run examples/quality-gates.js --model cc-switch-zhipu-glm/glm-5.3-flash --timeout 120000
  # → ✅ check 通过 + verify 2/2 real=true（9.5s，votes 含 reason）

Offline tests: 73 passed / 0 failed / 0 skipped
Real SDK tests: 4 passed + 2 个真实示例端到端（glm-5.3-flash）
Known limitations:
  - workflow() 名字引用 registry 未实现（仅显式路径）
  - judgePanel/pipeline 未迁移（backlog）
  - schema 校验不支持 $ref/allOf/patternProperties（按需加）
Push result: 已 push 到 origin/master
Gate: PASS
```

## 兼容性决策（详见 docs/migration/compatibility.md）

- workflow() 路径解析改为**父脚本目录优先**（有意改进，CLI 场景更直观；参考实现仅 cwd）。
- fallback 全部候选耗尽 → 返回 null 且 run 正常结束（fallback 是显式降级吸收机制，与参考闸门归因语义一致）。
