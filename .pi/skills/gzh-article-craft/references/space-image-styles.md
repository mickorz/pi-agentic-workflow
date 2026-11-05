# space-image 封面风格库(九套,接入 gzh-article-craft)

> 来源:`thirdparties/space-image`(github.com/SpaceZephyr/space-image,快照 aec9a00;47MB 未入库,样张在本地克隆里看:`thirdparties/space-image/assets/`,需要时 git clone)。
> 用途:**封面风格可选项**。D 阶段构造 image-prompts.json 时,style_prefix 从本表选;正文图仍走账号规则(diagram-design/生图铁律不变)。
> 首试:2026-11-05《Agent 代码验证》篇封面用 `lifestyle-handdrawn`,逐字核对+390 验证一次通过。

## 选用决策(D 阶段问用户或按内容定)

| 场景 | 风格 |
|---|---|
| 默认(不指定时) | 账号统一 Business AI 3D Infographic(历史风格头,系列一致性) |
| 方法论/教程/日常办公/轻叙事 | `lifestyle-handdrawn`(首试已验证) |
| 系统/工程/数据/战略/发布会级 | `premium-black-chrome` |
| 工作流/复杂系统/抽象概念 | `monochrome-print-workshop` |
| AI/自动化/未来感/强冲击 | `fluorescent-black` |
| 写作/审校/研究/开发者活动 | `acid-xerox-collage` |
| 人物访谈/创始人/个人品牌 | `spot-color-engraved-portrait` |
| 单一动作/品牌角色 | `minimal-mascot`;发布/团队/年轻化 `streetwear-character`;超现实叙事 `cobalt-riso-narrative` |

## space-image 工作流(比普通封面 prompt 多一步"提炼")

写 prompt 前先出五项视觉简报(**中心隐喻禁止每词一图标**):

1. 主题 2. 关键词(3-6 个) 3. 关系句(一句话连起关键词) 4. 中心隐喻(工坊/流水线/控制台/躺椅生活场景等,承载关系) 5. 视觉冲突(如"人休息 / Agent 工作")

prompt 必含:2.35:1+安全边距;一个主视觉≤两个重心;关系用箭头/轨迹/动作/空间表现;**风格头完整语法**(下表,不是只写风格名);中文标题准确文本+位置层级;排除项(乱码/多余小字/廉价 3D/模板卡片墙/同构换色)。

## 九套风格头(style_prefix 直接可用)

每条 = 中文定性描述(给生图模型读画面语言)+ 英文骨架(构图约束)。**与生图铁律兼容**:均不含"画面无文字"条款;标题文字照样声明 expected_text;filename 照 `cover-中文主题.png`。

### 1. premium-black-chrome|黑铬高级科技
适用:系统能力/工程方法/数据/Agent/发布会级。偏心大型英雄物占 35-50%,标题作背景结构;暗部大片保留,主物靠轮廓光。
风格头:`黑铬高级科技海报:近纯黑背景,一个非对称黑铬主视觉,克制的信号红轮廓光,超大字号排版作为空间结构,边缘少量技术注记,大量留白,高端工业艺术指导。2.35:1 premium editorial technology poster, near-black solid background, one asymmetrical black-chrome hero object, restrained red rim light, oversized typography used as spatial architecture, sparse technical annotations near the edges, generous negative space, no generic dashboard cards, no cheap 3D gloss.`
色:炭黑#070707/深酒红#3A0808/信号红#F1261A/暖白#F1EEE7/枪灰#575A60。避免:全屏红渐变/过多 HUD/游戏海报爆炸感。

### 2. minimal-mascot|低饱和蓝极简角色
适用:单一动作/品牌角色/轻产品表达。
风格头:`低饱和蓝极简角色插画:大片留白,一个圆润角色做一个明确动作,低饱和蓝白配色,少量对比色点缀,扁平干净。2.35:1 minimal editorial character illustration, generous white space, one round mascot performing one clear action, low-saturation blue palette with a single accent, flat and clean.`

