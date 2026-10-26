# P1a Phase R 执行报告 — ObsidianReader 只读层

- 日期：2026-10-24
- 方案：`dev-docs/design/2026-10-23-p1a-obsidian-service-执行方案.md` §1/§4/§5/§6（Phase R）
- 范围：vault_query.py 后端 + `src/runtime/obsidian-reader.ts` + workflow DSL `obsidian` 全局注入 + 单测；**只读层，无写入面**

## 交付清单

| 文件 | 内容 |
|------|------|
| `dev-examples/wx-article/scripts/draft_manager/vault_query.py`（新） | 查询后端，纯 stdlib。`--action list/read/search` + `--path/--query/--scope/--mode/--limit/--vault-root/--budget-ms`；stdout 单 JSON、退出码恒 0，语义由 `ok` 字段承载 |
| `src/runtime/obsidian-reader.ts`（新） | ObsidianReader TS 层：`listNotes/readNote/searchNotes`；`PI_VAULT_QUERY_PATH` 三级注入链（opts > env > dev 兜底，对齐 vault-resolver 模式）；camelCase→kebab 旗标转换；maxBuffer 8MB；超时/崩溃/坏 JSON → `ok:false` |
| `src/runtime/workflow-runtime.ts`（改） | `WorkflowRunOptions.obsidian` + `SharedRunContext.obsidian` + globals 注入 `obsidian`（§3：读面全 workflow 可用，无 capability 门） |
| `tests/unit/obsidian-reader.test.ts`（新） | 30+ 用例：注入链×4、list/search/read 契约、DSL 注入×2 |
| `.gitignore`（改） | 追加 `obsidian.config.json`、`.obsidian-ops/`（§5） |

## 关键契约落地（§4）

- **列表**：`{total, truncated, items:[{path,title,snippet≤120,mtime}]}`；limit 缺省 20、上限 200；**路径字典序排序**（确定性，两次调用输出全等——写进单测）；`skipped_large` 计 >2MB 跳过文件且不计入 total。
- **扫描预算**：缺省 10s（`--budget-ms` 测试旗标可压 0）；超时 → `truncated:true + truncated_reason:"scan_budget"`（单测以 budget=0 断言）。
- **readNote**：≤512KB 全文返回；超限 `ok:false` 且 issues 带实际尺寸；`../`、绝对路径、symlink 目标、非 .md 确定性拒绝。
- **searchNotes**：`mode name|content|both`，大小写不敏感（小写 query 命中中英混合标题与正文）；零命中是确定性 `ok:true + total:0`；snippet ≤120 字且含命中窗口。
- **scope**：硬约束过滤 + scope_aliases 别名先行；scope 不存在 → `ok:false`。
- **配置链（§5）**：`--vault-root > OBSIDIAN_VAULT_ROOT > obsidian.config.json（vault_root/scope_aliases）> .aws-article/config.json（只读兼容）`；obsidian.config.json 从 cwd 与脚本位置两侧向上发现。vault_resolver.py 原链路零改动。

## 验证证据

- `npm test`（全量）：**361 tests，360 pass，0 fail**（1 平台 skip——resolver case16 前置不成立，非本次引入）。
- `npm run build`：零错误。
- P0 门禁回归：`python3 …/run_resolver_suite.py` → **PASS=18 FAIL=0 SKIP=1**，与 Phase 0 基线一致，无降级。
- 后端手工验证：list/scope/alias/env 链/budget=0/大文件跳过/read 超限/路径穿越拒绝全部符合契约。

## 偏差与决策

1. **`PI_VAULT_QUERY_PATH` 注入链对齐 resolver 模式**（方案未规定 env 名，取与 `PI_VAULT_RESOLVER_PATH` 对称的命名）。
2. **skipped_large 语义**：大文件既不出现在 items 也不计入 total，仅以计数暴露（方案 §4「跳过计 skipped_large」的字面落地；search 的 scope 内不含大文件时不误报——单测断言）。
3. **DSL 注入全局名 `obsidian`**（方案 §1 命名 ObsidianReader，DSL 侧以小写 `obsidian` 与 `vaultResolve` 风格一致）。
4. 测试 fixture 含中文路径/emoji/引号毒字符串，`a";rm -rf /.md` 等只作单参数传递不执行（spawn 参数数组，无 shell）。

## 遗留

- Phase 0 Windows 闸门仍 ⏳（Windows 机执行，不阻塞 Mac 推进——用户目标明确不设 gate 中断）。
- Phase W（Writer 幂等/排他）、Phase F（两写 workflow+search 注册）、Phase V（真机验收）按序推进。
