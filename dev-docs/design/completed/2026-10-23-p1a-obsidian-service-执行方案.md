# P1a ObsidianService 执行方案（基线：P1 评估 V2 + 用户终审约束）

> 日期：2026-10-23
> 定位：把 Obsidian 能力做成**独立基础接口层**（ObsidianReader / ObsidianWriter），微信灵感采集是第一个消费者，公众号文章线复用。
> 依据：《P1 Obsidian 独立接口层接入评估 V2》（用户已批准为基线，不再出 V3 评审）+ 用户终审两条实现约束（幂等、权限隔离）与两条测试补充（扫描上限、同步语义）。
> 原则继承：V1.2 六条设计原则（确定性/绝不猜/越权防护/审批一致性/部署无关/防框架化）原样生效。

## 0. 开工闸门（Phase 0）

| 项 | 状态 |
|---|---|
| P0 push 同步 | ✅ 2026-10-23 已推 `b30ca1d..af19855`（含阶段 A–D 全部提交） |
| Mac Resolver 门禁 | ✅ 18 PASS + 1 SKIP（case16 本机有真实配置，前置不成立） |
| Windows 门禁 + A 类同引用解析 | ⏳ Windows 机执行（见 §8 清单） |
| Windows B 类闭环（微信→审批→草稿） | ⏳ Windows 机执行 |

**闸门未全部闭合前不启动 Phase R 写码。**

## 1. 分层与代码落点

```
公众号 workflow / 微信灵感 workflow / 未来 HTTP·CLI
        │
        ▼
ObsidianReader（读面，全 workflow 可用）      ObsidianWriter（写面，仅受控入口）
  src/runtime/obsidian-reader.ts               src/runtime/obsidian-writer.ts
        │                                              ▲
        ▼                                              │ capability 门（§3）
Python 后端（纯 stdlib，零写零网络——writer 除外）        │
  vault_query.py（list/read/search）  vault_writer.py（create/append，stdin+台账）
```

- Reader 接口（明确类型，示意见评估 V2 §1）：
  - `listNotes({scope?, limit?})` → `{total, truncated, items:[{path, title, mtime}]}`
  - `readNote({path})` → `{path, title, content, size}`（独立全文契约，不受搜索列表 limit 约束）
  - `searchNotes({query, scope?, mode:'name'|'content'|'both', limit?})` → `{total, truncated, items:[{path, title, snippet, mtime}]}`
- Writer 接口：
  - `createNote({rel, content, operationId})` → 成功 / 冲突（已存在）
  - `appendNote({rel, content, operationId})` → 成功 / 拒绝（不存在）/ unknown（§2）

## 2. 写入幂等与安全（用户终审约束 #1）

### 2.1 operationId 台账（不做分布式幂等系统）

- `operationId` **服务端生成**（facade 预检时：`actionId + rel + contentDigest` 派生），写入 PendingAction.args，外部传入的同名参数一律覆盖（与 `vault_ref_pinned_rel` 锚点同款不信任策略）。
- 台账：机内 `ledger.jsonl`（追加式单行 JSON，位置=配置根下 `.obsidian-ops/`，gitignored）。状态机：
  1. 写前记 `started {operationId, rel, contentDigest}`
  2. 写成功 fsync 后记 `done {operationId, ...}`
  3. 重试同 operationId：`done` → **幂等成功，不重复写**；`started` 无 `done` → **unknown：报错禁止自动重试，提示人工核对**（不猜测磁盘结果）
- 单机单写者假设（每机一个网关进程）；台账追加用 `O_APPEND` 单行写，Windows 无 fcntl 时接受该假设并写入文档（不做跨机锁——云同步冲突明示交给同步工具，见评估 V2 §4.3-4）。

### 2.2 排他创建

