# P1a Phase F（obsidian workflow 上线）执行报告

- 阶段：P1a · Phase F — 两个写 workflow（方案 §6 F：obsidian-note-create / obsidian-note-append）+ 补充只读检索流程
- 日期：2026-10-24
- 状态：✅ 完成（Mac 侧）

## 交付清单

| 交付物 | 位置 | 说明 |
|---|---|---|
| 创建笔记 workflow | `dev-examples/wx-article/scripts/obsidian_note_create.js` | meta.capabilities=['obsidian-write']；写入前校验（rel/content/operationId）→ `obsidianWrite.createNote`（O_EXCL）→ agent 播报（回复真实文件位置）；日志只记 rel/status/operationId 不落全文（§2.3） |
| 追加笔记 workflow | `dev-examples/wx-article/scripts/obsidian_note_append.js` | 同上，`appendNote`（O_APPEND 不存在拒绝） |
| 检索笔记 workflow | `dev-examples/wx-article/scripts/obsidian_note_search.js` | 只读 `obsidian.searchNotes`（query/scope?/mode?/limit?）；agent 播报命中清单（≤10 条+更多提示） |
| 双 registry 注册 | `dev-examples/wx-article/registry.json`（6→9）/ `dev-examples/am-p0/registry.json`（11→14） | 写流程 riskLevel=write + capabilities=['obsidian-write'] + required[rel,content]；检索 read-only + required[query]；description 含路由提示（保存灵感/记笔记/搜笔记）+ examples |
| 单测 | `tests/unit/obsidian-workflows.test.ts` | 4 用例（下详） |

## 验证证据（Mac）

- `npx tsx --test tests/unit/obsidian-workflows.test.ts`：4/4 PASS
  1. parseWorkflowScript：三脚本可解析；create/append capabilities=['obsidian-write']；search 无 capabilities
  2. 双 registry：三个流程全量在册（loadFromFile issues=[]）+ 契约（write/read-only/capabilities/required/scriptPath 落盘/description 路由关键词）
  3. registry 存量不回归：wx-article 9 条 / am-p0 14 条
  4. 端到端：registry 实条目 → facade 预检（fixture vault）→ needsApproval + operationId 16hex → 审批卡（流程/目标/操作：创建笔记+digest8/预览）
- 全量 `npm test`：390 tests，389 pass，0 fail（1 平台 SKIP）
- `npm run build` 零错误；P0 resolver 门禁回归 18 PASS + 1 SKIP（不降级）

## 设计说明与偏差

1. **第三个只读流程 obsidian-note-search**：方案 §6 Phase F 只列两个写 workflow；§7.2「微信搜笔记→检索到刚创建内容」验收需要可路由的检索入口，故补注册只读流程（read-only，无 capabilities）。属增补非偏离，已在方案 §9 勾选行注明。
2. **agent 播报步**：runtime 强制 workflow 至少一次 agent() 调用（纯计算不应建 workflow）；写流程用它生成用户确认文案（回复真实文件位置），检索流程用它把命中清单转成可读回复。prompt 不含笔记全文（写流程只传 rel/status；检索传命中 items 摘要，本就是 snippet 级）。
3. registry 双份 scriptPath 前缀差异维持既有约定：wx-article 用 `scripts/…`（scriptsRoot=dev-examples/wx-article），am-p0 用 `wx-article/scripts/…`（scriptsRoot=dev-examples）。

## 遗留

- Phase V：真机验收（微信保存灵感→审批→O_EXCL 创建→检索闭环；幂等重试真机复现）+ 文档双更新 + Windows 侧门禁。
