# VaultResolver 跨设备路径解析 · 执行方案（V1.2）

> 日期：2026-10-23（V1.0）· 2026-10-23 修订（V1.1 评审后）· 2026-10-23 修订（V1.2 二轮评审后）· 2026-10-23 三轮评审就地补丁（并入阶段 B/C 任务，不出 V1.3）
> 需求来源：用户提议（微信自然语言引用 Obsidian 文章/目录，免绝对路径）；
> 上游需求：`dev-docs/planning/article-workflow接入/文章工作流接入需求.md`、`dev-docs/pi-agentic-workflow：微信灵感采集 → 多轮选题讨论 → 文章生产交接需求文档-v1.md`
> 结论：**做轻量 VaultResolver，不做 pi-obsidian 全量集成**（§2.3）。V1.2 为开发基线，修订后直接开工，不再做大范围架构评审。

## 修订记录

**V1.0 → V1.1**（一轮评审，7 项）：

| # | 问题 | 处理 |
|---|---|---|
| 1 | Vault 根语义不统一，自动发现返回嵌套多 vault（Mac 实测 obsidian.json 5 个 vault 含嵌套、newsky 双副本） | 砍运行时自动发现，唯一显式 `vault_root`；发现降级为 `--print-vaults` 辅助 |
| 2 | schema required 拦截 vault_ref 入口（`intent-router.ts:119-126`、`dispatcher.ts:88,169-170`） | required 清空 + 跨字段规则进 description + 脚本 fail-fast |
| 3 | want=dir 与按文章名定位冲突 | 新增 `want=article`，正文唯一判定复用 check_state.py 排除规则 |
| 4 | 不应经 general agent 执行 shell（`workflow-runtime.ts:882` commandSuccess 仅 boolean） | runtime 原生 `vaultResolve()`，execFile argv、零 shell 拼接 |
| 5 | searchWorkflows 不传 examples（`task-control-facade.ts:63-70` 仅 5 字段） | 路由提示写进 description + 微信真机抽参测试 |
| 6 | 路径型引用不应退化模糊搜索 | 含 `/` 一律精确匹配；scope 精确目录 + 可选别名 |
| 7 | {ok:false} 可能仍记成功 | 解析失败走 `check()`（`workflow-runtime.ts:851` → CHECK_FAILED） |

**V1.1 → V1.2**（二轮评审，3 项）：

| # | 问题 | 对码验证 | 处理 |
|---|---|---|---|
| 8 | 审批前无参数预检：高风险流程先建 PendingAction 再校验（`task-control-facade.ts:106-125` 直接 pending.create），出现"批准→执行→才发现缺参失败" | 属实 | §4-S4.2：facade 建 pending 前做文章族轻量预检（registry 声明式 `anyOfArgs`），vault_ref 先解析成功才建审批；审批展示解析后相对路径；批准后执行前校验目标一致（§4-S4.3） |
| 9 | runtime 硬编码 dev-examples 脚本路径；npm 包 files=['dist','examples','README.md'] 不含 dev-examples，换 cwd/包部署必挂 | 属实 | §4-S3.1：resolver 路径宿主注入（opts > 运行时配置 > dev 兜底），找不到明确报错；补仓库外 cwd 测试 |
| 10 | 契约不统一：path_type 混用 want 模式、scope 对精确路径非强约束、验收未拆分 | 属实 | §4-S2：path_type∈{dir,file}；scope 一律硬约束；精确路径逐段大小写校验；§6 验收拆 Resolver 验收 / 业务闭环验收 |

**V1.2 三轮评审就地补丁（#11–#14，并入阶段 B/C 任务，不出 V1.3）**：

| # | 问题 | 对码验证 | 处理 |
|---|---|---|---|
| 11 | S3.2 示例 `check()` 未 await：runtime 中 check 为 async（返回 `Promise<boolean>`，false 即 throw CHECK_FAILED）；不 await 则失败浮空、FAILURE 态不保证落地 | 属实 | §4-S3.2 示例两处改 `await check(...)`；失败态测试断言下游零文件写入/零微信 API 调用 |
| 12 | resolvedTarget 只写 PendingAction 不足以保证微信展示（`workflow_execute` 仅返回 `needsApproval/actionId`，回复由 agent 组织） | 属实（`task-control-facade.ts:117,128`） | §4-S4.2/S4.3 补：PendingAction 类型与持久化参数扩展；审批提示服务端确定性生成（workflowId+resolvedTarget+actionId）；锚点服务端生成并覆盖外部同名参数；先写锚点再算 argsDigest |
| 13 | anyOfArgs 未纳入 Registry 契约 | 属实（`contracts/wx.ts:49` 无字段；`digest.ts:29` 行数据未含；`registry.ts` register() 无校验） | §4-S4.4 三件套：contracts 类型 + computeRegistryDigest 纳入 + register() 合法性校验 |

