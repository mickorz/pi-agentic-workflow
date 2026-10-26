# P1a Obsidian 微信 Bot 话术编排表

> 日期：2026-10-24 · 用途：为 `obsidian-note-create / obsidian-note-append / obsidian-note-search` 三个 workflow 编排微信触发话术
> 使用：在「触发话术」栏填写你选定的固定句式；router 靠 registry 的 description/keywords/examples 匹配，话术自然语言即可
> 关联：能力详情见 `dev-docs/guides/2026-10-24-p1a-obsidian-manual-test.md`；执行方案 `dev-docs/design/2026-10-23-p1a-obsidian-service-执行方案.md`

## 一、能力总表（P1a 新增）

| Workflow | 风险级 | 交互 | 功能 | 关键参数 |
|---|---|---|---|---|
| `obsidian-note-create` | write | 需审批（回复「批准」） | 新建笔记，O_EXCL 排他（已存在绝不覆盖） | `rel`（vault 相对 .md 路径）、`content`（全文 ≤1MB） |
| `obsidian-note-append` | write | 需审批 | 向已有笔记尾部追加（不存在的笔记拒绝） | 同上 |
| `obsidian-note-search` | read-only | 直启，无审批 | 检索笔记（标题/内容/两者），大小写不敏感 | `query`、`scope?`、`mode?`（name/content/both）、`limit?` |

## 二、触发话术（待填写）

### 1. 保存灵感（obsidian-note-create）

**✍ 已定稿主话术**：「<内容> 保存到灵感」（如「xxxxxx 保存到灵感」）

**派生规则（话术语义契约）**：
1. agent 对内容进行分析，提取标题（从内容中提炼简短标题）
2. 用标题创建文件夹：`rel = 灵感/<标题>/idea.md`（LLM 提取风格即可）——**服务端锚定**（2026-10-24）：仓库根 `obsidian.config.json` 的 `scope_aliases`（灵感→60_Workspace/写作/灵感）+ `file_aliases`（idea.md→1-idea.md）在 facade 预检强制改写，最终落点 `60_Workspace/写作/灵感/<标题>/1-idea.md`，LLM 路径漂移不影响落点
3. `content` = 原文全文（不改写）

例：「AI 工作流三要素是触发、工具、审查，缺一不可。保存到灵感」→ 落点 `灵感/AI 工作流三要素/idea.md`，正文为原句全文。

流程预期：审批卡（目标/操作/内容摘要 8 位/预览 ≤80 字）→ 回复「批准」→ 确认回复含真实文件位置（`60_Workspace/写作/灵感/<标题>/idea.md`）

| 触发话术 | 备注（适用场景/变体） |
|---|---|
| 「<内容> 保存到灵感」 | ✅ 主话术；agent 提取标题 → 建锚定落点 `60_Workspace/写作/灵感/<标题>/1-idea.md`，正文=原文（免审批：--auto-approve obsidian-note-create） |
|  |  |

边界场景话术（可选填写）：
- 同标题重复保存（`60_Workspace/写作/灵感/<标题>/idea.md` 已存在 → O_EXCL 预检拒绝）：引导「换标题重发」或改说「追加笔记 60_Workspace/写作/灵感/<标题>/idea.md：…」：＿＿＿＿
- 重新保存同样内容（幂等，不会重复写）：＿＿＿＿

> 待办：把主话术与派生规则反哺进 registry `obsidian-note-create` 的 `description/examples`，保证路由与参数提取稳定。

> ✅ **已落地（2026-10-24）**：`vault_writer.py` create 分支支持**逐段自动创建父目录**（每段拒绝符号链接，失败回滚不留半成品；文件本身仍 O_EXCL 排他）。属方案 §2.2「create 父目录存在」的显式偏差（用户拍板）。验证：单元/E2E 32 项 + 全量 393 tests 392 pass；主话术已反哺进双 registry `obsidian-note-create` 的 description/examples。

### 2. 追加笔记（obsidian-note-append）

话术要素：**目标路径 + 追加内容**
流程预期：审批卡（操作：追加内容）→ 批准 → 文件尾部追加
边界：目标不存在 → 预检直接拒绝，不建审批卡

| 触发话术 | 备注 |
|---|---|
|  |  |
|  |  |

### 3. 搜笔记（obsidian-note-search）

话术要素：**关键词**，可加范围（`scope` 如 灵感）与方式（按标题/按内容）
流程预期：免审批直启，回复命中清单（前 10 条 + 总数/是否截断）

| 触发话术 | 备注（scope/mode 变体） |
|---|---|
|  |  |
|  |  |
|  |  |

## 三、存量 vault 相关 workflow（非 P1a，话术避免混淆）

| Workflow | 交互 | 一句话功能 |
|---|---|---|
| `obsidian-outline` | write + 审批 | 生成 vault 目录大纲（走 vault_ref 解析通道） |
| `article-inspect` | read-only | 查看文章状态 |
| `article-prepare / article-publish / wechat-md-to-draft` | external-side-effect + 审批 | 文章管线（vault_ref 通道） |

## 四、话术设计备忘

- 路由依据：registry `description/keywords/examples`（create 含「保存灵感/记笔记」，append 含「追加」，search 含「搜笔记/检索」）；如需更准路由，可把选定话术反哺进 registry `examples` 字段
- `content` 尽量在一条消息里给全（跨消息补参支持，但多一轮确认）
- 审批决策词固定：「批准」「拒绝」（可带编号）；create/append 不会绕过审批直接执行（CLI 直跑会因无授权被拒，属设计行为）
- 内容不会回显到审批卡/日志（只记摘要与预览），可在话术里承诺隐私
- 填写完成后：如需我把选定话术固化进 registry `examples` 或补进手动测试指南，直接说一声
