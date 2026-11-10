# 小绿书标题上限实测 20 字（draft/add 不拦、后台拦）

## 问题现象

2026-11-10 首发小绿书用了 32 字标题「MiniMax 团队自用 Claude Code 工作流全开源了」，`publish.py --xiaolvshu` 照 `STICKER_TITLE_MAX = 32` 的设定原样入箱成功（`[5] DRAFT OK`）。用户在公众号后台发现：小绿书（图片帖）标题实际只允许 20 字。

## 排查过程

- 查 `publish.py`：`STICKER_TITLE_MAX = 32 # 微信 newspic 标题上限`——截断护栏本身就是按 32 写的（源头是 AP-S0 设计文档">32 字截断"），没有去核微信侧真实规则
- draft/add 接口对 32 字 newspic 标题**不报错**，超限只在后台编辑/发表时才暴露——接口不拦造成了"32 是上限"的错觉

## 根因

拿"接口不报错"当"规则不存在"。newspic 的 title 真实约束在后台 UI 层（20 字），草稿接口层宽松，两处限制不一致时必须以后台（用户实际发表的地方）为准。

## 解决方案

三处 32 → 20（2026-11-10，commit 见 git log）：

1. `publish.py`：`STICKER_TITLE_MAX = 20`（超长截断打印同步）——Gate 套件 T9 断言 32→20，33/33 全绿
2. `sticker_cards/validate_pages.py`：`TITLE_MAX = 20`（pages.json 门槛，规划产物直接拦）——Example 20/20 全绿
3. `wechat_sticker_cards.js`：规划 agent 提示词 "title <=32 字" → "<=20 字（微信小绿书后台标题上限）"，从源头不让规划产出超限标题

存量返工：首发草稿以新标题「Claude Code 自用工作流开源了」（20 字）走 `draft_update` 原地更新（media_id 不变，`[5] DRAFT OK ... (updated)`）——顺带补上了"draft_update 对 newspic 真实行为"的真机验证（此前 mock 已覆盖、真机未测）；`pages.json.title` 同步改 20 字，重 normalize 后审图幂等继承，无需重渲。

## 预防/注意事项

- 新标题/配文定稿前先过 `len()`；规划 agent 产出的 pages.json 由 `TITLE_MAX=20` 硬门兜底
- pages.json.title 与 args.title 保持一致：两者都进 hash（sticker v1 域），不一致会导致下次不带 `--title` 重跑时 hash 漂移、触发无谓的 draft_update
- 历史文档（AP-S0 设计/卡片化方案 V1.1）里的"32 字"为当时错误认知，以本文与代码为准
- 同类风险点：配文 1000 字上限也是"接口值"，后台若实测更严，按本文同路径修正