**阶段 C 实现落地记录（#15，2026-10-23，commit 见 VR-阶段C-执行报告）**：
- S4.4 三件套落地：`WorkflowRegistration.anyOfArgs?: string[]`（contracts/wx.ts）；register() 校验非空字符串数组且条目均在 argsSchema.properties；computeRegistryDigest 行数据纳入 anyOfArgs（排序，规则变更旧审批失效）。
- S4.2/S4.3 预检落地（task-control-facade.ts）：高风险分支 pending.create 前——anyOfArgs 全空→error 不建审批；vault_ref 通道先 vaultResolve（want=article，scope 取 args.vault_scope；配置错误 catch 转 error）；失败/歧义→error 带 issues/candidates 不建审批；成功→服务端锚点 `vault_ref_pinned_rel=r.resolved_rel` 覆盖外部同名参数，先锚点后 argsDigest；PendingAction/WorkflowExecuteResult/去重返回均带 resolvedTarget；deps 增 vaultResolver（scriptPath/cwd/env/timeoutMs/vaultRoot）与 onPendingCreated 回调。
- #12 审批卡落地（pending-flow.ts renderPendingActionApproval + wechat-app.ts 接线）：PendingAction 创建即由服务端确定性推送三要素文案；重启补扫对存量 pending 重发（CV-004 同款）。
- S3.2 接线落地（article_inspect.js）：vault_ref/vault_scope/vault_ref_pinned_rel 三参；phase('文章定位') vaultResolve+await check×2+锚点比对；顺带修复存量缺陷——局部变量 `const check` TDZ 遮蔽 DSL 内建 check()，改名 inspectResult。
| 14 | S3.1 注入链过宽（CLI 参数/settings 体系 P0 非必要） | 采纳 | P0 收敛：`opts.scriptPath`（测试注入）> 环境变量 `PI_VAULT_RESOLVER_PATH`（唯一正式通道）> dev 兜底；不新增 CLI 参数与 settings 配置 |

**修订 #17（2026-10-23，用户真实输入驱动）**：精确路径末段 md stem 确定性补全。
- 现象：用户从 Obsidian「复制路径」得到的引用不带 `.md` 扩展名（如 `…/从零学AI- 9 个常见 AI 术语，不懂技术也能看懂 4/从零学AI - AI模型原理术语`），末段字面命中不了实际文件 `….md`，含 `/` 的引用又不允许退化 → 真实输入必败。
- 契约修订（S2）：`resolve_exact_path` 末段字面未命中且无大小写近似时，仅对最后一段尝试 `seg+".md"`（唯一确定形式，非模糊猜测；其余段不补、无命中仍字面量失败）；命中后 want=article 照旧由 apply_article 提升为父目录（正文唯一）。门禁增用例 18（补全正/负），套件 18/18。
- Mac vault_root 事实修正：真实同步副本含 60_Workspace 的是坚果云 `~/Library/CloudStorage/坚果云-490113806@qq.com/newsky`（Downloads 同步空间副本无 60_Workspace）；本机 `.aws-article/config.json` 尚未创建，生产需设 `OBSIDIAN_VAULT_ROOT` 或建 config（键 vault_root）指向坚果云 newsky 根。

**修订 #18（2026-10-23，配置发现机制对齐）**：`.aws-article/config.json` 发现链补脚本位置兑底。
- 现象：resolver 原 `load_config()` 仅自 cwd 向上找；网关 cwd=仓库根时，公众号配置根 `dev-examples/wx-article/.aws-article/` 在 cwd 子目录，永远找不到（check_state.py:176 一直是 `find_config_root(Path(__file__).parent)` 从脚本位置找，两者不一致）。
- 修订（S1 第三级）：cwd 向上找优先（本地 CLI 调试可覆盖），未命中后按脚本自身位置向上找兑底（对齐 check_state.py 约定）；网关零配置改动即可读到 wx-article 配置根。门禁 case_19 验证兑底发现（断言只验证 vault_root 来自 config，不依赖真实库内容）；case_16 在本机存在真实配置时显式 SKIP。
- Mac 已建机内配置 `dev-examples/wx-article/.aws-article/config.json`（gitignore 已覆盖 .gitignore:29），vault_root→坚果云 newsky 根；仓库根 cwd、无 env、无 flag 端到端实测解析成功。Windows 站 E 验收时同样建一份（vault_root→E:/Obsidian）。

