# VR-阶段B 执行报告 — Runtime 原生 vaultResolve() 安全接入

> 阶段：VR（VaultResolver 跨设备路径解析）阶段 B · 2026-10-23
> 方案基线：dev-docs/design/2026-10-23-vault-resolver-执行方案.md §S3.1（含补丁 #11/#14）
> 范围：TS 解析辅助模块 + runtime DSL 注入 `vaultResolve()` + 单测（含仓库外 cwd）+ build。不含 workflow 接线与审批预检（阶段 C）。

## 交付清单

| 文件 | 说明 |
|---|---|
| `src/runtime/vault-resolver.ts`（新） | TS 解析辅助：注入链三级解析 + python 探测 + `vaultResolve()` execFile argv 直调（零 shell 拼接） |
| `src/runtime/workflow-runtime.ts` | `WorkflowRunOptions.vaultResolver`（scriptPath/env/timeoutMs）→ `SharedRunContext` 透传 → globals 注入 `vaultResolve(ref, {scope?, want?})` |
| `tests/unit/vault-resolver.test.ts`（新） | 19 用例：注入链 5 + 语义 7 + 非法入参 1 + DSL 接线 6 |

## 关键实现（对照方案 §S3.1 + #14）

- **注入链三级**：`opts.scriptPath`（测试专用，最高优先）> 环境变量 `PI_VAULT_RESOLVER_PATH`（唯一正式部署通道，CLI/微信服务/恢复执行统一走宿主环境）> dev 兜底 `<cwd>/dev-examples/wx-article/scripts/draft_manager/vault_resolver.py`。env/opts 均相对 cwd 解析后再存在性检查。
- **三级落空/脚本不存在 → 配置类结构性 throw**，报错文案指引设置 `PI_VAULT_RESOLVER_PATH`（npm 包不含 dev-examples，不假定 cwd 是仓库根）；单测覆盖仓库外 tmp cwd。
- **python 探测**：`python3` 优先，ENOENT/执行异常回退 `python`（Windows Store 桩场景），二进制名缓存；两者皆缺 throw。
- **错误语义严格分离**：配置类（脚本缺失/python 缺失）throw；语义失败（零命中/歧义/越界/大小写不符 → resolver 输出；超时/异常退出/JSON 损坏 → 合成为 `{ok:false, issues:[...]}`）一律返回不抛，由 workflow 侧 `await check(() => r.ok, ...)` 转 CHECK_FAILED（#11）。
- **DSL 接线**：`vaultResolve(ref, {scope?, want?})` 非 `agent()` 通道、不进并发闸门；opts 非 object / ref 空 / want 非法 → 确定性 `{ok:false}` 不抛错。

## 验收结果

- `tests/unit/vault-resolver.test.ts`：**19/19 pass**（macOS，python3）
  - 注入链：opts>env>dev 优先级、三级落空报错含 `PI_VAULT_RESOLVER_PATH`、opts/env 指向不存在脚本报错
  - 语义（真实脚本+fixture+仓库外 cwd）：唯一文章定位（`resolved_rel=公众号/AI入门/单篇`, `md=唯一.md`）、歧义双候选绝不猜、scope 硬约束、大小写逐段校验提示 Prompt.md、shell 元字符 ref 全字面量（按路径不存在处理，零执行）、超时 ok:false、环境变量通道仓库外解析成功
  - DSL：`await check` 通过链路（下游 agent 执行）、失败链路（CHECK_FAILED → sequence 停止 → **publish agent 零执行**，#11 下游零写入断言）、锚点一致通过/漂移中止（S4.3）、配置缺失结构性报错
- `npm run build`（tsc）零错误；全量 `npm test`：324 tests，323 pass，0 fail，1 skip（既有平台条件跳过，非本阶段引入）

## 经验与注意

- resolver 语义失败（ok:false）与配置失败（throw）必须分离：前者经 `await check()` 成为可恢复 FAILURE 走重试/人工，后者是部署错误必须立刻暴露——混同会让「没配 PI_VAULT_RESOLVER_PATH」被误判为「文章找不到」。
- 空字符串回显：resolver 对缺失字段输出 `""` 而非省略，TS 侧断言用 falsy 判断而非 `=== undefined`。
- Windows python3 常是 Store 桩（`--version` 异常退出而非 ENOENT），探测要同时把非 ENOENT 失败也视为「换下一个候选」。

## 遗留与下一步

- 阶段 C：S3.2 article-inspect 接线（两处 `await check()`）+ S4.2/S4.3 facade 审批前预检、服务端锚点（`vault_ref_pinned_rel` 覆盖外部参数、先锚点后 argsDigest）、审批展示服务端确定性生成 + S4.4 Registry 契约三件套（contracts/registry/digest）+ 审批链单测。
- 阶段 D：两份 registry required 清空 + anyOfArgs + description。阶段 E：A 类两机 Resolver 验收 + B 类 Windows 业务闭环 + 文档双更新。
- Mac 单测依赖 python3（无 python 环境自动 SKIP 执行类用例，注入链纯路径用例仍跑）。
