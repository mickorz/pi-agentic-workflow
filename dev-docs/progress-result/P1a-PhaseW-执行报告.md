# P1a Phase W（ObsidianWriter）执行报告

- 阶段：P1a · Phase W — Writer 写面（方案 `dev-docs/design/2026-10-23-p1a-obsidian-service-执行方案.md` §2/§3）
- 日期：2026-10-24
- 状态：✅ 完成（Mac 侧）；Windows 门禁/真机验收属 Phase 0/V 待办

## 交付清单

| 交付物 | 位置 | 说明 |
|---|---|---|
| 写后端 `vault_writer.py` | `dev-examples/wx-article/scripts/draft_manager/vault_writer.py` | 纯 stdlib；create=O_CREAT\|O_EXCL（禁临时文件重命名）、append=O_APPEND（不存在拒绝）；内容 stdin UTF-8 ≤1MB；台账 `<ledger_root>/.obsidian-ops/ledger.jsonl` O_APPEND 单行事件 |
| 幂等台账状态机 | 同上 | started→（fsync 后）done；失败记 failed（干净收口，允许重试）；重试同 operationId：done+同 rel/contentDigest→idempotent 不重复写；done+不一致→invalid 拒绝复用；started-无-done→unknown 禁自动重试（issues 带台账路径，人工核对）；单机单写者假设 |
| 路径安全 | 同上 | rel 校验：.md 结尾、拒 `../`/绝对/反斜杠/控制字符/shell 元字符/隐藏段；safe_target 逐段拒 symlink + resolve 必须在 vault 根内；create 父目录必须存在（不自动建目录）；台账根解析 `--ledger-root > PI_OBSIDIAN_LEDGER_ROOT env > 配置根 > cwd` |
| TS 包装 `obsidian-writer.ts` | `src/runtime/obsidian-writer.ts` | `createObsidianWriter({scriptPath,cwd,env,timeoutMs,vaultRoot,ledgerRoot})` → `createNote/appendNote`；spawn+stdin 传内容（不进 argv/不落日志）；超时/崩溃/坏 JSON→`ok:false`；包装层预检 rel/content/operationId/1MB；注入链 `PI_VAULT_WRITER_PATH`（opts>env>dev 兜底） |
| capabilities 契约三件套 | `src/contracts/wx.ts` / `src/dispatch/registry.ts` / `src/agent-host/digest.ts` | `WorkflowRegistration.capabilities?: string[]`；registry 校验（非空 kebab-case、无重复；`obsidian-write`×`read-only`→拒绝注册）；`computeRegistryDigest` 纳入 capabilities（排序后摘要，顺序无关） |
| 脚本 meta 能力声明 | `src/runtime/types.ts` / `src/runtime/vm.ts` | `WorkflowMeta.capabilities?: string[]`；validateMeta 校验非空 kebab-case 无重复 |
| 运行级授权信号 | `src/application/run-service.ts` / `src/engine.ts` / `src/run-store.ts` / `src/dispatch/dispatcher.ts` | `StartRunOptions.authorized`→`WorkflowInput.authorized`（manifest.options 持久化，resume 恢复）→`WorkflowRunOptions.authorized`；dispatcher 从 `ExecutionAuthorization.authorized` 服务端透传（非 args，禁 `authorized:true` 参数判权） |
| 写能力门 | `src/runtime/workflow-runtime.ts` | DSL globals 注入 `obsidianWrite` **当且仅当** ①脚本 meta 声明 `capabilities:["obsidian-write"]` 且 ②`shared.authorized===true`；缺任一→脚本引用即 ReferenceError；Reader `obsidian` 全 workflow 可用不受影响 |
| facade 写操作预检 | `src/agent-host/task-control-facade.ts` | `OBSIDIAN_OP_KIND` 分派；rel/content 契约校验；确定性冲突探测（create 已存在/append 不存在→审批前报错不建 pending；`>512KB` 读超限也证明存在）；operationId 服务端派生注入（覆盖外部同名）；`resolvedTarget=rel` |
| 审批卡 §2.3 | `src/agent-host/pending-flow.ts` | obsidian 写操作卡片只显示 操作类型+contentDigest 前 8 位+预览 ≤80 字（空白折叠），不回显全文；非 obsidian 流程卡片形态不变 |
| 单测 | `tests/unit/obsidian-writer.test.ts` | 25 用例（下详） |

## 验证证据（Mac）

- `npm run build` 零错误。
- `npx tsx --test tests/unit/obsidian-writer.test.ts`：25/25 PASS。
- 全量 `npm test`：386 tests，385 pass，0 fail（1 平台 SKIP）——不降级。
- P0 回归 `python3 dev-examples/wx-article/scripts/draft_manager/run_resolver_suite.py`：18 PASS + 1 SKIP（同基线）。
- 后端手工验证：create/冲突/幂等重试（文件恰 9 字节不重复写）/同键异内容拒绝/unknown（注入悬置 started）/append/missing/父目录缺失 全部符合契约。

单测覆盖：创建成功（rel/digest/bytes+台账 started→done 成对）、O_EXCL 冲突、幂等重试不重复写、同 operationId 异内容拒绝复用、unknown 禁自动重试（带台账路径）、append 追加不改写、append 不存在 missing、毒字符串/越界 rel 统一 invalid（含 `$(pwd)`/反引号/引号/`;`/`|`/`&`/`<>`、`../`、绝对路径、反斜杠、无扩展名、空 stem/隐藏段、父目录不存在）、1MB 超限 too_large、写脚本注入链 env 通道、DSL 能力门三态（双条件注入可用/无 authorized→ReferenceError 且零写入/无 capabilities→ReferenceError 且零写入）、read-only 形态 Reader 照常、registry capabilities 七态校验、`obsidian-write×read-only` 拒绝、digest 纳入+顺序无关、vm validateMeta 五态、facade 预检（create 冲突不建审批/append 缺失不建审批/operationId 覆盖外部伪造+resolvedTarget/契约拒绝六态/去重同 actionId）、审批卡（digest8+预览≤80+全文不回显；append 文案；非 obsidian 卡不变）。

## 设计偏差记录

1. **operationId 派生**：方案 §2 原文「actionId+rel+contentDigest 派生」。实现改为 `sha256(userId|workflowId|rel|contentDigest).slice(0,16)`：actionId 在 `pending.create` 内部生成，晚于 facade 的 argsDigest 计算——actionId 派生会破坏「同 userId+workflowId+argsDigest 复用 pending」去重（每次重试生成新 actionId→重复审批卡）。改用请求侧稳定派生后，重复发起天然同 operationId 同 actionId。语义不弱化：operationId 仍唯一标识（用户,流程,目标,内容）四元组。
2. **台账根 env 通道**：新增 `PI_OBSIDIAN_LEDGER_ROOT`（--ledger-root > env > 配置根 > cwd），对齐 OBSIDIAN_VAULT_ROOT 注入风格；方案未规定 env 通道，属补齐。
3. **rel 元字符拒绝**：spawn 不走 shell，`$(pwd)`/引号等本无注入风险（仅落成字面文件名）；为 vault 文件名干净可移植，前后端一致拒绝这些字符（测试以「拒绝」为断言，强于方案下限「不注入」）。

## 遗留

- Phase F：obsidian-note-create / obsidian-note-append / obsidian-note-search 三脚本 + 双 registry 注册 + description 路由提示。
- Phase V：真机验收（微信→审批→O_EXCL 创建→检索；幂等重试真机复现）。
- Phase 0 Windows 闸门仍为 Windows 机待办（不阻塞 Mac 推进）。