**阶段 D 实现落地记录（#16，2026-10-23，commit 见 VR-阶段D-执行报告）**：
- facade 双通道名（task-control-facade.ts）：`VAULT_REF_CHANNELS={vault_ref:'article', vaultRef:'dir'}`，预检按通道名定 want；锚点参数统一 vault_ref_pinned_rel；error 文案统一『目标定位失败（未创建审批，请向用户确认后重试）』。
- 四脚本接线（S3.2）：wechat_md_to_draft.js / article_prepare.js / article_publish.js 增 vault_ref 通道（phase('文章定位')+vaultResolve(want=article)+await check×2+锚点比对；prepare 定位段入 try 内保证中断兑底通知）；obsidian_outline.js 增 vaultRef 通道（want=dir，resolved_path 反斜杠归一，meta.phases 增首相位『目录定位』，双通道全缺 throw 新文案）；prepare/publish 存量局部变量 check/check2 TDZ 遮蔽同修（改名 inspectResult/inspectResult2）。
- 两份 registry（wx-article + am-p0）：obsidian-outline required[vaultDir]→[]+anyOf[vaultDir,vaultRef]；wechat-md-to-draft required[article_dir]→[]+anyOf[article_dir,vault_ref]；inspect/prepare/publish anyOf=[article_dir,vault_ref,article_name]；均增 vault 通道三字段（vault_ref 或 vaultRef/vault_scope/vault_ref_pinned_rel），description 写明定位规则（searchWorkflows 仅 5 字段达 agent，路由提示靠 description），examples 增书名号示范（含锁定验收场景「帮我检查一下《AI提问技巧》这篇公众号文章，然后放到草稿箱」）。
- 测试（vr-approval.test.ts +6 → 17）：facade vaultRef 通道正负（want=dir 锚点/审批目标）；两份 JSON loadFromFile 零 issues+条目契约断言；md_to_draft/publish vault 定位+early-exit 集成（零副作用路径，仅首 agent 执行）；prepare/outline parseWorkflowScript+首相位断言。

---

## 1. 问题与目标

### 1.1 问题

同一 Obsidian 内容在两台机器上绝对路径不同，但目录结构一致：

| | Windows | Mac |
|---|---|---|
| 同步根 | `E:/Obsidian` | `/Users/michaelchang/Downloads/同步空间/Obsidian` |
| 逻辑路径 | `newsky/AI生图` | `newsky/AI生图` |

现状所有文章 workflow 都要求**本机绝对路径**入参（`vaultDir` / `article_dir`），换机器即失效。

> ⚠️ Mac 端 `newsky` 存在**两个物理副本**（`~/Downloads/同步空间/Obsidian/newsky` 与
> `~/Library/CloudStorage/坚果云-…/newsky`，后者在 obsidian.json 标记 open）。两机逻辑引用一致的
> 前提是**每台机器配置且仅配置一个同步根**；副本漂移见 §8-2。

### 1.2 目标（P0）

微信只说逻辑引用（文章名/文件夹名/Vault 相对路径），系统在**当前执行机器**上确定性解析为本机路径：

> 「帮我检查一下《AI提问技巧》这篇公众号文章，然后放到草稿箱」

- 跨平台 Vault 根显式唯一配置（每机一次）
- 按名称/相对路径唯一定位（歧义返回候选，**绝不猜**）
- 审批前预检 + 审批目标与执行目标一致（评审 #8）
- 现有 workflow 兼容 `article_dir`/`vaultDir` 绝对路径入参

### 1.3 非目标（P0 不做）

- pi-obsidian 13 工具全量集成（P1）
- 文章内容语义检索、知识库关联（P2）
- 多轮候选选择交互：P0 定位失败要求用户**重发完整相对路径**（P1）
- 通用 oneOf/跨字段校验框架（防框架化）
- 解决 workflow 内部平台差异：路径解析通 ≠ 整条 workflow 跨平台可跑（发布链 Mac 仍缺 `.aws-article` 凭证）

---

## 2. 方案总览

### 2.1 架构

```
微信自然语言（文章名/《标题》/相对路径 [+ scope 提示]）
        │  agent 路由（读 registry description + requiredArgs，抽参）
        ▼
workflow_execute（agent-host）
        │  S4.2 审批前预检（仅文章族，registry anyOfArgs 声明）：
        │    · 三通道（article_dir/vault_ref/article_name）至少一 → 否则直接报错，不建审批
        │    · 有 vault_ref → 先确定性解析；失败/歧义 → 直接报错给 agent，不建审批
        │    · 解析成功 → PendingAction 附 resolved_rel（审批展示 + 执行前一致性锚点）
        ▼
PendingAction（审批卡片显示「公众号/AI入门/AI提问技巧」而非裸参数）
        │  用户批准（确定性通道，LLM 无自授权通路）
        ▼
现有 workflow（article-inspect / obsidian-outline / article-prepare / -publish / wechat-md-to-draft）
        │  入口先解析再执行；有审批锚点时校验 resolved_rel 一致，不一致中止要求重新授权
        ▼
vaultResolve(ref, {scope, want})   ← runtime 原生函数（execFile argv 直调，零 LLM、零 shell）
        │                            resolver 脚本路径宿主注入（S3.1，不依赖仓库 cwd）
        ▼
vault_resolver.py（确定性脚本，纯 stdlib，零写零网络）
        │  vault_root：环境变量 > config.json（每机显式唯一）
        ▼
{ ok, resolved_path, path_type(dir|file), md, candidates[], issues[] }
  ├─ ok=true  → 拼回 article_dir / vaultDir，继续原流程
  └─ ok=false → check() 抛 CHECK_FAILED → 运行记 FAILURE → 微信收到「定位失败+原因/候选」
```

