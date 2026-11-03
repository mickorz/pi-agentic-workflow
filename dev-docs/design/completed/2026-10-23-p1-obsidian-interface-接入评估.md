# P1 Obsidian 独立接口层接入评估（V2）

> 日期：2026-10-23（V1）；同日 V2 修订
> 背景：P0（VaultResolver，本地 commit 54548c7→d86d532）已交付文章线定位需求。用户定位 P1 方向：**Obsidian 接口是一层独立基础能力**——其他 workflow（首推微信灵感采集）可查询/创建 Obsidian 文章，文章线只是第一个消费者。
> V2 修订（用户评审 4 点，全部采纳）：①接口独立性升级为独立 TS 服务层，DSL 函数只是适配入口；②P1a 收敛为五个核心操作，标签/反链降 P1b；③写入安全重构（独立 workflow 暴露写、create/append 保守语义、内容走 stdin）；④配置脱离公众号 `.aws-article`。

## 0. 前置条件（P1 开工闸门）

- P0 代码目前仅在本仓本地提交链上（GitHub master 尚未同步显示 resolver 与所列提交）。**P1 开工前必须确认**：P0 已 push 同步、Windows 侧门禁通过、微信→审批→草稿 B 类闭环可复现。
- 若 P0 验收发现偏差，先修 P0 再启动 P1a。

## 1. 需求定位与接口形态

接口形态要求（用户定调）：**独立于文章线**、可被任意 workflow/业务代码复用。

### 1.1 分层架构（V2 采纳）

```
公众号 workflow          微信灵感 workflow          未来其他 Runtime/HTTP 服务
      └────────────┬────────────┘                        │
                   ▼                                     ▼
        ObsidianService（独立 TypeScript API，读写权限显式分离）
          · readNote / listNotes / searchNotes   （读面）
          · createNote / appendNote              （写面，仅受控入口可调）
                   ▼
        Vault 文件系统实现（复用 P0 vault_resolver.py + 新增查询/写入脚本，纯 stdlib）
```

- Workflow DSL 中的 `vaultQuery()`（若保留）只是这层服务的**适配入口**，不是唯一接口。
- 其他业务代码可直接编程调用（不经 LLM、不经 workflow）：

```ts
const notes = await obsidian.searchNotes({ query: "Agent", scope: "newsky/知识库", limit: 20 });
const note  = await obsidian.readNote({ path: "newsky/知识库/Agent.md" });
```

- 不绑定 Pi Agent Runtime：将来独立 HTTP 服务、CLI 或其他 Agent Runtime 复用同一 Service。

## 2. 现状（P0 已有底座）

- `vault_resolver.py`：精确路径/精确名/唯一部分匹配、want=article、scope 硬约束、越界与 symlink 拒绝、大小写敏感、末段 .md 补全；`--print-vaults` 人工挑根。
- TS 侧 `vaultResolve(ref,{scope,want})` 已注入 DSL；facade 双通道审批预检+锚点。
- 配置：flag > `OBSIDIAN_VAULT_ROOT` > `.aws-article/config.json`（cwd/脚本位置双兜底）——V2 起第三级降级为兼容来源（§4.5）。

## 3. 路线对比（结论不变）

- **路线 A：pi-obsidian@0.2.3 全量接入**（实测源码：MIT 零依赖 100KB、5 个月未更新、单维护者；13 工具；obsidian.json 自动发现与本仓「显式唯一同步根」冲突——本机 5 个嵌套 vault、newsky 双物理副本；agent 通道每次查询一次 LLM 往返；每机 `pi install` + tool-profiles 白名单，NPM 包消费者部署面扩大）。**保留为 P1b agent 增强面，非 P1a 依赖**。补充（用户核对）：接入成本不止白名单——还要解决 vault 选择规则、路径权限、模型可见内容、写操作是否过审批链四个问题。
- **路线 B：确定性接口层**（✅ 选定，本文 §4）。
- **路线 C：Obsidian Local REST API / 官方 MCP**：需 Obsidian 常驻，双机部署复杂，能力与 B 重叠。**否决**。

## 4. P1a 设计（V2 修订版）

### 4.1 能力范围与优先级（V2 重排）

| 能力 | 分期 | 理由 |
|---|---|---|
| `listNotes`（列目录）、`readNote`（读笔记） | **P1a** | 基本上下文 |
| `searchNotes`（文件名+正文搜索） | **P1a** | 定位已有资料，避免重复创建 |
| `createNote`（创建） | **P1a** | 直接支持微信灵感采集 |
| `appendNote`（追加） | **P1a** | 支持多轮讨论沉淀 |
| `listTags`（标签统计） | P1b | 不影响首个业务闭环；需先定规则：YAML `tags:` 数组、行内 `#tag`、代码块内伪标签的处理 |
| `listBacklinks`（引用检索） | P1b | 语义复杂易低估：别名、路径引用、同名笔记、标题引用（`[[note#heading]]`）。若只实现部分语法，**对外命名只能是「支持指定格式的引用检索」**，不承诺与 Obsidian 软件反链面板一致 |
| Canvas / Kanban / 仪表盘 | 后续按需 | 无已验证业务需求 |

### 4.2 查询结果契约（统一，防超长）

所有查询接口返回**有上限、排序稳定**的结构；需要全文再 `readNote()`：

```json
{ "total": 42, "truncated": true,
  "items": [ { "path": "newsky/知识库/Agent.md", "title": "Agent",
               "snippet": "…命中上下文 ≤120 字…", "mtime": "…" } ] }
```