### 3. streetwear-character|高纯红街头角色
适用:发布/技能/团队/强态度/年轻化。
风格头:`街头潮流角色海报:高纯红主色,街头穿搭角色大步向前,粗黑描边与网点材质,大字号标语式排版。2.35:1 streetwear character poster, bold red field, confident character in street outfit walking forward, thick outlines and halftone texture, statement typography.`

### 4. lifestyle-handdrawn|奶油黄生活手绘(首试已验证)
适用:日常办公/教程/个人经验/人在休息而 Agent 工作等轻叙事。
构图语法:横向生活场景讲故事,标题像贴在墙上的纸张不悬浮;人物+2-4 物品三角构图。
风格头:`奶油黄生活手绘插画:温暖奶油黄底色,蜡笔与马克笔手绘线条,拼贴纸质感与轻微错版,边缘不必完美,粗手写中文剪贴字,平涂友好配色(奶油黄#F2D45B/墨黑#181818/米白#F5EFD9/豆沙粉#E9B0BE/天空蓝#79ACE7/叶绿#4E8A55)。文字只允许出现在指定标题与标签位置。2.35:1 editorial hand-drawn lifestyle illustration on a warm butter-yellow field, one relaxed everyday scene, chunky Chinese cut-paper title integrated into the environment, loose marker outlines, flat friendly colors, playful but mature, not a sticker collage.`
避免:每词一图标/过度可爱/满屏便签/UI 卡片/人物比例怪异手部异常。

### 5. monochrome-print-workshop|纯黑白印刷工坊
适用:工作流/复杂系统/工坊/抽象概念。
风格头:`纯黑白印刷工坊插画:黑白双色,木刻/活字印刷质感,机械结构与齿轮工坊场景,大号黑体标题嵌进印刷版面。2.35:1 monochrome print-workshop illustration, black and white only, woodcut and letterpress texture, mechanical workshop scene, bold heading set into the printed layout.`

### 6. fluorescent-black|荧光黑实验视觉
适用:AI/自动化/未来感/活动视觉/强冲击。
风格头:`荧光黑实验视觉:深黑底,荧光色(绿/品红)仅用于关键路径与文字,实验电子海报感,锐利几何。2.35:1 fluorescent-black experimental poster, deep black field, fluorescent accents reserved for key paths and typography, sharp geometry, electronic art direction.`

### 7. cobalt-riso-narrative|钴蓝 Riso 超现实叙事
适用:超现实叙事/探索/旅行/未来生活/复古科技。
风格头:`钴蓝 Riso 超现实叙事插画:钴蓝双色 Riso 印刷质感,颗粒与套印错位,超现实场景组合,复古未来气质。2.35:1 cobalt riso narrative illustration, two-tone riso print texture with grain and misregistration, surreal scene composition, retro-futuristic mood.`

### 8. acid-xerox-collage|酸性影印科技拼贴
适用:写作/审校/研究/开发者活动/复古数码观点表达。
风格头:`酸性影印拼贴:黑白影印质感为主体,酸性色(荧光绿/橙)点缀,剪贴字与拼贴排版,复印机颗粒。2.35:1 acid xerox collage, black-and-white photocopy texture as the base, acid green and orange accents, cut-paper typography and collage layout, copier grain.`
(细化子风格 space-xerox-editorial:黑底/粉蓝场景/影印拼贴字/粉色强调词,见 thirdparties/space-image/skills/space-xerox-editorial/SKILL.md)

### 9. spot-color-engraved-portrait|专色蚀刻人物肖像
适用:人物访谈/创始人/个人观点/人物故事。
风格头:`专色蚀刻人物肖像:铜版画蚀刻线条,单专色(如深红或钴蓝),人物面部与手部细节充分,背景留白,古典印刷气质。2.35:1 spot-color engraved portrait, etched line work, single spot color, detailed face and hands, generous background negative space, classical print quality.`

## 系列出图规则(多篇/多图时)

用户说"换一种风格"时必须同时改≥3 项:构图骨架/主体造型/材质语言/字体策略/信息密度,不能只换色;局部问题优先编辑现有图,不整张重生成。
