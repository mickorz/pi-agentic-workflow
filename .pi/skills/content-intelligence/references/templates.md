# 模板（templates）：样本记录 + 研究报告

> 两套模板：样本记录（存 `content-intelligence/samples/<主题域>/`）与研究报告（存 `content-intelligence/research/`）。
> 字段定义依据 P0 执行方案 D5/D8/D9/D10（2026-11-11 评审定案），改模板先改方案。

## 一、样本记录模板

一条样本一个 `.md` 文件，YAML 块 + 正文简析。文件名 `<采集日期>-<平台>-<主题关键词>.md`。

```markdown
---
source:
  url: "https://..."            # 原始链接（转载按原始出处计一条）
  platform: juejin              # zhihu/juejin/sspai/github/bilibili/youtube/blog/hn/medium/x/other
  author: "作者名"
  published_at: "YYYY-MM-DD"    # 未知写 unknown，不猜
  collected_at: "2026-XX-XX"    # 采集日期，必填

title: "样本原标题（原文照抄，不改写）"

content_format: long_article    # D10: long_article/short_video/image_post/tutorial/social_post
content_type:
  primary: 需求场景型            # 八类之一，见 content-types.md
  secondary: null               # 复合类型时填，否则 null

evidence:                       # D8 证据分级
  level: A                      # A=完整正文+标题+结构+公开表现数据；B=正文+标题，数据不全；C=仅标题摘要+部分互动数
  title_verified: true
  full_content_read: true
  metrics_verified: true        # 有至少一项真实采集到的表现数字才算 true

performance:                    # D5 表现分层：必须有数据依据，禁止凭内容质量或主观感觉判定
  tier: medium                  # high 爆款 / medium 良好 / normal 普通 / unknown 无法判断
  basis: same_platform_comparison  # 判定基准说明；unknown 时写 unknown_basis 并说明缺什么
  metrics:                      # 三值规则：真实数字（注采集日期）/ N/A 平台不公开 / 未采集（附原因）
    views: N/A 平台不公开
    likes: 3200                 # 采集日期 2026-XX-XX
    comments: 180
    favorites: N/A 平台不公开
    shares: N/A 平台不公开

structures:
  title_pattern: "数字+身份代入疑问句"     # 标题结构
  opening_pattern: "场景痛点第一段直入"     # 开头如何留人（前 3 段）
  body_pattern: "痛点→案例→流程→建议"      # 正文组织

value:
  problem_solved: "企业历史文档如何接入 AI 的落地路径"   # 解决什么问题
  increment: "给出了成本区间和实施周期数据"              # 提供什么增量

spread_mechanism: "收藏价值：决策清单可带走"            # 为什么值得收藏/转发/讨论

takeaways:
  adopt: "成本数据实名化写法，增强可信度"
  avoid: "方案部分跳步，落地细节不足"
---

## 简析（3~5 句）

正文用几句话补充 YAML 放不下的上下文：为什么选这条样本、与同主题其他样本的关系、
分类或分层判定依据（引用同平台对比数据）。
```

字段纪律（违反任一即该样本无效）：

1. `url`/`platform`/`collected_at` 缺一不收
2. metrics 出现无出处的数字 → 无效（宁空勿编）
3. tier 无 basis 依据 → 必须改 `unknown`
4. 转载多渠道 → 按原始出处计一条，转载链接写进简析备注

## 二、研究报告模板（content-research.md）

存 `content-intelligence/research/YYYY-MM-DD-<主题>.md`。九段结构，全部非空才算完成。

```markdown
# 选题研究：<选题名>

> 研究日期：YYYY-MM-DD ｜ 研究人：agent + 用户确认 ｜ 状态：待人工确认

## 1. 选题与目标读者

选题一句话；目标读者（身份+处境）；预设内容类型（八类，可改）；本篇想验证的问题。

## 2. 搜索过程

使用的关键词组合（选题词+平台词+表现词）、平台清单、搜索日期、各平台命中情况。
搜索不到的盲区如实列出（哪些平台没进、为什么）。

## 3. 样本清单

表格列：# / 标题 / 平台 / content_format / 主类型 / evidence level / tier / 链接 / 采集日期
（每行对应 samples/ 一条记录；<20 条时在此明确报告数量与原因，禁止凑数）

## 4. 分布统计

- 八类分布：各类型条数与占比
- 证据分级分布：A/B/C 各多少条（D8）——A 级占比过低必须在第 8 段声明可信度受限
- 表现分层分布：high/medium/normal/unknown 各多少条；unknown 占比高说明指标可得性差
- 平台 × content_format 分布

## 5. 六维拆解

逐维分析，每个结论**引用具体样本**（#编号+链接）作证：

- 标题：数字/利益/痛点/冲突/身份代入的使用模式（观察事实）
- 开头：前 3 段如何建立阅读动机（观察事实+分析判断）
- 内容结构：清单/对比/故事/教程/观点的组织方式（观察事实）
- 内容价值：解决什么问题、提供什么增量（分析判断）
- 传播机制：为什么值得收藏/转发/讨论（分析判断）
- 差异化：同类内容已写了什么、还有什么没写（分析判断→策略建议）

跨格式样本引用处必须显式声明「跨格式，仅作机制参考，不作表现基准」（D10）。

## 6. 普通样本对比分析

同平台同主题的爆款 vs 普通样本对照（D7）：差在哪里（选题/标题/结构/深度）？
「普通样本为什么没成」至少分析到可操作的差异点。

## 7. 可执行内容方向（≥3 条）

每条含：内容类型 / 切入角度 / 差异化理由 / 标题策略方向 / 可执行性说明。
级别统一标【策略建议】（D9）——这些是下一步创作候选，不是结论。

## 8. 结论可信度声明

- A 级样本占比与受限说明（D8）
- unknown tier 占比与影响
- 本报告结论中哪些只到【待验证假设】级别（D9）——这些必须等自己发布数据验证，不得直接采信

## 9. 人工确认清单（硬停）

以下三项待用户拍板，确认前不进入创作流程（不产出任何文章正文）：

- [ ] 选题方向：____（确认/调整）
- [ ] 内容类型：____（确认/调整）
- [ ] 标题策略：____（确认/调整）

确认后流转：本报告作为引用材料输入 gzh-article-craft A 定位阶段。
```

## 三、结论等级标注规范（D9）

全文所有结论性语句必须标四级之一：

| 级别 | 定义 | 典型位置 |
|---|---|---|
| 【观察事实】 | 样本实际呈现的现象（可回溯到样本） | 第 5 段各维开头 |
| 【分析判断】 | 基于样本的解释（有推理，但未经自己数据验证） | 第 5/6 段 |
| 【策略建议】 | 下一篇可尝试的方案 | 第 7 段 |
| 【待验证假设】 | 推测，等自己发布数据验证 | 第 8 段汇总 |

红线：不得把【观察事实】写成因果（「12/20 用数字标题」只能说明频率高，不能说明数字标题带来高阅读）；不得把【待验证假设】写进第 7 段当建议依据。
