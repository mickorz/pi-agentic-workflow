# xiaolvshu skill 拆分执行计划（小绿书创作流程独立化）

> 日期：2026-11-10
> 依据：dev-docs/todos/2026-11-10-小绿书独立skill拆分.md（用户定案：流程与文章线差异大，无法兼容，拆独立 skill）
> 定位：skill 是**编排与规范层**——教"何时做、按什么标准做、怎么审批、怎么救火"；确定性执行已由 sticker-cards workflow 与 sticker_cards 脚本族承载，skill 不复制其内部实现。

## 一、目标与不做的事

**目标**：新建 `.pi/skills/xiaolvshu/`，仅凭该 skill 可完整引导一次小绿书（图片帖）制作+发布，不需要翻 gzh-article-craft 或 dev-docs。

**不做（明确排除）**：

- 不改 workflow（`wechat_sticker_cards.js`）、不改 registry（workflowId `sticker-cards`、keywords 保持）、不改发布脚本——执行层已就绪且过 Gate B，动它们是另一个量级的活
- 不做多平台适配（小红书 App 等）——架构原则"真实需求出现再扩展"
- 不迁移历史文档（planning/design 报告保持原样，skill 提纯引用）
- 不做自动发表（freepublish 对 newspic 未验证，保持后台手发）

## 二、现状基线（已核实，2026-11-10）

| 组件 | 现状 |
|---|---|
| skill 目录 | `.pi/skills/` 现有 diagram-design / gzh-article-craft / humanizer；`xiaolvshu` 无冲突。范式：`SKILL.md`（frontmatter: name/display_name/description/description_zh）+ `references/` 子目录（gzh-article-craft 先例） |
| gzh-article-craft | 全文无小绿书/贴图/newspic 字样（已 grep 核实），拆分无删除面，只需加防误路由一行 |
| 规范散落点 | workflow 脚本（编排+agent 提示词内嵌）、CLAUDE.md 术语节、AP-S1 方案/报告、experience 四篇（title-20 / cover-newline / review-misread / runner-timeout）+ pi-workflow-non-tty-checkpoint-pipe |
| 实战案例 | mcode-stack 首发全链（含标题返工、审图误读推翻、断点续跑、draft_update 真机验证），素材齐备可提纯 |

## 三、关键决策（D1~D5，附倾向）

- **D1 命名**：skill 目录与 name 用 `xiaolvshu`（用户定案）；workflowId 保持 `sticker-cards` 不动（registry/Gate B 存量不动）。skill 与 workflow 同仓不同层，名字不必一致，SKILL.md 里写清对应关系。
- **D2 形态**：`SKILL.md`（主流程+规范正文）+ `references/pitfalls.md`（编号坑清单）。对齐 gzh-article-craft 确立的两件套模式；坑清单会持续增长，独立成文件便于追加且不撑爆主文件。
- **D3 边界**：skill 给 CLI **契约表**（命令+关键参数+输出字面量），不贴脚本源码；执行细节以"workflow 一键优先、手动驱动兜底"两条路径组织。
- **D4 经验处理**：坑以**精简条目内联**进 pitfalls.md（现象+一句话解法），每条尾注 dev-docs/experience 全文路径——skill 随仓库分发，仓库内相对引用永远有效。
- **D5 偏好接入**：对齐 gzh-article-craft 的惯例，SKILL.md 开头接 `preference.md` 偏好登记册（小绿书口味如封面钩子风格、断行偏好、发布时机等今后当场登记）。

## 四、SKILL.md 章节草案（T1 的写作蓝图）