### 2.2 设计原则

1. **确定性解析，不调 LLM**：匹配、歧义、候选全部由 Python 脚本判定。
2. **绝不猜**：0 命中/多候选/审批前定位失败 → 确定性失败；不自动选第一个、不自动取父目录（`want=article` 的父目录回退受唯一正文判定约束）。
3. **兼容优先**：绝对路径入参行为不变；`check_state.py` 不动。
4. **越权防护**：解析结果必须在 vault 根内（拒 `..` 与符号链接逃逸）；scope 一律硬约束。
5. **审批一致性**：用户批准的目标 = 实际执行的目标；不一致即中止重新授权。
6. **部署无关**：runtime 不假设仓库 cwd，resolver 路径由宿主注入（评审 #9）。
7. **防框架化**：runtime 只加一个原生函数 + facade 一个声明式预检；不做通用校验框架。

### 2.3 为什么不是 pi-obsidian 全量集成（不变）

需求只有「定位」；`pi-agent-adapter.ts` 显式工具白名单使接入成本远超收益；自写 resolver ~250 行 stdlib Python 跨平台可测。P1 再评估，resolver 保留为确定性兜底。

---

## 3. 现有可复用基础（盘点结论，V1.1 不变 + 增补）

| 现状 | 位置 | 复用方式 |
|---|---|---|
| `--locate` 名称定位 | `check_state.py:169-197` | **不动**；vault_resolver.py 同级新增 |
| 正文唯一判定规则 | `check_state.py:36-37`（`IMG_PREFIX_EXCLUDE`/`NAME_ILLEGAL`） | 排除规则原样复用到 want=article |
| `check()` DSL 原语 | `workflow-runtime.ts:851-871`（false→CHECK_FAILED） | 解析失败/审批锚点不一致的失败态 |
| `commandSuccess()` | `workflow-runtime.ts:882`（仅 boolean） | 不能取 stdout → 需新增 vaultResolve |
| 路由元数据 | `task-control-facade.ts:63-70`（5 字段，无 examples） | 提示写进 description |
| 审批链去重 | `task-control-facade.ts:106-125`（argsDigest 去重后 pending.create） | 预检插在 pending.create **之前**（§4-S4.2） |
| 审批合并校验 | `dispatcher.ts:169-170`（批准后按 required 查缺） | 保留；预检前置后此处不再首见缺参 |

---

## 4. P0 执行内容

### S1 Vault 根：显式唯一配置（V1.1 不变）

**语义**：`vault_root` = 共同同步目录根（非 Obsidian 单 Vault）；逻辑引用一律为其下相对路径。

- Windows：`E:/Obsidian`；Mac：`/Users/michaelchang/Downloads/同步空间/Obsidian`
- 坚果云 `newsky` 副本**不得**配置为根（是子树 `newsky/` 的另一物理副本，配置即错位）

**来源优先级（高→低）**：`OBSIDIAN_VAULT_ROOT` 环境变量 > `.aws-article/config.json` 的 `vault_root` 字段（已 gitignored 的本机配置位）> **无自动发现**。`vault_resolver.py --print-vaults` 仅一次性人工挑根辅助。未配置 → `ok=false` + 配置指引。

### S2 确定性解析脚本 `vault_resolver.py`（V1.2 契约修订，评审 #10）

**位置**：`dev-examples/wx-article/scripts/draft_manager/vault_resolver.py`
**约束**：`#!/usr/bin/env python3`，仅标准库，零写零网络，stdout 单个 JSON（UTF-8）。

**CLI**：

```bash
python3 vault_resolver.py --ref "<逻辑引用>" [--scope <vault相对目录>] [--want dir|file|article|any] [--vault-root <路径>]
python3 vault_resolver.py --print-vaults
```

**匹配策略**：

| ref 形态 | 匹配策略 |
|---|---|
| 不含 `/`（名称） | ① 精确名称（目录名或 .md 文件名去扩展名全等）→ ② 唯一部分匹配 |
| 含 `/`（相对路径） | **只允许精确匹配**，不退化名称搜索；且**逐段大小写校验**：沿路径逐段用实际目录项（listdir）做**大小写敏感**比对，任一段不一致（含 `prompt.md` vs `Prompt.md`）→ `ok=false` 并提示实际存在的项——防止 Windows/macOS 大小写不敏感文件系统在两机产生不同匹配行为 |

**--want 语义**：

- `dir`：候选仅目录（outline 场景）。
- `file`：候选仅文件。
- `article`（文章流程默认）：文章目录 + 唯一正文语义——
  - 命中目录：按 check_state.py 同款排除规则统计合法正文 md，唯一 → 返回该目录；不唯一 → `ok=false` 列出 md；
  - 命中 `.md`：所在目录正文唯一 → 返回父目录；不唯一 → `ok=false` 列出同目录 md，**不自动选第一个**；
  - `md_file` 指定正文为 P1 扩展。
