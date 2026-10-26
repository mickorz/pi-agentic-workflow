# AP-P1 执行报告：article pipeline 统一编排（inspect / prepare）

> 阶段：article_pipeline P1（统一父 Workflow 与状态检查）
> 日期：2026-10-23
> 需求依据：`dev-docs/planning/公众号文章统一处理流水线（article_pipeline）需求文档（V1.2）.md` 第七节 P1 清单 + 两轮评审执行顺序
> 状态：**确定性主干 Gate 全过（P1 套件 17/17 + P0 回归 46/46）+ inspect 真机冒烟通过；微信 Bot 链路（P1-WeChat）待服务加载新 registry 后真机验证**

## 交付清单

| 文件 | 职责 |
|------|------|
| `draft_manager/check_state.py` | 确定性只读状态检查（零写零网络）：正文定位（5.1 唯一合法/4.2 名称唯一定位）、yaml 字段、imgs 引用 vs 文件数（needs_insert）、cover 状态、publish-state 账号摘要、issues 与 prepare_ready；`--locate+--workspace` 多候选返回列表绝不猜 |
| `scripts/article_inspect.js` | inspect 工作流：受控执行 check_state.py（schema 强制透传 JSON）→ 确定性脚本拼状态报告 |
| `scripts/article_prepare.js` | prepare 工作流：状态检查 → **一次授权** checkpoint → 按需插图（复用 article_insert_images_meta，强制 `skip_humanize=true` 不改写正文）→ 插图后复查 → **显式参数**调 draft_manager/publish.py（title/digest/author/md-file/cover/account-slot 全部由检查结果传入，发布脚本不猜）→ 返回真实状态（add/update/reuse + unknown/locked 语义） |
| `scripts/wechat_md_to_draft.js`（重接） | 发布步骤改调 draft_manager/publish.py；新增 `account_slot`/`skip_confirm`/mock 透传；错误映射扩展 `[UNKNOWN]`(2)/`[LOCKED]`(3)；**旧 references/.../publish.py 不再被任何流程调用**（保留文件至 P2 清理） |
| `draft_manager/run_p1_gate_suite.py` | P1 Gate 套件（确定性主干，无 LLM） |
| registry 两处（wx-article + am-p0） | 新增 `article-inspect`(read-only)/`article-prepare`(external-side-effect)；obsidian-outline riskLevel 修正 read-only→write；wechat-md-to-draft schema 补 account_slot/skip_confirm |

## 关键实现决策

1. **inspect 只读边界（V1.2 4.1）**：检查逻辑全部在 `check_state.py`（代码级无写/网络路径），workflow 内 Agent 唯一动作是执行该脚本并透传 JSON；E 场景注入测试验证目录字节/mtime 级零变化。运行时级工具白名单（方案 B）仍留待后续。
2. **授权作用域（V1.2 6.2）**：prepare 一次 checkpoint 覆盖插图+草稿全程；子流程与发布脚本经 `skip_confirm` 透传——该参数仅在外层批准链生效时使用，不是通用绕过开关。
3. **两段式检查**：插图会改 md/yaml，故 prepare 在插图后重跑 check_state 再取显式参数，杜绝"Hash 按旧元数据算"的错位。
4. **Python 解释器真探测**：`command -v python3` 在 Windows 会命中 Store 占位符（存在但运行必败，exit 49）——真机冒烟当场抓到，改为试运行 `import sys` 的探测循环。三处 workflow 统一 `PY_PROBE` 模式。该问题即 `experience/windows-python-subprocess-gbk-and-python3-alias.md` 的变体，经验文档已可补充此形态。

## Gate 结果

**P1 套件（run_p1_gate_suite.py，17/17）：**

| Gate 条目 | 场景 | 结果 |
|-----------|------|------|
| 名称定位规则 | B（唯一命中/多候选停止/零命中） | PASS |
| 多 md 歧义 | B2（check_state 报告歧义且 prepare_ready=false——顺带修复了歧义时误取首候选的产品 bug） | PASS |
| inspect 零副作用 | E（目录字节+mtime 快照前后一致） | PASS |
| 缺图补图 | INSERT（needs_insert 识别 → insert_images.py 插入 → 复查就绪） | PASS |
| 完整文章直接复用 | PUB.reuse（draft/get 核对，无新草稿） | PASS |
| 元数据不丢失 | yaml 字节级不变（插图前后+发布后三次断言） | PASS |
| 插画重生成 | D（图片字节变 → update 同 media_id，无第二份草稿） | PASS |

**P0 回归：46/46（publish.py 未回归）。**

**工作流级冒烟：** `article-inspect` 真机跑《第一篇》：ok=true，报告正确（drafted / 5 张图全引用 / cover 就绪 / yaml 齐全 / 无问题）。

**validate：** article_inspect / article_prepare / wechat_md_to_draft 三脚本 pi-workflow validate 通过。

## 已知边界与遗留

1. **P1-WeChat 未验**：微信内"处理第一篇 → 一次授权 → 草稿就绪"需重启 wechat 服务加载 am-p0 新 registry（11 条）后真机验证；registry 已就绪，属用户手动步骤。
2. prepare 全链真机（真实改文件+真实 API）未跑：确定性主干已全绿，真机首跑建议挑一篇测试文章，验证后本报告补记。
3. wx-article 与 am-p0 两份 registry 本期手工同步（am-p0 为网关加载唯一聚合表）；自动生成/收敛留待后续。
4. 运行时级 Agent 工具白名单（inspect 方案 B）未实现，inspect 只读当前由脚本保证 + E 测试兜底。
5. `wechat-article-publish`（公开发表）按 V1.2 留 P2，暂不在默认链路。

## 经验沉淀

- `command -v python3` 探测在 Windows 不可靠（Store 占位符存在但必败）→ 统一改真探测循环（试运行 `import sys`），三处 workflow 落地。建议后续把 `windows-python-subprocess-gbk-and-python3-alias.md` 补充此形态。
