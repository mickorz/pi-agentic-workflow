# idea_to_article Phase B 执行报告（start + turn）

- 日期：2026-10-24
- 范围：执行方案 §5.2/§5.3（idea-article-start / idea-article-turn）+ 双 registry 注册 + e2e（T02–T05/T13/T17）
- 状态：代码+测试完成并推送；真机讨论闭环（含重启续讨论）待用户验收

## 交付清单

| 文件 | 内容 |
|---|---|
| `dev-examples/wx-article/scripts/idea_article_start.js` | 任务启动 workflow：登记(init，含幂等/冲突/领养)→标题提取(路由缺省时 LLM 兑底)→三候选选题分析(实质区分校验: A/B/C + 核心观点去重)→落盘(2-topic.md+state)→播报 |
| `dev-examples/wx-article/scripts/idea_article_turn.js` | 讨论轮 workflow：locate 定位(精确→部分→澄清)→确定性意图分流(选A/B/C、确认方向、换方向、先暂停、默认=修改/补充)→分支处理(Brief 生成九段+确认记录 / 重新选题(自动备份旧卡到 .history) / 讨论记录 / paused)→播报 |
| `tests/unit/idea-article.test.ts` | 10 用例 e2e（见下） |
| `dev-examples/am-p0/registry.json` / `dev-examples/wx-article/registry.json` | 注册 idea-article-start / idea-article-turn（17→19 / 11→13；write，无 capabilities，不进 obsidian 预检） |
| `dev-examples/wx-article/scripts/draft_manager/idea_files.py` | 白名单补 `approval.brief`（pending/approved/rejected/not_required），default_state 同步 `approval.brief=not_required` |

## 关键实现决策

1. **确定性文件操作通道 = DSL `command()`**（argv 数组直调 python，零 shell 注入；journal 可回放），非此前计划的 exec-agent LLM 中转——发现 workflow-runtime 已提供 `command({executable,args,...})→{exitCode,stdout,stderr}`（workflow-runtime.ts:1013），更适合确定性工具调用；LLM 只做选题/Brief/播报。
2. **内容经 `--content-b64`**：command() 无 stdin 通道，中文/引号/元字符走 base64 argv（b64u 纯 JS UTF-8 实现，vm 域无 Buffer/btoa）。
3. **解释器探测缓存**：python3→python→py 逐个 probe（`-c 'import sys'`），结果缓存到模块级 PY_CACHE。
4. **幂等重播**（T03）：同 message_id 重复投递 → init 返回 idempotent + 已推进状态 → 重播现有候选（重播播报 LLM），不重复生成、不追加 messages。
5. **意图判定确定性优先**（V1 偏差，见下）：JS 正则分流四类决策词，长尾一律进「修改/补充讨论」分支（LLM 自由回应+记录，不改状态）。

## 测试证据

- `tests/unit/idea-article.test.ts` 10/10：T02 全链路（原文逐字/2-topic 结构/yaml 状态/labels 精确断言 LLM 调用序）、T03 幂等重播、T03b 冲突引导、T04 选B→Brief 落盘 brief_confirmed、T04b 已确认再选→already_confirmed 不重写、T05 修改讨论（状态不变+讨论段记录）、T13 暂停→paused、T17 换方向→重新生成+旧卡备份、含糊标题→编号澄清、零命中→引导创建。
- `run_idea_files_suite.py` 47/47（含 approval.brief 白名单扩展后回归）。
- 全量 `npm test` 458 tests / 457 pass + 1 platform skip；`npm run build` 零错；`run_resolver_suite.py` 18 PASS+1 SKIP（P0 门禁无回归）。

## 偏差记录（相对执行方案）

1. **无独立意图分类 LLM 轮**：决策词正则确定性分流 + 长尾默认讨论分支。理由：误分类风险最低的兜底语义（不推进状态、不落盘错误内容），省一跳 LLM；Phase C 视真机表现再决定是否加。
2. **文件操作走 `command()` 而非 exec-agent**（见上）：更确定、零 LLM 成本、journal 可回放；方案 §5 的「LLM 永不接触文件系统」约束反而更强（LLM 只产出文本，由脚本确定性落盘）。
3. **标题提取拆两段**：路由已提取 title 时直接用（零 LLM）；缺省时 workflow 内一次 LLM 兑底（schema 强约束 ≤20 字）。
4. **真机讨论闭环（含 T11 重启续讨论）待验收**：本报告仅覆盖代码+e2e；真机验收后补记（含 PM2 服务 restart 与 auto-approve 扩列）。

## 待办

- [ ] 真机：主话术「<灵感> 做成文章」→ 三候选 → 选/改/换/暂停 全分支实测
- [ ] 真机：重启服务后续讨论（T11：状态全在文件，天然续）
- [ ] PM2 服务 restart + auto-approve 扩列（obsidian-note-create,idea-article-start,idea-article-turn）
- [ ] Phase C：write（继续写文章）+ status + stale 传播真机链