- `any`：目录或文件（默认）。

**scope 硬约束（评审 #10 修订）**：`--scope` 对**所有匹配策略**生效——精确路径命中的 `resolved_rel` 也必须以 `scope + '/'` 开头，否则 `ok=false`。scope 本身先查 config 可选 `scope_aliases` 别名表做一次确定性映射，未命中 → `ok=false` 列出相近顶层目录。

**通用规则**：递归剪枝（隐藏目录/`imgs`/`assets`）；0 命中 / ≥2 命中 → `ok=false`（候选为 vault 相对路径）；名称匹配按大小写敏感字符串语义（两机一致）；安全校验（`Path.resolve()` 后必须在 vault 根 `resolve()` 内）。

**输出 JSON 契约（V1.2 修订）**——`path_type` 只描述**实际文件系统类型** `{dir,file}`；`article` 是 want 模式不是类型，其结果为 `path_type=dir` + `md` 字段：

```json
{ "ok": true, "vault_root": "/Users/.../Obsidian", "ref": "AI提问技巧",
  "match": "exact_path|exact_name|unique_partial", "want": "article",
  "path_type": "dir", "resolved_path": "/Users/.../Obsidian/newsky/AI提问技巧",
  "resolved_rel": "newsky/AI提问技巧", "md": "从零学AI.md", "candidates": [], "issues": [] }
```

### S3 原生 `vaultResolve()`（V1.2 修订部署路径，评审 #9）

**S3.1 runtime 函数**（`src/runtime/workflow-runtime.ts`，`commandSuccess` 旁注入 DSL）：

```ts
vaultResolve(ref: string, opts?: { scope?: string; want?: 'dir'|'file'|'article'|'any';
                                   scriptPath?: string; vaultRoot?: string })
  : Promise<{ ok: boolean; resolved_path?: string; resolved_rel?: string; path_type?: 'dir'|'file';
              md?: string; candidates?: string[]; issues?: string[]; match?: string }>
```

- **execFile argv 数组直调**，零 shell、零字符串拼接（注入面为零）。
- Python 探测：`execFile(python3|python|py, ['-c','import sys'])` 试运行验证。
- **resolver 脚本路径注入链（评审 #14 简化）**：
  1. `opts.scriptPath` 显式指定（**测试注入专用**）；
  2. 宿主环境变量 `PI_VAULT_RESOLVER_PATH`（**唯一正式通道**：CLI、微信服务、恢复执行统一从此取；npm 包 `files=['dist','examples','README.md']` **不含** dev-examples，包使用方自带 resolver 并设此变量——resolver 是独立 stdlib 单文件，部署时随宿主复制即可）；
  3. dev 兜底：`<cwd>/dev-examples/wx-article/scripts/draft_manager/vault_resolver.py`（仅仓库根启动时命中）。
  - 三级全落空 → **明确报错**：`vault resolver 未配置（设 PI_VAULT_RESOLVER_PATH）`，不静默不猜测。P0 **不新增** CLI 参数与 settings 配置体系。
- 超时 10s；stdout 非法 JSON → `{ok:false, issues:['resolver 输出非法 JSON']}`。
- **不扩展**通用 runScript/commandOutput DSL。

**S3.2 workflow 接线模式**（每流程入口同一写法；优先级：绝对路径 > vault_ref > article_name+workspace_dir）：

```js
let articleDir = args.article_dir
if (!articleDir && args.vault_ref) {
  const r = await vaultResolve(args.vault_ref, { scope: args.vault_scope, want: 'article' })
  await check(() => r.ok,
        '文章定位失败: ' + JSON.stringify({ issues: r.issues, candidates: r.candidates }) + '（请重发完整 vault 相对路径）')
  if (args.vault_ref_pinned_rel)   // 审批锚点（见 S4.3，服务端生成）
    await check(() => r.resolved_rel === args.vault_ref_pinned_rel,
          '定位结果与批准目标不一致: 批准=' + args.vault_ref_pinned_rel + ' 实际=' + r.resolved_rel + '，请重新发起授权')
  articleDir = r.resolved_path
}
```

- 失败一律 `check()`（→ FAILURE 态），且**必须 `await`**（评审 #11）：`check` 为 async，false 即 throw CHECK_FAILED；不 await 则拒绝浮空、FAILURE 态不保证落地；**禁止** `return {ok:false}`（普通返回会记成功）。
- 旧通道（article_name+workspace_dir、绝对路径）保留不动。

**改造范围**：`obsidian_outline.js`（`vaultRef`，want=dir）、`wechat_md_to_draft.js`、`article_inspect.js`、`article_prepare.js`、`article_publish.js`（`vault_ref`，want=article）。

### S4 Registry、审批预检与路由（V1.2 增补 S4.2/S4.3，评审 #8）

**S4.1 required 改造与路由提示**（V1.1 内容不变）：