- `createNote` 用 `os.open(path, O_CREAT|O_EXCL|O_WRONLY)`（Windows/macOS 均原生支持 O_EXCL）——**禁止**临时文件重命名路径（可能意外覆盖）。
- `appendNote` 用 `O_APPEND` 打开（不存在 → 拒绝并提示先 create）。
- 内容经 **stdin**（UTF-8，上限 1MB）；校验：rel 在 vault_root+scope 内、拒 `..`/symlink、create 要求父目录存在且为真实目录。

### 2.3 日志与持久化的内容暴露控制（用户终审补充）

- PendingAction 保存全文（执行需要，机内 jsonl，与现有凭证同级保护）；**审批卡只显示 `resolved_rel` + 操作类型 + contentDigest 前 8 位 + 预览 ≤80 字**。
- Run journal / DSL log / 调试输出：只记预览与 digest，**不落全文**；后端 stdout 不回显 content。

## 3. 读写权限在代码中真实隔离（用户终审约束 #2）

- 契约：`WorkflowRegistration.capabilities?: string[]`（registry 校验：含 `obsidian-write` 的条目 riskLevel 必须 `write|external-side-effect`，否则拒绝注册；digest 纳入该字段）。
- Runtime 注入：所有 workflow 的 DSL globals 注入 `obsidian`（Reader）；`obsidianWrite` **仅当** ①脚本 meta 声明 `capabilities:['obsidian-write']` 且 ②本次运行经审批链 `authorized` 启动（服务端传入，非 args）才注入。
- **禁止**任何 `authorized:true` 形态的参数判权；read-only workflow 的脚本里引用 `obsidianWrite` 直接 ReferenceError（未注入）。
- 两个写 workflow 独立注册：`obsidian-note-create` / `obsidian-note-append`（riskLevel=write，走既有审批链与去重）。

## 4. 查询契约与扫描上限（用户测试补充 #1）

- 统一列表契约：`{total, truncated, items:[{path, title, snippet(≤120字), mtime}]}`，`limit` 默认 20，排序=路径字典序（确定性，写进门禁）。
- 扫描上限（防大文件拖垮微信请求）：单文件 >2MB 跳过并计入 `skipped_large`；扫描预算 10s，超时停止并 `truncated=true`（`truncated_reason: scan_budget`）；snippet 单条 ≤120 字。
- `readNote` 独立全文契约：单文件 ≤512KB 全文返回，超限报错带尺寸（不套用列表 limit）。
- P0 vault_resolver.py 的定位契约与配置链**不动**（19 条门禁不降级）。

## 5. 配置（评估 V2 §4.5 落地）

- 顺序（新后端 vault_query.py / vault_writer.py）：flag > `OBSIDIAN_VAULT_ROOT` env > 仓库根 `obsidian.config.json`（新增，gitignored，键 `vault_root`/`scope_aliases`）> 兼容 `.aws-article/config.json`（只读兼容）。
- resolver 保持 P0 链不变；文档明示两套并存、以新链为准。
- `.gitignore` 追加：`obsidian.config.json`、`.obsidian-ops/`。

## 6. 阶段划分（用户锁定顺序）

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| Phase 0 | P0 闸门（push✅/门禁✅/Windows 待办） | §8 清单全绿 |
| R | vault_query.py（list/read/search+上限）→ TS ObsidianReader → DSL 注入 `obsidian` → 单测（命中/零命中/truncated/大小写/scope/大文件跳过/预算超时/排序稳定） | 单测全绿 + build 零错 + P0 门禁回归 |
| W | vault_writer.py（O_EXCL/O_APPEND/台账/unknown）→ ObsidianWriter → capabilities 契约三件套（contracts/registry/digest）→ facade 预检（operationId+锚点+审批卡预览）→ 单测（冲突拒绝/幂等重试/unknown 拒自动重试/毒字符串/scope 越界/read-only 无 writer） | 同上 |
| F | obsidian-note-create.js / obsidian-note-append.js + 两份 registry + description 路由提示 | parseWorkflowScript + registry 断言 + 审批卡渲染 |
| V | 真机验收（§7）+ 文档双更新 + path-scoped commit | §7 场景两机可重复 |

