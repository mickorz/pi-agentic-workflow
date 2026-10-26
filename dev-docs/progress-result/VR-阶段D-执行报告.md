# VaultResolver 阶段 D 执行报告（Registry 与微信路由 + 四脚本接线）

- 日期：2026-10-23
- 方案：`dev-docs/design/2026-10-23-vault-resolver-执行方案.md`（V1.2 + 修订记录 #16）
- commit：`6ba2d82`（首次误提交 46961fb 卷入用户暂存 .gitmodules+wewrite，已 soft reset + pathspec 重提交修复；教训见 `dev-docs/experience/git-commit-sweeps-user-staged-entries.md`）
- 范围：S4.1（两份 registry）+ S3.2 剩余四脚本接线 + facade 双通道名扩展
- 前置：阶段 A（resolver+门禁 17/17）、B（runtime 原生 vaultResolve 19/19）、C（facade 预检+锚点+审批卡 11/11）均已合入

## 交付清单

| 文件 | 变更 |
| --- | --- |
| `src/agent-host/task-control-facade.ts` | 新增 `VAULT_REF_CHANNELS={vault_ref:'article', vaultRef:'dir'}`；预检按通道名映射 want（outline 用 vaultRef→dir，文章流用 vault_ref→article）；锚点参数统一 `vault_ref_pinned_rel`；error 文案统一『目标定位失败（未创建审批，请向用户确认后重试）』 |
| `dev-examples/wx-article/scripts/wechat_md_to_draft.js` | 增 vault_ref/vault_scope/vault_ref_pinned_rel 三参；phase('文章定位') vaultResolve(want=article)+await check×2（定位失败/锚点不一致）；正文/发布 agent 全部改用解析后 articleDir |
| `dev-examples/wx-article/scripts/article_prepare.js` | 同上接线（定位段置于 try 内，保证中断兑底通知覆盖定位失败）；存量缺陷同修：局部 `check`/`check2` 遮蔽 DSL 内建 check() → 改名 inspectResult/inspectResult2；checkArgs 改用解析后 articleDir |
| `dev-examples/wx-article/scripts/article_publish.js` | 同 prepare 接线；`check` → inspectResult；发布命令 cover 取 inspectResult.cover_path |
| `dev-examples/wx-article/scripts/obsidian_outline.js` | 增 vaultRef 通道（want=dir，resolved_path 反斜杠归一）；meta.phases 增首相位『目录定位』；双通道全缺 → throw『缺少定位参数: vaultDir(绝对路径)或 vaultRef(Obsidian 逻辑引用)至少一个』 |
| `dev-examples/wx-article/registry.json` | obsidian-outline required[vaultDir]→[]、anyOfArgs[vaultDir,vaultRef]；wechat-md-to-draft required[article_dir]→[]、anyOfArgs[article_dir,vault_ref]；article-inspect/prepare/publish anyOfArgs[article_dir,vault_ref,article_name]；5 条目均增 vault 通道三字段+description 定位规则+书名号 examples |
| `dev-examples/am-p0/registry.json` | 同步 5 条目（聚合注册表，wechat start 实际加载入口） |
| `tests/unit/vr-approval.test.ts` | +6 用例 → 17：facade vaultRef 通道正负（want=dir 锚点+审批目标=newsky/AI提问技巧；失败 error 不建 pending）；两份 JSON loadFromFile 零 issues + required[]/anyOfArgs/通道字段/description 契约断言；md_to_draft/publish vault 定位+early-exit 集成（零副作用路径，仅首 agent 执行）；prepare/outline parseWorkflowScript+首相位断言 |

## 验证

- `npx tsx --test tests/unit/vr-approval.test.ts` → 17/17 PASS
- `npm run build` → 零错
- `npm test` 全量 → 341 tests / 340 pass / 1 既有平台 skip
- registry JSON 更新经 `git diff` 核对：纯语义增改，无格式扰动

## 关键决策

1. **通道名与 want 的映射显式枚举**（vault_ref=article / vaultRef=dir），不做通用框架——评审认可的「文章流程专用轻量预检」精神延续；锚点参数名统一 `vault_ref_pinned_rel`（服务端注入覆盖外部值），outline 也不例外。
2. **description 承载路由提示**：searchWorkflows 仅返回 5 字段（id/name/description/requiredArgs/riskLevel）达 agent，跨字段定位规则必须写进 description（examples 补书名号示范，含锁定验收场景句式）。
3. **prepare 定位段置于 try 内**：定位抛错也走 notify('interrupted') 中断兑底，与既有外部调用失败语义一致。
4. **存量 TDZ 缺陷同修**：prepare/publish 与 inspect 同病（局部 `const check` 遮蔽 DSL 内建 check()），接线顺带全修，`await check()` 不再 ReferenceError。

## 经验与坑

- DSL 脚本顶层 `return` 使 `node --check` 天然报错——语法校验必须走 `parseWorkflowScript`（runner 包装执行）。
- 阶段 C 教训延续：DSL 局部变量禁止与注入全局同名（check/agent/phase/log/vaultResolve/workflow/commandSuccess/args）；本阶段把 prepare/publish 的存量违例一并清零。

## 下一步（阶段 E · 真机验收）

- A 类：Windows + Mac 两机 Resolver 验收（同一逻辑引用，`run_resolver_suite.py` + 真实 vault 解析；不受公众号凭证影响）。
- B 类：Windows 业务闭环（锁定场景「帮我检查一下《AI提问技巧》这篇公众号文章，然后放到草稿箱」全程零绝对路径：微信 → 审批卡（含 resolvedTarget）→ 批准 → 锚点一致 → 草稿创建）+ Mac 验到凭证缺失报错 + 旧入参（article_dir/vaultDir 绝对路径）回归。