- 两份 registry（`dev-examples/wx-article/registry.json` + `dev-examples/am-p0/registry.json`）：`obsidian-outline` required `["vaultDir"]→[]`、`wechat-md-to-draft` `["article_dir"]→[]`；
- argsSchema 增 `vault_ref`（outline 用 `vaultRef`）+ `vault_scope`；description 写明跨字段规则与解析能力（searchWorkflows 不传 examples，`task-control-facade.ts:63-70` 仅 5 字段）；examples 同步更新（书名号剥离开示范）。

**S4.2 审批前参数预检（新增，插在 `task-control-facade.ts` pending.create 之前）**：

registry 条目新增**声明式可选字段** `anyOfArgs: string[]`（如 `["article_dir","vault_ref","article_name"]`），facade 在高风险建审批前执行 5 行通用检查：

1. `anyOfArgs` 声明的通道**一个都没有效值** → **不建 PendingAction**，直接返回 error 给 agent（"缺文章定位参数，请提供文章名或 vault 相对路径"），agent 转问用户——堵住"批准→执行→才发现缺参"的洞；
2. 传了 `vault_ref` → 调用与 runtime 同一个 TS 解析辅助（spawn resolver，argv 传参）**先解析**：
   - 解析失败/歧义 → **不建审批**，error 附候选/原因；
   - 解析成功 → PendingAction 附 `resolvedTarget`（= resolved_rel），审批卡片展示解析后的逻辑路径（如「公众号/AI入门/AI提问技巧」）而非裸参数。
3. 预检只做只读解析（零写零网络），失败不产生任何副作用；argsDigest 去重逻辑不变。
4. **审批展示接线（评审 #12）**：`workflow_execute` 返回值在 `needsApproval/actionId` 之外增 `resolvedTarget`（有解析结果时）；审批提示由**服务端确定性生成**（模板渲染 workflowId + resolvedTarget + actionId），不依赖 agent 自行组织描述；`PendingAction` 类型与持久化创建参数同步扩展。

声明式 `anyOfArgs` 是唯一新增机制——不做通用 oneOf 框架；无该字段的 workflow 行为完全不变。

**S4.3 审批目标一致性锚点（新增）**：

- S4.2 解析成功时，把 `vault_ref_pinned_rel`（= resolved_rel）写入 pending args（随 argsDigest 一体去重）；
- 批准执行时 workflow 按 S3.2 重新**新鲜解析**并与锚点比对：一致 → 执行；不一致（vault 内容在审批窗口内变化）或无法解析 → `check()` 失败中止，提示重新发起授权；
- 防的是：审批的 A，执行的却是 B。
- **锚点可信（评审 #12）**：`vault_ref_pinned_rel` 由**服务端**在预检解析成功后生成，并**覆盖** args 中外部同名参数（LLM/外部传入的锚点不可信任）；**先写入服务端锚点、再计算 `argsDigest`**，保证审批快照与执行参数一致（防「批准的是 A 的摘要、执行的是 B 的参数」）。

**S4.4 Registry 契约配套（评审 #13）**：

- `src/contracts/wx.ts`：`WorkflowRegistration` 增加可选 `anyOfArgs?: string[]`；
- `src/dispatch/registry.ts`：`register()` 增加最小合法性校验（数组、元素为非空字符串、字段名存在于 argsSchema，否则注册拒绝）；
- `src/agent-host/digest.ts`：`computeRegistryDigest()` 行数据纳入 `anyOfArgs`（排序后），使规则变更能让旧审批失效。

### S5 测试（V1.2 增补审批/部署用例）

**fixture**：`dev-examples/wx-article/scripts/draft_manager/test-fixture/vault/`：
`公众号/AI入门/Prompt.md`、`公众号/AI入门/稿子.md`、`公众号/AI入门/单篇/唯一.md`、`newsky/AI提问技巧/从零学AI.md`、`dup/A/笔记.md`+`dup/B/笔记.md`、越界 symlink `公众号/escape → /tmp`、大小写陷阱 `公众号/AI入门/CASE.md`（供 `case.md` 探测）。

**`run_resolver_suite.py`**（`[PASS]/[FAIL]/[SKIP]` + 汇总）：

