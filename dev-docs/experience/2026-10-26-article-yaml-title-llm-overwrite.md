# article.yaml 标题被 LLM 建议覆盖（原题丢失）

日期：2026-10-26 ｜ 阶段：WX-P3.1 ｜ 关联：article_insert_images_meta.js

## 问题现象

用户报告：「发布的草稿，把我原文的标题都改掉了。明明标题应该是《订单暴涨10倍，月销10万+，一家轻食店是如何通过AI做到的》」。
实际草稿标题被换成《订单、小票、海报、剪辑：一家轻食店的 4 个 AI 改造场景》——LLM 现编的概括式标题，digest 同为 LLM 生成。

## 排查过程

- 文章目录（vault: 01｜一家轻食店的四个 AI 改造场景/）在 prepare 前无 article.yaml；正文 md 首行为加粗引语，**没有 H1**，文章正题只存在于 md 文件名。
- 插图工作流 `article_insert_images_meta.js` 元数据 agent 的 title 规则为「优先用原 title；**若原 title 明显与本文不符则用 suggested_title**」：
  - 无原 yaml 时 LLM 建议直接当选（本次触发）；
  - 有原 title 时也给了 LLM「明显不符可替换」的裁量权（潜在触发）。
- scan agent 的 suggested_title 风格参考是术语罗列式（"RAG、Embedding……"），与案例叙事文天然不匹配，越权替换必然改味。

## 根因

title 的取值优先级把 LLM 建议放在了确定性来源之前/并列，且允许 LLM 自行判断「原题不符」。本仓约定**正文 md 文件名即文章原标题**（vault 单篇目录正文用内容化文件名，H1 常缺失），这是确定性信号，不应让 LLM 覆盖。

## 解决方案

`article_insert_images_meta.js`（commit 见 WX-P3.1）：
- 扫描后确定性计算 `mdStem = md 文件名去 .md 扩展名`；
- meta agent title 规则改为硬优先级：**①用户 args.title ②原 article.yaml title 原样保留 ③mdStem（文件名即原题）**，suggested_title 仅三者全缺才可用，并明文禁止「以原标题与内容不符为由替换」；
- digest 同步收紧：原值原样保留，缺失/为空才用 suggested_digest（删掉「若与本文不符则用」）；
- 无图早退路径的输出 title 同样改为 `args.title || mdStem || suggested_title`。

线上数据修复：article.yaml title 已直接改回原题。重跑 publish.py 更新草稿被微信拒绝 `errcode=53407: 定时发布中，无法删除或修改`——该草稿已在后台被设置定时发布，需先取消定时再更新（API 层无解，非本仓 bug）。publish-state 完好（contentHash 仅在 API 成功后落盘，失败不写，重跑仍会走 draft_update）。

## 预防/注意事项

- 生成元数据时，凡存在确定性来源（文件名/已有字段）的字段，LLM 只能兜底，不能覆盖；提示词里不要写「若不符则替换」这类开放裁量。
- WeChat 草稿被设定时发布后 draft_update 一律 53407；处理顺序：后台取消定时 → 重跑 publish.py（会因 hash 未变自动走 update）→ 用户重新定时。
