# idea_to_article V1.0 — Phase A 执行报告

- **阶段**：Phase A（= 需求 P0 文件层）：idea_files.py + 门禁套件
- **日期**：2026-10-24
- **commit**：`7985bb1`（已推送 origin/master）
- **上游**：执行方案 `dev-docs/design/2026-10-24-idea-to-article-v1-执行方案.md`（§2 D4、§5.1、§8 T01/T10/T12/T13/T16）

## 交付清单

| 产物 | 路径 | 说明 |
|------|------|------|
| 文件工具 | `dev-examples/wx-article/scripts/draft_manager/idea_files.py` | 纯 stdlib，~580 行，stdout 单 JSON 契约 |
| 门禁套件 | `dev-examples/wx-article/scripts/draft_manager/run_idea_files_suite.py` | IF-01…IF-18 共 42 断言，临时 vault 注入 |
| 回归修正 | `tests/unit/obsidian-workflows.test.ts` | am-p0 存量断言 16→17（上游 9cfceee 加 videodigest-extract 未同步测试，与本期无关的遗留 FAIL） |

## 子命令契约（实现口径）

`init / adopt-check / locate / list / read / write / append / stale / state --set`，要点：

- **init**：同 messageId → 幂等（不重写不重复 messages）；同标题不同 messageId → `conflict`；目录已存在但无 article.yaml → 领养（`adopted:true`，**不动已有 1-idea.md**，状态从 idea_captured 起步）；新建 `mkdir(parents=False)`（灵感根必须已存在）。
- **locate**：精确 → 部分匹配 → `ambiguous`（附 candidates ≤8，供 T13 澄清话术）/ `not_found`。
- **read/write 白名单**：STAGE_FILES（1-idea…7-publish/配图建议.md/messages.jsonl）；write 拒 1-idea.md 与 article.yaml；write 前自动备份 `.history/<stem>-v<N>.md` + revision+1；原子写（mkstemp+fsync+os.replace）+ 目录 RMW 锁。
- **append**：仅 1-idea.md（追加 `## 补充（<ts>）` 段）与 messages.jsonl（结构化行 `{ts,role,content,turn,messageId}`，空内容拒）。
- **stale --from topic|brief|outline**：STALE_DOWNSTREAM 矩阵标记下游 + status 回退（STALE_STATUS_ROLLBACK）；历史版本保留 .history/。
- **state --set k=v**：STATE_SETTABLE 白名单 + 枚举校验（status 12 态 / approval.* / config.*）。
- **安全**：resolve_dir 改为 **resolve()+前缀约束**（灵感根内、不得为根本身、必须存在目录）——原逐段 symlink 检查在 macOS 会误杀系统级 `/var→/private/var`（tmpdir 场景）；等价防逃逸：vault 内 symlink 段把最终路径引出灵感根即拒。TITLE_ILLEGAL 补 `'`（与 vault_writer 元字符口径对齐）。stdin 上限 1MB。
- article.yaml：行式固定 17 键（YAML_KEYS）两空格缩进，本工具为唯一写入口；articleId=`art_YYYYMMDD_xxxx`（17 字符）。

## 验证证据

- `run_idea_files_suite.py`：**PASS=42 FAIL=0 SKIP=0**（覆盖 IF-01…IF-18：幂等/冲突/规范化/白名单/备份/原子性/补充段/stale/locate/攻击面（根外+穿越+symlink 逃逸+元字符+超限）/state/死锁接管/list/领养）。
- P0 门禁回归：`run_resolver_suite.py` **PASS=18 FAIL=0 SKIP=1**（无降级）。
- 全量：`npm test` **448 tests / 447 pass / 0 fail / 1 skip**；`npm run build` 零错。

## 偏差与决策记录

1. **registry 骨架挪 Phase B**：方案 checklist 将「registry 骨架」列在 Phase A，但骨架与 workflow 脚本（start）同生共死，拆两半会造成 registry 引用不存在脚本的中间态 → 与 Phase B start 脚本同 commit 交付。
2. **真机 T01/T10/T12 挪 Phase B**：T01（创建任务）/T10（同标题冲突）/T12（幂等重投）均经 start 话术真机触达，文件层已由套件 IF-01/03/02 覆盖语义。
3. **D5 索引改扫描式**：方案 §2 D5 已定「扫描式 list/locate，不落索引文件」——实现即按此，无索引维护成本与一致性问题。
4. **resolve_dir 语义修正**（见上安全段）：从「逐段非 symlink」改为「resolve+前缀」，动机是 macOS 系统临时目录天然位于 symlink 后；记录于本报告并在套件 IF-13c 验证逃逸防护等价。
5. **锁接管诊断行进 stderr**：ArticleLock 的 `[LOCK] TAKEOVER` 打印会破坏 stdout 单 JSON 契约，`with_rmw_lock` 内 `redirect_stdout(sys.stderr)` 包裹，未改 article_lock.py 公共行为（其他调用方不受影响）。

## 遗留问题（转 Phase B）

- start/turn 脚本与 registry 双表注册 + auto-approve 白名单扩列讨论。
- 话术文档（微信触发语 → workflow 参数映射）与真机 T01/T10/T12 验收。