| # | 用例 | 期望 |
|---|---|---|
| 1 | `--ref "公众号/AI入门/Prompt.md"` | ok，exact_path，path_type=file |
| 2 | `--ref "AI提问技巧"` | ok，唯一目录 |
| 3 | `--ref "AI入门"`（真实目录名） | ok，exact_name |
| 4 | `--ref "笔记"` | ok=false，candidates=2 |
| 5 | `--ref "不存在"` | ok=false，零命中 |
| 6 | `--ref "公众号/不存在路径"` | ok=false，不退化名称搜索 |
| 7 | `--ref "../outside"` / symlink | ok=false，越界拒绝 |
| 8 | `--ref "Prompt" --want dir` | ok=false，提示匹配到文件 |
| 9 | `--ref "Prompt" --want article`（AI入门下两 md） | ok=false，列 md 候选不自动选 |
| 10 | `--ref "唯一" --want article` | ok，path_type=dir，md=唯一.md |
| 11 | `--ref "公众号/AI入门/Prompt.md" --scope "公众号/AI入门"` | ok（scope 内） |
| 12 | `--ref "公众号/AI入门/Prompt.md" --scope "newsky"` | **ok=false（scope 硬约束，精确路径也不例外）** |
| 13 | `--ref "公众号/AI入门/prompt.md"`（大小写错） | ok=false，提示实际存在 Prompt.md |
| 14 | `--vault-root` > 环境变量 > config.json | 依次生效 |
| 15 | 特殊字符 ref：`a";rm -rf /`、`$(echo x)`、空格中文 | 字面量匹配，无注入 |
| 16 | 未配置 vault_root | ok=false + 指引（含 --print-vaults） |
| 17 | 真 Mac vault：`--ref "AI生图"` | ok（缺失 SKIP） |

**原生函数单测**（vaultResolve）：argv 往返、特殊字符、python 探测失败、非法 JSON、超时、**注入链三级**（opts > 环境变量 `PI_VAULT_RESOLVER_PATH` > dev 兜底，无 CLI/settings 通道）、**仓库外 cwd 启动 + 注入路径可用、三级全空明确报错**（评审 #9/#14）。

**审批链单测**（S4.2/S4.3/S4.4，agent-host 层）：缺三通道 → 不建 pending 直接 error；vault_ref 歧义 → 不建 pending；解析成功 → pending 含 resolvedTarget 与 pinned_rel、审批提示含 resolvedTarget；外部传入的 `vault_ref_pinned_rel` 被服务端覆盖（不信任 LLM 锚点）；argsDigest 在锚点写入后计算（快照=执行参数）；批准后目标漂移 → workflow FAILURE 并要求重新授权；registry anyOfArgs 变更 → computeRegistryDigest 变化（旧审批失效）；**失败态断言下游零副作用**（无文件写入、无微信 API 调用，评审 #11）。

**端到端（真机，全局 `pi-workflow` 命令约定，不传 `--model`）**：

1. CLI：outline `--args '{"vaultRef":"AI生图"}'` → 大纲落解析后目录
2. 失败态：`{"vault_ref":"笔记"}` → FAILURE + 候选清单（不得显示成功）
3. **微信审批链**：发《AI提问技巧》指令 → 审批卡片显示解析后相对路径 → 批准 → 执行用本机解析路径 → 结果回推
4. 旧入参回归：绝对路径用例冒烟不变

---

## 5. 文件改动清单（V1.2）

| 动作 | 文件 |
|---|---|
| 新增 | `dev-examples/wx-article/scripts/draft_manager/vault_resolver.py` |
| 新增 | `dev-examples/wx-article/scripts/draft_manager/test-fixture/vault/…` |
| 新增 | `dev-examples/wx-article/scripts/draft_manager/run_resolver_suite.py` |
| 新增 | `src/runtime/` 或共享 util：TS 解析辅助（execFile argv + python 探测，runtime 与 facade 复用） |
| 修改 | `src/runtime/workflow-runtime.ts`（vaultResolve 原生函数 + 路径注入链；**改后 `npm run build`**） |
| 修改 | `src/agent-host/task-control-facade.ts`（S4.2 预检插 pending.create 前 + resolvedTarget/pinned_rel + 审批提示服务端生成） |
| 修改 | `src/contracts/wx.ts`（WorkflowRegistration 增 anyOfArgs，S4.4） |
| 修改 | `src/dispatch/registry.ts`（anyOfArgs 合法性校验，S4.4） |
| 修改 | `src/agent-host/digest.ts`（computeRegistryDigest 纳入 anyOfArgs，S4.4） |
| 修改 | 5 个 workflow 脚本（vault_ref 入口 + 锚点校验 + check() 失败态） |
| 修改 | 两份 registry（required 清空 + anyOfArgs + schema + description + examples） |
| 修改（本机，不入库） | `.aws-article/config.json` 增 `vault_root`（可选 `scope_aliases`） |
| 修改 | `dev-examples/wx-article/README.md` |

## 6. 验收标准（V1.2 拆分两类，评审 #10）

**A. Resolver 验收（两机各自达标，不受公众号凭证影响）**：

- [ ] Windows 与 Mac 各自配置 vault_root 后，**同一逻辑引用**（名称/相对路径/scope 组合）分别解析到各自本机路径
- [ ] `run_resolver_suite.py` 全 PASS（平台不适用 SKIP）+ vaultResolve 原生函数单测 PASS（含仓库外 cwd）
- [ ] 歧义/零命中/越界/路径不退化/大小写/scope 越界 六类失败均确定性返回 FAILURE 态

**B. 业务闭环验收（在有公众号凭证的机器上完成，即 Windows）**：