- 默认 `limit`（建议 20），排序固定（相关性/路径字典序，实现时定死并写入门禁）。
- 不做向量索引/语义检索（P2 再议）。

### 4.3 写入安全（V2 重构，P1a 最大风险点）

1. **权限边界**：registry `riskLevel=write` 只约束 workflow 启动，**不自动约束底层 API**。因此：
   - 写操作只通过独立 workflow `obsidian-note-create` / `obsidian-note-append` 暴露；`read-only` workflow 无法触达写后端。
   - ObsidianService 写面（createNote/appendNote）**只能从受控执行入口获得授权**（dispatcher/launcher 链路），不提供全局裸 `vaultWrite()` DSL 注入。
2. **保守写语义（第一版不提供 overwrite）**：
   - `createNote`：只创建新文件；**目标已存在 → 拒绝**（报冲突+现有文件路径）。
   - `appendNote`：只追加已有文件；**不存在 → 拒绝**（提示先 create）。
3. **内容通道**：正文经 **stdin** 传入后端脚本，不进 argv（避免大段正文进命令行/进程列表）。
4. **路径与并发**：新增时校验目标父目录存在且为真实目录（拒 symlink）、路径在 vault_root+scope 内；写入用 临时文件+原子替换 或 O_EXCL 创建。云同步（坚果云）造成的跨机写入冲突**不靠本机文件锁解决**——文档明示此限制，冲突处理交给同步工具（后期按需考虑内容合并提示）。
5. **审批展示**：复用 P0 锚点模式——审批卡展示目标 `resolved_rel` + 操作类型 + 内容摘要；批准后新鲜解析比对锚点，不一致中止重新授权；**重复批准不重复写入**（create 已存在 → 明确报冲突，幂等）。

### 4.4 后端脚本形态

- 查询：`vault_resolver.py` 增查询模式或同级 `vault_query.py`（tags/backlinks 留 P1b，本期只做 list/read/search）；纯 stdlib 行扫描，无 rg 依赖。
- 写入：同级 `vault_writer.py`（stdin 内容、保守语义、原子操作）；退出码恒 0、stdout 单 JSON、配置同源。
- 门禁：查询（命中/零命中/truncated/scope 越界/大小写/特殊字符）+ 写入（create 冲突拒绝、append 缺文件拒绝、越界拒绝、stdin 特殊字符、幂等重放）双机 PASS。

### 4.5 配置位置（V2：脱离公众号）

- `OBSIDIAN_VAULT_ROOT` 环境变量保持唯一正式通道。
- 长期机内配置迁移到**与公众号无关**的位置：仓库根 `obsidian.config.json`（gitignored；键 `vault_root`/`scope_aliases`；Windows/Mac 各自一份）。
- `.aws-article/config.json` 的 `vault_root` 降级为**兼容读取来源**（P0 已部署机器不受影响），新接口文档不再引导用户写公众号配置目录。
- 发现顺序：flag > env > `obsidian.config.json` > 兼容 `.aws-article`。

## 5. P1b：pi-obsidian agent 增强面（按需后置，不变）

出现「看板/画布/仪表盘/复杂多步知识整理」类需求时：每机 `pi install npm:pi-obsidian` + tool-profiles 新增 `obsidian` agentType（起步只读 6 工具）+ 显式传 vault 根（禁自动发现默认行为）+ 写操作必须映射回本仓审批链。确定性 Service 保留为兜底。

## 6. P1a 验收（用户锁定场景）

> 微信发：「把下面这段 AI 灵感保存到 Obsidian 的灵感目录，标题叫《AI 自动化测试》。」
> 系统检查目录与文件冲突 → 审批卡展示目标路径+操作+内容 → 批准 → 创建笔记 → 回复真实文件位置。
> 随后发：「搜一下自动化测试相关的笔记」→ 能检索到刚才创建的内容。

通过标准：**可重复执行、跨 Windows/Mac 一致、重复批准不产生重复写入**。
另有：P0 回归（定位 19 条门禁不降级）；读面只读 workflow 免审批直查。

## 7. 执行安排

1. **闸门**：P0 push 同步 + Windows B 类闭环复现（E 阶段收尾）。
2. **P1a**：ObsidianService（TS API + 权限分离）→ 五操作后端与门禁 → 两个写 workflow 注册（审批链复用）→ 微信灵感场景端到端验收。
3. **P1b**：标签/引用检索（按 §4.1 诚实语义规则）→ 视使用量决定 pi-obsidian。

## 8. 修订记录

| # | 日期 | 内容 |
|---|---|---|
| V1 | 2026-10-23 | 初版评估（三路线对比，推荐确定性接口层） |
| V2 | 2026-10-23 | 用户评审 4 点全采纳：①独立 TS Service 层（DSL 仅适配入口）；②P1a 收敛五操作（list/read/search/create/append），tags/backlinks 降 P1b 并诚实语义标注；③写入安全重构（独立 workflow 暴露写、create/append 保守拒绝语义、无 overwrite、stdin 内容、云同步冲突明示非本机锁解决）；④配置迁移 `obsidian.config.json`（公众号 `.aws-article` 降兼容）。另补：统一查询结果契约（path/title/snippet/total/truncated）；开工闸门（P0 同步+Windows 闭环复现）；验收场景锁定灵感采集闭环。 |