```text
---
name: xiaolvshu
display_name: 小绿书创作全流程
description: 素材(README/笔记/截图/文章)->成套 3:4 小绿书卡片(封面+内容页)->审图->发布小绿书(newspic 入草稿箱,后台手发)。
             Use when 用户要把素材"做成小绿书/做成卡片/发布小绿书/贴图"。
description_zh: 素材到成套卡片、审图、newspic 入草稿箱的小绿书生产全流程，含页面规划容量纪律与踩坑规避清单。
---

# 小绿书创作全流程（xiaolvshu）
1. 术语与边界        贴图=小绿书(newspic)；适用/不适用（长文走 gzh-article-craft——防误路由反向指引）
2. 流程总览表        规划->规划审批->制作(截图预处理/可选AI生图付费门/渲染)->规范化->审图->发布授权->入箱->后台手发
3. A 页面规划        素材三问(讲什么/给谁看/钩子) -> pages.json 契约要点(页1必cover/页数1~9/layout枚举)
                    容量纪律: h-display ≈7汉字/行 quote ≈13字/行 封面--chars自适应 -> 手工断行防孤字尾行
                    标题<=20字(三处护栏) 封面钩子与发布标题一致 页面结构不重复
4. B 制作            路径一: workflow 一键(pi-workflow run wechat_sticker_cards.js, args 契约表+checkpoint 说明)
                    路径二: 手动驱动脚本族(CLI 契约表: validate/build/prep/normalize/verify/mark_review/publish_sticker_cards)
                    截图规则(contain 禁 cover/尺寸实测) 渲染字体降级 --only 单页重渲(多次--only只生效最后一个)
5. C 审图            审图清单+分类型标准；审图 agent"疑似截断"必须 zai 亲核；mark_review 结构化落 APPROVED
6. D 发布            两阶段授权(prepare 指纹->人工批准->execute 同指纹) draft_update 原地更新(40007 自愈)
                    后台手发(无自动发表) hash 一致性(title/content 变更=新授权)
7. 断点续跑与救火    resume --non-interactive 等待态 / printf 'y\n'|resume --yes / 瞬超时先手动复跑再 resume
                    UNKNOWN 恢复(--resolve-media-id/--clear-pending) / 审核重置触发条件(pages.json 变更需重 normalize)
8. 首发实战索引      mcode-stack 案例(2026-11-10)关键节点回放
```

`references/pitfalls.md` 提纯清单（首版 ≥10 条，每条：现象/一句话解法/全文路径）：标题 20 字三处护栏、封面 `\n` 被吞、审图误读、RUNNER 瞬超时、resume 管道喂 y、`--only` 重复传参、normalize 忘重跑导致 verify 失败、字体下载超时降级、hero 过扁图不用、`--cards-dir` 传成文章目录、GBK 代码页 `--json` 解析。

## 五、任务拆解

| 阶段 | 工作内容 | 产物与验收 |
|---|---|---|
| T1 | 写 `.pi/skills/xiaolvshu/SKILL.md`（按第四节蓝图；素材来源：workflow 脚本注释、AP-S1 方案 D3~D9、experience 四篇、mcode-stack 实战） | SKILL.md 就位；frontmatter 四字段齐全；八章节覆盖蓝图全部要点 |
| T2 | 写 `references/pitfalls.md`（编号坑清单，按第五节列表提纯，每条带全文路径） | pitfalls.md ≥10 条；每条含"一句话解法"与 experience 路径 |
| T3 | 路由接线：gzh-article-craft SKILL.md 加一行防误路由（"小绿书/卡片/贴图 → xiaolvshu"）；仓库根 CLAUDE.md 术语节补 skill 登记 | 两处各 ≤2 行 diff；grep 可见互相指引 |
| T4 | 确定性验证（Gate A+B）：① `skill_search("小绿书/做成卡片")` 命中 xiaolvshu；② skill 加载走查——拿 mcode-stack 实战做纸面对照（skill 正文能否回答：20 字谁拦/审图误读怎么办/`--only` 怎么传/断点怎么续），答不上即返工 | 检索命中 + 走查清单全过；不达标条目回改 SKILL.md |
| T5 | 真实验证（Gate C）：下一次真实小绿书素材按 skill 全链走通（规划→发布入箱），过程新增的坑回填 pitfalls.md | 全链成功 + todos 文档标 DONE（移入已完成惯例同 planning）；此时才提交"毕业" |

## 六、验收门

- **Gate A（静态）**：SKILL.md/pitfalls.md 落盘，frontmatter 合规，引用路径（experience/脚本 CLI）逐一存在
- **Gate B（检索与走查）**：skill_search 命中 + mcode-stack 纸面走查全过
- **Gate C（真实）**：下一个真实素材按 skill 独立走通全链（不走通不标完成，对齐 GZH-P2 先例）

## 七、风险与备注

- skill 正文与 workflow 提示词存在双源（规划规范同时活在 wechat_sticker_cards.js 的 agent prompt 里）——本次不改 workflow，skill 里声明"以 skill 为规范源、workflow 提示词为执行快照"，后续 workflow 改提示词时对照 skill 同步（登记为 follow-up）
- 20 字上限若微信侧再变，只动 publish.py/validate_pages.py 两个护栏 + pitfalls 一条，skill 正文写"以护栏代码为准"避免三处漂移
- 估算：T1+T2 一个会话内完成；T3 分钟级；T4 半小时内；T5 取决于下次真实素材
