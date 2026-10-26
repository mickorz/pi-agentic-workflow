# idea_to_article Phase C 执行报告（write + status）

- 日期：2026-10-24
- 范围：执行方案 §5.2 write/status、§7 状态机后段、§8 T06–T11/T17
- 前置：Phase B（6e3cbb7）已上线 start/turn；本阶段补齐生成链与只读查询

## 交付清单

| 交付物 | 位置 | 说明 |
|---|---|---|
| 生成链 workflow | `dev-examples/wx-article/scripts/idea_article_write.js` | brief_confirmed→大纲→正文→八维度审稿→draft_ready；修改文章/断点续写/确认大纲三分支 |
| 只读查询 workflow | `dev-examples/wx-article/scripts/idea_article_status.js` | 无 title=任务列表（含下一步提示映射）；有 title=单任务详情（文件清单+最近讨论） |
| idea_files.py 状态扩展 | `dev-examples/wx-article/scripts/draft_manager/idea_files.py` | STATE_SETTABLE +`stats.agentCount/durationMs/lastRunAt`、`approval.outline`；default_state 补 stats 结构与 approval.brief |
| 双 registry 注册 | `dev-examples/am-p0/registry.json`（21 条）、`dev-examples/wx-article/registry.json`（15 条） | idea-article-write（write）/idea-article-status（read-only） |
| e2e 测试 | `tests/unit/idea-article-write.test.ts` | 10 用例：T06/T07 全链、T08 大纲审批暂停+确认续写、T09 blocking 修复循环、T10 修改文章重生成、T11 断点续写、not_ready/already_done、T17 status 列表/详情/歧义 |
| 服务上线 | PM2 wechat-bot | auto-approve 扩列 `idea-article-write`（stop+start 换配置） |

## 关键实现决策

1. **审稿循环**：八维度 LLM（恰 8 条 schema 强校验），blocking>0 且 fixCount<reviewFixLimit（默认 2）→全文重写→复审；终态 blocking==0→draft_ready，否则留 reviewing+人工提示。6-review.md 用 ⛔/⚠ 前缀区分。
2. **大纲审批**：`config.outlineApproval`（article.yaml 正则读，state --set config.* 可改）=true 时大纲落盘后播报等待「确认大纲」return；确认轮复用现有 4-outline.md（断言未重生成）。
3. **修改文章**：意见进 Brief「## 确认记录」追加段（LLM 修订），状态回退 brief_confirmed→全链重生成（大纲+正文+审稿）。draft_ready 下无修改意见→already_done 引导交接。
4. **断点续写**：reviewing + 已有 5-article.md→跳过大纲/正文直接审稿（resume_review 分支）；outline_generated 已过审批→复用大纲直写正文。
5. **config 读取**：targetWords/reviewFixLimit/outlineApproval 从 article.yaml 行式正则解析（yaml 无解析依赖，与 idea_files.py render 格式对齐）。
6. **status 下一步提示**：NEXT_HINT 12 状态映射表，列表/详情播报共用。

## 验证证据

- `npx tsx --test tests/unit/idea-article-write.test.ts`：10/10 PASS
- `npm run build`：零错误
- `npm test`：468 tests，467 pass + 1 skip（平台），0 fail
- `run_resolver_suite.py`：18 PASS + 1 SKIP（P0 门禁不降级）
- `run_idea_files_suite.py`：47/47 PASS
- 服务状态：healthy（registry 21 条 sha 4f0cb594，auto-approve 4 流程）

## 偏差与遗留

- 真机全链验收（「继续写文章」→draft_ready→交接提示）与 Phase B 真机讨论闭环合并待验收——代码/e2e 层已闭环。
- `stats.durationMs/lastRunAt` 字段已开通道但 write 脚本本轮只记 agentCount（duration 属锦上添花，Phase D 按需补）。
- 审稿「八维度」硬编码在脚本 prompt 中（需求 F07 允许；如需配置化放 Phase D+）。
