# 账号级视觉规则（visual-rules）

> 层级：账号级，全部公众号文章共享的**默认**视觉体系（柔和水彩媒介）。Compiler 提取 `prompt-block` 进入 `style_prefix`（整篇真正共享的规则）。
> default-profile: ai-landing
> 媒介接管（medium-override）：自带完整品牌风格的栏目（如 ai-landing 的 3D 商业信息图）可在 series 文件头部声明 `> medium-override: true`，声明后该栏目 style_prefix 全量用栏目 prompt-block，本文件的 prompt-block 不参与（避免水彩与 3D 两种媒介打架）；本文件的 brand-params/checklist 仍作通用参考。
> 修改本文件 = 全局画风变化 = 该篇全部条目失效 + 风格审批重新确认（方案 V2.1 第三节变更语义表）。
> 状态声明：品牌色等待定项显式标注「待确定」，不假确定。首次真实效果验收后逐步固化。
> 段落约定：`prompt-block` 机器段（逐行拼 prompt）；`brand-params` 结构化参数（校验用）；`checklist` 人类验收要点（机器忽略）。

## brand-params

```yaml
identity: "个人 AI 技术与知识科普账号"
palette:
  primary: "待确定（首篇真实效果验收后定稿）"
  background: "待确定（建议低饱和暖白或米白方向）"
  accent: "待确定（建议单一强调色，饱和度中低）"
typography:
  chinese: "清晰易读的无衬线字体"
  hierarchy: "主标题 > 核心视觉 > 辅助信息"
composition:
  whitespace: "充足"
  density: "低到中"
  focal_points: 1
illustration:
  medium: "柔和水彩"
  texture: "轻微纸张颗粒"
fixed:
  - 品牌主色（待定稿后进入本清单）
  - 标题字体体系
  - 核心图形语言（柔和水彩与纸张颗粒质感）
variable:
  - 主题场景
  - 主体动作
  - 视觉隐喻
  - 局部布局
avoid:
  - 无意义的霓虹发光
  - 过度饱和的配色
  - 与主题无关的装饰元素
  - 拥挤的小字号文字
  - 机械感强的高光金属质感
```

## prompt-block

柔和水彩插画，轻微纸张颗粒质感，整体色调低饱和、温和自然。

充足留白，画面密度低到中，单一视觉焦点，主体清晰突出。

光影柔和自然，避免强烈高对比阴影和机械感高光。

色彩纪律：大面积低饱和底色，最多一处强调色，色相统一不杂。

如画面包含文字，仅限一个短词或短语，字号大、笔画清晰，不排长句。

禁止：无意义的霓虹发光效果；过度饱和配色；与主题无关的装饰元素堆砌；拥挤的小字号文字段落。

## checklist

- [ ] 整体色调与既往文章放在一起能认出同一个账号（品牌识别）
- [ ] 单一焦点，第一眼能看到主体
- [ ] 无霓虹发光、无过度饱和、无无关装饰
- [ ] 图内无长句文字（长文字一律后期合成）
