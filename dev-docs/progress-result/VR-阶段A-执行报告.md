# VR-阶段A 执行报告 — VaultResolver 确定性解析能力

> 阶段：VR（VaultResolver 跨设备路径解析）阶段 A · 2026-10-23
> 方案基线：dev-docs/design/2026-10-23-vault-resolver-执行方案.md（V1.2 + 三轮评审就地补丁 #11–#14）
> 范围：§S1 vault_root 配置语义 + §S2 确定性解析脚本 + §S5 fixture/门禁套件。不含 runtime 接入（阶段 B）。

## 交付清单

| 文件 | 说明 |
|---|---|
| `dev-examples/wx-article/scripts/draft_manager/vault_resolver.py` | 确定性解析脚本：纯 stdlib、零写、零网络、零 LLM；stdout 单 JSON，退出码恒 0（ok 承载语义） |
| `dev-examples/wx-article/scripts/draft_manager/test-fixture/vault/` | 门禁 fixture（公众号/AI入门 多 md、单篇唯一、newsky/AI提问技巧、dup 双候选、CASE.md 大小写陷阱、escape 越界 symlink） |
| `dev-examples/wx-article/scripts/draft_manager/run_resolver_suite.py` | 门禁套件（用例 1–17），幂等自建 fixture，Windows symlink 受限时显式 SKIP |

## 已实现能力（对照方案 §S2）

- **vault_root 三级优先**：`--vault-root` > 环境变量 `OBSIDIAN_VAULT_ROOT` > `.aws-article/config.json` 的 `vault_root`（自 cwd 向上找配置根，与 check_state.py 同款向上查找约定）；未配置输出含 `--print-vaults` 的指引。
- **双匹配策略**：不含 `/` → 精确名称（目录名 / .md 去 extends 名全等）→ 唯一部分匹配（大小写敏感）；含 `/` → 只精确匹配不退化，**逐段**与实际目录项大小写敏感比对（`公众号/AI入门/prompt.md` → 提示实际存在 `Prompt.md`）。
- **scope 硬约束**：精确路径命中也强制 `resolved_rel` 以 scope（别名映射后真实路径）+ `/` 开头；scope 不存在列顶层目录候选。
- **want=article**：目录正文唯一 → 返回目录（`path_type=dir` + `md` 字段）；`.md` 命中且父目录正文唯一 → 返回父目录；不唯一列 md 候选绝不猜。正文判定原样复用 `check_state.py:36-37` 排除规则（`IMG_PREFIX_EXCLUDE=^(article|draft|review)`、`NAME_ILLEGAL=(审稿,图片引用清单,大纲,配图建议)`）。
- **安全**：`Path.resolve()` 后必须在 vault 根内（拒 `..` 与符号链接逃逸，fixture `公众号/escape → /tmp` 验证）；搜索剪枝隐藏项/imgs/assets/.obsidian、不跟入符号链接。
- **`--print-vaults`**：读 obsidian.json 列注册 vault（含 open 标记），仅一次性人工挑根辅助，运行时无自动发现。
- **输出契约**：`{ok, vault_root, ref, match, want, path_type(dir|file), resolved_path, resolved_rel, md, candidates, issues}`；`path_type` 只描述文件系统类型（三轮评审 #10）。

## 验收结果

- `python3 run_resolver_suite.py` → **PASS=17 FAIL=0 SKIP=0**（2026-10-23，macOS）
  - 覆盖：精确路径/精确名/唯一目录/双候选绝不猜/零命中/路径不退化/越界+symlink 逃界/类型不符提示/md 多候选不自动选/父目录回退/scope 放行+越界/大小写陷阱/根三级优先（flag>env>config）/特殊字符注入（`a";rm -rf /`、`$(echo x)`、空格中文）/未配置指引/真实 Mac vault（`newsky/AI生图` 唯一定位）
- 输出契约抽查：歧义候选为 vault 相对路径；`《》`书名号防御性剥离生效。

## 经验与注意

- fixture 的 symlink 不入库（Windows 无特权创建），由套件运行时幂等创建，不可创建时显式 SKIP 不假 PASS（符合仓库平台差异约定）。
- 大小写校验必须逐段做在**实际目录项**上而非字符串前缀比对，否则 Win/mac 大小写不敏感 FS 会在两机产生不同匹配行为（方案 #10）。

## 遗留与下一步

- 阶段 B：TS 解析辅助 + runtime 原生 `vaultResolve()`（路径注入链：`opts.scriptPath` > `PI_VAULT_RESOLVER_PATH` > dev 兜底，#14 简化版）+ 单测（含仓库外 cwd）+ build。
- 阶段 C：workflow 接线（**两处 `await check()`**，#11）+ facade 审批前预检 + 服务端锚点/审批展示（#12）+ S4.4 Registry 契约三件套（#13）。
- 阶段 D：两份 registry（required 清空 + anyOfArgs + description）。阶段 E：A 类两机 Resolver 验收 + B 类 Windows 业务闭环 + 文档双更新。
- 真机双机验收待 Windows 侧执行（fixture 套件可直接复跑）。
