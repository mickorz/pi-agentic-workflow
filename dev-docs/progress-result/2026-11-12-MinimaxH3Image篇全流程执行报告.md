# 2026-11-12 MiniMax H3-Image 篇全流程执行报告

> 文章：《MiniMax H3-Image 凭什么 10 秒出一张 4K 图？16384 个 token 的算术题》
> 目录：`E:/Obsidian/newsky/60_Workspace/写作/单篇/20261112/Minimax H3-Image/`
> 结果：已入草稿箱（layout-html 分支，主题 wechat-anthropic），draft_media_id=RzpZN4Rc6PTdKELZiQHK7ehwqB2ci0pWHQDUuChNUaP9OeIpCVf-y2cnun_K5_Ag

## 执行概要

| 项 | 值 |
|---|---|
| 阶段 | 定位→写作→截图→提示词审批→生图→入文→humanizer→排版审阅→发布，全流程一次过 |
| 全文 | 8 章约 4000 字（标题+章题全 GEO 疑问句，三级审批制首批执行篇目之一流程变体：尾批单交+强制单独 2 章） |
| 配图 | 8 张 = 封面 1（黑铬快门隐喻，premium-black-chrome）+ 生成中心图 1（竖版 3:4 token 账单对比）+ X 引用截图 6 |
| 耗时 | 132 min（14:43→16:55），交互 4 次全部 confirm，返工率 0 |
| 发布 | publish --html-file layout.html（工作台切过主题走 layout-html 入箱分支）；封面 1922x818 自动缩放 1880x800 精确 2.35:1 |

## 关键节点记录

1. **引用图映射纠偏（C 阶段）**：X 推文配图与段落非顺序对应，视觉工具逐张核对后重排归属——首图实为双模型显存图（与第 7 章三模型版重复，弃用删除），PFLOP 对比图归第 5 章、立方体账单图归第 2 章。教训：下载后先识别内容再定归属，不按出现顺序想当然。
2. **生图链路**：relay 预检 [OK]；preview 封面一次过（文字三项零错）；zai 429 限流等待 210s 后恢复；batch 2/2 成功（含 01 中心图数字 16,384/65,536 全对）；文字审核 cover+token-bill 均 approved。
3. **humanizer 两遍法**：10 条建议改+5 条文体豁免（源自引用材料排比、金句收尾、标题回调），用户全批；对账重扫只碰 6 个改动章，事实零缺失（28 项关键数字/术语核对）。
4. **工具坑（待沉淀）**：edit 工具对样张段 oldText 匹配持续失败（python `in` 验证存在且唯一），改用 python 确定性替换完成；此前同会话出现过一次批量 10 条中单条失败整批回滚。疑似不可见字符或匹配实现差异，复现后再落 experience 文档。
5. **手机竖屏可读性验证（发布后补验）**：8 张图缩 390px 抽验 4 张（两张生成图+最宽长条图+文字密度最高架构图）——生成图强通过（01 中心图徽章小字仍 ≥11px）；引用截图呈"缩略看结构、点开看数字"常态，关键数字正文全部有承载。剩余 3 张与已验同源同型未逐张过视觉（zai 配额保守使用），后续篇目如需逐张全验建议错峰。

## 交付清单

- 正文 md（8 章 + 封面引用 + 8 张配图引用，对账 8=8）
- imgs/：cover-token算术.png、01-token账单对比.png + 6 张 X 引用图
- image-prompts.json / image-manifest.json / review-image-prompts.md / review-humanizer.md / humanizer-scan-cache.json
- article.yaml（digest 手工修正为导语；style: wechat-anthropic）/ layout.html / publish-state.json（status=drafted）
- time-log.jsonl（9 阶段 + 4 交互点）

## 遗留问题

- 微信后台公开发表待用户手动操作（草稿箱就绪，未定时发布）
- edit 工具匹配异常待复现沉淀（见上）
- zai 视觉分析 5 小时配额有限，多篇连跑时图片核对节奏需要预留窗口

## 经验索引

- 引用图先识别后归位：本报告关键节点 1
- X 引用截图与段落映射不信顺序：同上
- 发布链路坑位清单：`.pi/skills/gzh-article-craft/references/pitfalls.md`
