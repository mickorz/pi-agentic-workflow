# VR-阶段C 执行报告 — workflow 接线与审批预检（S4.2/S4.3/S4.4/#12 + S3.2）

> 阶段：VR（VaultResolver 跨设备路径解析）阶段 C · 2026-10-23 · commit `233786b`
> 方案基线：dev-docs/design/2026-10-23-vault-resolver-执行方案.md §S4.2/S4.3/S4.4 + §S3.2（含补丁 #11/#12/#13）
> 范围：anyOfArgs Registry 契约三件套 + facade 审批前预检（服务端锚点/resolvedTarget）+ 服务端确定性审批卡 + article_inspect.js vault_ref 通道接线。不含 registry 文件改写（阶段 D）与真机验收（阶段 E）。

## 交付清单

| 文件 | 说明 |
|---|---|
| `src/contracts/wx.ts` | `WorkflowRegistration.anyOfArgs?: string[]`（声明式跨字段「至少一」约束） |
| `src/dispatch/registry.ts` | register() 校验：非空字符串数组、条目必须存在于 `argsSchema.properties` |
| `src/agent-host/digest.ts` | `computeRegistryDigest` 行数据纳入 anyOfArgs（排序；规则变更 → 旧审批失效） |
| `src/agent-host/types.ts` | `PendingAction.resolvedTarget?`；`WorkflowExecuteResult` needsApproval 分支带 `resolvedTarget?` |
| `src/agent-host/pending-action.ts` | `CreatePendingActionInput.resolvedTarget` 透传持久化 |
| `src/agent-host/task-control-facade.ts` | S4.2/S4.3 预检主逻辑；deps 增 `vaultResolver`（scriptPath/cwd/env/timeoutMs/vaultRoot）与 `onPendingCreated` 回调 |
| `src/agent-host/pending-flow.ts` | `renderPendingActionApproval()` 纯函数（三要素确定性文案） |
| `src/gateway/wechat-app.ts` | facade 接 `onPendingCreated` → 创建即推审批卡；重启补扫对存量 pending 重发（CV-004 同款） |
| `dev-examples/wx-article/scripts/article_inspect.js` | S3.2 接线：vault_ref/vault_scope/vault_ref_pinned_rel 三参 + 定位 phase（vaultResolve + await check×2 + 锚点比对）；修复存量 TDZ 缺陷 |
| `tests/unit/vr-approval.test.ts`（新） | 11 用例：registry 契约 1 + digest 1 + facade 预检 5 + 审批卡 2 + 真实 workflow 文件接线 2 |

## 关键实现（对照方案 §S4.2/S4.3/S4.4 + #12）

- **S4.4 三件套**：类型 + 校验 + 摘要。`anyOfArgs` 条目必须在 argsSchema.properties 内（防注册 typo 造成预检通道名对不上）；摘要排序后纳入（顺序无关、语义相关）。
- **S4.2 审批前预检**（facade 高风险分支，`pending.create` 之前）：
  - anyOfArgs 声明的通道（article_dir/vault_ref/article_name）全部缺空值 → `error` 返回给 Agent，**不创建审批项**——用户不会看到「批准 → 执行 → 才发现缺参」的空转授权。
  - vault_ref 通道存在时先做确定性解析（want=article；scope 取 args.vault_scope）：配置类错误（脚本/python 缺失）catch 转 error；语义失败/歧义 → error 携带 issues/candidates，**不创建审批项**。
  - 解析成功 → 服务端锚点 `vault_ref_pinned_rel = resolved_rel` **覆盖外部同名参数**（#12：不信任 LLM 传入锚点），且在 `computeArgsDigest` **之前**注入——审批快照与执行参数严格一致。
- **S4.3 目标绑定**：锚点随 args 快照进入 PendingAction；批准后执行时 workflow 内新鲜解析与锚点比对（article_inspect.js 内 `await check`，不一致 → CHECK_FAILED 中止，要求重新授权）。
- **#12 确定性审批卡**：`renderPendingActionApproval`（流程/目标/编号三要素 + 批准/拒绝指引）；gateway 经 `onPendingCreated` 在创建即推送，不经 LLM 组织文案；重启补扫对存量 pending 重发。去重分支复用已有 actionId 时同样返回 resolvedTarget。
- **兼容性**：未声明 anyOfArgs 的存量 workflow 走原路径（预检整段跳过）；read-only 分支不变。存量测试全绿佐证。
- **S3.2 接线 + 存量缺陷修复**：article_inspect.js 原 `const check = await agent(...)` 局部变量 **TDZ 遮蔽 DSL 内建 `check()`**——新增的定位阶段 `await check(...)` 会抛 `ReferenceError: Cannot access 'check' before initialization`。改名 `inspectResult` 修复，并以注释固化命名约束。

## 验收结果

- `tests/unit/vr-approval.test.ts`：**11/11 pass**（macOS，python3）
  - registry：anyOfArgs 非数组/空数组/空串条目/条目不在 properties 全部拒绝注册，合法通过
  - digest：anyOfArgs 顺序无关；规则变更/有无 anyOfArgs 摘要均变化
  - facade：三通道全空 → error 不建 pending；vault_ref 歧义 → error 带候选不建 pending；解析成功 → 服务端锚点覆盖外部伪造锚点、argsDigest 与锚点后参数一致、onPendingCreated 触发；article_dir 通道 → 不做 vault 解析（兼容）；同参重试去重同 actionId
  - 审批卡：三要素齐备；无 resolvedTarget 不渲染目标行
  - 接线（真实 article_inspect.js + fixture vault + structured runner）：vault_ref 全链路（定位→锚点一致→检查 agent 执行 1 次、定位日志正确）；锚点漂移 → CHECK_FAILED 中止且检查 agent **零执行**
- `npm run build`（tsc）零错误；全量 `npm test`：**335 tests，334 pass，0 fail，1 skip**（既有平台条件跳过，非本阶段引入）

## 经验

- DSL 变量命名约束：workflow 脚本内局部变量禁止与注入的全局（check/agent/phase/log/vaultResolve/args…）同名，const 声明会以 TDZ 遮蔽全局函数且只有先于声明调用才炸——静态看不出来。已在 article_inspect.js 注释 + 本报告固化；阶段 D/E 改其余 4 个 workflow 时沿用。
- 测试定位仓库资源勿用 `import.meta.dirname`（tsx --test 下不可靠），沿用 `path.resolve("dev-examples/…")` cwd 相对定位（与 vault-resolver.test.ts 一致）。

## 遗留 → 阶段 D/E

- 阶段 D：两份 registry（wx-article + am-p0 聚合）required 清空 + anyOfArgs + description 提示三通道；其余 4 个 workflow（md_to_draft/prepare/publish/obsidian_outline）按需接 vault_ref。
- 阶段 E：真机验收（§6 拆分：A 类 Resolver 两机 / B 类业务闭环 Windows）；微信端到端「帮我检查一下《AI提问技巧》这篇公众号文章，然后放到草稿箱」。