- [ ] 锁定场景——微信输入「帮我检查一下《AI提问技巧》这篇公众号文章，然后放到草稿箱」：
  1. Agent 识别文章名与目标 workflow（零绝对路径）
  2. 本机自动解析文章目录（want=article，唯一正文）
  3. 审批卡片展示解析后逻辑路径 → 用户批准
  4. 执行检查、补图及草稿处理（批准目标 = 执行目标）
  5. 微信返回**真实**完成状态与草稿结果（失败必须 FAILURE + 明确原因，不得假报完成）
- [ ] 审批前预检：缺参/定位失败时不产生审批项，agent 直接转问用户
- [ ] Mac 侧业务链允许验到"解析成功 + 凭证缺失明确报错"（不阻断 A 类验收）
- [ ] 旧绝对路径入参回归不变；两份 registry 微信真机抽参测试通过

## 7. 优先级与后续（不变 + 微调）

| 能力 | 优先级 |
|---|---|
| 显式唯一 vault_root / 唯一定位 + want=article / 原生 vaultResolve（路径注入）/ 审批前预检 + 目标锚点 / required 改造 | **P0 本次** |
| 候选选择多轮交互 / `md_file` 指定正文 | P1 |
| pi-obsidian 完整工具集成（先解决适配层白名单） | P1 |
| 多 vault 根 / scope 别名表扩充 | P1 |
| 文章内容语义检索、知识库关联 | P2 |

## 8. 风险与注意事项

1. **解析 ≠ 跨平台执行**：发布链平台差异（Mac 缺凭证）不在范围，只解决"定位"。
2. **双副本漂移**：Mac `newsky` 两个物理副本——每机仅配置一个同步根；结构不一致时确定性失败列候选。
3. **构建链**：runtime/facade 改动后必须 `npm run build`（全局 `pi-workflow` 链接 dist）。
4. **性能**：os.walk 剪枝；审批预检多一次本地解析（<1s 量级），可接受。
5. **大小写**：字符串与逐段路径校验均大小写敏感（两机一致语义）；文档注明引用大小写须与实际一致。
6. **特殊字符**：execFile argv 零 shell 拼接；书名号在路由抽参层剥离。
7. **required 放开兜底**：CLI 直连路径（不经 facade）由 workflow 入口 throw 明确文案 fail-fast。
8. **审批窗口漂移**：pending 存续期内 vault 变化 → 锚点比对失败 → 重新授权（by design）。
9. **npm 包部署**：包不含 resolver；宿主须注入路径，三级落空明确报错（§4-S3.1）。

## 9. 文档与进度同步要求（执行时遵守）

1. 更新 `dev-docs/progress/执行进度.md` 里程碑状态表；
2. `dev-docs/progress-result/` 新建本阶段独立执行报告（新文件，不追加他人）；
3. 踩坑沉淀 `dev-docs/experience/`（一篇一问题）。

## 10. 执行顺序 checklist（V1.2 阶段制 A–E）

**阶段 A · 确定性解析能力** ✅ 2026-10-23（门禁 17/17；报告 dev-docs/progress-result/VR-阶段A-执行报告.md）
1. [x] S1 vault_root 两机配置语义 + config.json
2. [x] S2 `vault_resolver.py`（含 --print-vaults、scope 硬约束、逐段大小写校验）
3. [x] fixture + `run_resolver_suite.py` 全绿（含 V1.2 新用例 11-13）

**阶段 B · 安全接入 runtime** ✅ 2026-10-23（单测 19/19；全量 324 中 323 pass/1 平台 skip；报告 dev-docs/progress-result/VR-阶段B-执行报告.md）
4. [x] TS 解析辅助 + S3.1 原生 `vaultResolve()`（路径注入链）+ 单测（含仓库外 cwd）+ build

**阶段 C · workflow 接线与审批预检** ✅ 2026-10-23（单测 11/11；全量 335 中 334 pass/1 平台 skip；报告 dev-docs/progress-result/VR-阶段C-执行报告.md）
5. [x] S3.2 接线（article-inspect 先落地，check() 失败态；顺带修复局部变量 `check` 遮蔽 DSL 内建同名函数的 TDZ 缺陷）
6. [x] S4.2/S4.3 facade 预检 + 服务端锚点/审批展示（含 await check 接线）+ S4.4 Registry 契约三件套 + 审批链单测

**阶段 D · Registry 与微信路由** ✅ 2026-10-23（vr-approval 单测 17/17；全量 341 中 340 pass/1 平台 skip；报告 dev-docs/progress-result/VR-阶段D-执行报告.md）
7. [x] 两份 registry required 清空 + anyOfArgs + description + examples；facade 双通道名（vault_ref=article / vaultRef=dir）+ 四脚本接线（md_to_draft/prepare/publish/outline）

**阶段 E · 真机验收（§6 拆分）**
8. [ ] A 类：两机 Resolver 验收
9. [ ] B 类：Windows 业务闭环（锁定场景全程零绝对路径）+ Mac 验到凭证缺失报错 + 旧入参回归
10. [ ] §9 文档双更新