每阶段：门禁 → build → 全量 test → 方案 §9 打勾 → progress 双文件夹更新 → pathspec commit。

## 7. 验收（用户锁定场景）

1. 微信：「把下面这段 AI 灵感保存到 Obsidian 的灵感目录，标题叫《AI 自动化测试》。」→ 冲突检查 → 审批卡（目标+操作+预览）→ 批准 → O_EXCL 创建 → 回复真实文件位置。
2. 微信：「搜一下自动化测试相关的笔记」→ 检索到刚创建内容（列表契约+snippet）。
3. 幂等：同 operationId 重试 → 幂等成功零重复；模拟 started-无-done → unknown 报错人工核对。
4. 跨设备同步语义（用户测试补充 #2）：**本机写入成功** 与 **云同步完成后另一台机器可读** 分别断言；同步延迟不判 Service 错误（等同步完成的轮询由人工/验收脚本做，不进 Service 语义）。
5. 回归：P0 19 条门禁 + 全量套件不降级。

## 8. Windows 闸门清单（Phase 0 收尾）

1. `git pull` 后 `npm ci && npm run build && npm test`。
2. `python dev-examples/wx-article/scripts/draft_manager/run_resolver_suite.py`（预期 symlink 用例 SKIP，其余 PASS）。
3. 建机内配置：`obsidian.config.json`（vault_root=`E:/Obsidian`）或 `.aws-article/config.json`。
4. A 类：两机解析同一逻辑引用（如 `60_Workspace/写作/单篇/AI名词解释/从零学AI- 9 个常见 AI 术语，不懂技术也能看懂 4/从零学AI - AI模型原理术语`，或仅文章名 `从零学AI - AI模型原理术语`）结果一致（两机应同为 `resolved_rel=60_Workspace/写作/单篇/AI名词解释/从零学AI- 9 个常见 AI 术语，不懂技术也能看懂 4`、`md=从零学AI - AI模型原理术语.md`）。
5. B 类：真实微信 →「帮我检查一下《…》然后放到草稿箱」→ 审批卡 → 批准 → 公众号草稿创建成功；Mac 侧发布类停在凭证缺失明确报错；旧入参（article_dir/article_name）回归。

## 9. Checklist

- [ ] Phase 0 Windows 闸门（Windows 机待办，不阻塞 Mac 推进）
- [x] Phase R Reader（2026-10-24：vault_query.py + ObsidianReader + DSL `obsidian` 注入；361 测试 0 fail、build 零错、P0 门禁回归 18 PASS+1 SKIP 不降级）
- [x] Phase W Writer（2026-10-24 完成，commit 见 P1a-PhaseW 执行报告；偏差：operationId 由 userId|workflowId|rel|contentDigest 派生而非 actionId，保证 facade 去重稳定）
- [x] Phase F 两 workflow（2026-10-24 完成，含第三个只读检索流程 obsidian-note-search 补充——§7.2 微信搜笔记需要可路由入口；三脚本+双 registry+审批卡端到端单测 4/4，全量 390 tests 389 pass）
- [x] Phase V 真机验收 + 文档（2026-10-24 完成：本地全链路 E2E 3/3——审批卡→confirm→O_EXCL 创建→幂等/检索/append/unknown 全断言；全量 393 tests 392 pass；真机微信通道、跨机云同步、Windows 侧门禁为待办移交用户）

## 10. P1a 后暂停原则（用户终审）

P1a 交付后**暂停 Obsidian 基础设施开发**：用它真实产出公众号素材、记录灵感、复用历史内容；tags/反链/语义检索是否立项由实际使用数据决定，不提前重实现 Obsidian 全能力。

## 11. 修订记录

| # | 内容 |
|---|---|
| 1 | 初版（基线=评估 V2 + 终审约束：operationId 台账/O_EXCL/unknown 态；Reader·Writer 接口隔离+capability 门+禁 authorized 参数；扫描上限与同步语义测试；Phase 0 闸门含 Windows 清单；暂停原则） |
