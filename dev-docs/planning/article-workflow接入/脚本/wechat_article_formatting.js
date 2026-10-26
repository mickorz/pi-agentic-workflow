export const meta = {
  name: 'wechat_article_formatting',
  description: '公众号排版:Markdown 转微信后台可粘贴 HTML,多主题、多字号、所见即所得。对应 skill: wechat_article_formatting',
}

// 对应 skill: .opencode-workflows/workflows/references/wechat_article_formatting
// 输入 args:
//   article_dir : 本篇目录(必填,含 article.md)
//   theme       : 模版名(亲和/资讯/书卷/杂志/活力/手账/硬朗/技术)。不传则读 article.yaml 的 default_format_preset,再无则 亲和
//   scheme      : 配色名。不传则读 default_format_scheme,再无则模版默认
//   color       : 自定义主色 hex(覆盖 scheme)。可选
//   font_size   : 正文字号 px。缺省 16
// 输出: { html_path, theme, scheme }

const SKILL = '.opencode-workflows/workflows/references/wechat_article_formatting'

phase('确定模版与配色')
const themeConfig = await agent(
  '你是公众号排版引擎。请确定本篇模版与配色(见 下方规则 内置模版与第1步):\n\n' +
  '1. 读 .aws-article/config.json 与本篇 ' + args.article_dir + '/article.yaml 的 default_format_preset(单元素列表)、default_format_scheme。\n' +
  '2. 用户指定优先: ' + (args.theme ? '模版=' + args.theme : '未指定,读配置或默认亲和') + (args.scheme ? ' 配色=' + args.scheme : ' 读配置或模版默认') + '\n' +
  '3. 内置模版表(按本篇题材选):\n' +
  '   | 模版 | 适合 | 不适合 | 配色(第一个默认) |\n' +
  '   | 亲和 | 教程、职场、面向新手的解释性长文 | 严肃议题、极简冷硬品牌 | 黛紫/松绿/靛蓝 |\n' +
  '   | 资讯 | 快讯、评测、行业观察 | 抒情散文、碎片化短段 | 墨绿/绛红/藏青 |\n' +
  '   | 书卷 | 人文、读书、历史、深度长文 | 工程文档、数据密集评测 | 朱砂/黛蓝/苍绿 |\n' +
  '   | 杂志 | 品牌故事、人物访谈、生活方式 | 没配图的稿子、信息型短文 | 石青/驼褐/铁锈 |\n' +
  '   不传 --theme 时默认亲和。确认所选模版的适合/不适合与本篇题材匹配。\n' +
  '4. 读 ' + SKILL + '/components/ 下各组件的 HTML 定义,了解: 标题装饰(## 渲染)、导语(> 首段)、金句卡(> ... —— 出处)、图片处理(![图](url "图注"))、分隔(---)、文末(append closing.md)。\n' +
  '5. 读 ' + SKILL + '/wechat-html-constraints.md(若有)了解微信 HTML 限制(必须内联样式、不支持的标签等)。\n' +
  '6. 读 ' + SKILL + '/branches.md 的主题解析顺序与 {embed:...} 合并规则。\n\n' +
  '返回: 选定模版名、配色名、主色 hex、字号、该模版的渲染规则摘要(各类 markdown 形态如何转 HTML)。',
  { label: '定模版', agentType: 'general' }
)

phase('转换')
const formatPrompt =
  '你是公众号排版渲染器。把 markdown 定稿转成微信后台可粘贴的 HTML(见 下方规则 第2步)。\n\n' +
  '模版与配色配置:\n' + themeConfig + '\n\n' +
  '渲染规则(见下方规则 从标准 markdown 认形态):\n' +
  '- **加粗** -> 上模版重点色或荧光底(正文唯一扫读落点)\n' +
  '- - **标签**:说明 -> 标签视觉提出来\n' +
  '- - [ ] / - [x] -> 该骨架的三态图标\n' +
  '- > 金句。 —— 出处 -> 金句卡(正文位带破折号出处的引用)\n' +
  '- > 引文 -> 前补大引号\n' +
  '- ![图](路径 "图注") -> 四角标 + 图注(图注只认 title 里显式写的;alt 冒号后是画面指令不显示)\n' +
  '- --- -> 装饰分隔\n' +
  '- ## -> 标题装饰(笔锋/折角块)\n' +
  '- 只认形态不推断语义: 有序列表只表示枚举不渲染成步骤\n' +
  '- ::: 组件语法仍认但写手不产出,若 article.md 里有则正常渲染\n\n' +
  '关键约束:\n' +
  '- 正文不含文章标题(article.md 首个 # 被跳过,标题在后台单独填)\n' +
  '- 配图标记还是 placeholder 时保留为 <img>,等 images 替换;终审前必须全换成真实路径\n' +
  '- 文末 {embed:...} 占位符按合并规则处理: 与配置对得上则渲染对应组件,对不上会失败则报错\n' +
  '- 若有 closing.md 则追加到文末\n' +
  '- 所有样式必须内联(微信不支持外部 CSS 与 class 语义,用 style="..." 内联)\n' +
  '- 禁止 <br> <div> 等 HTML 标签出现在源 markdown 里(若出现则报错)\n\n' +
  '读 ' + args.article_dir + '/article.md 全文,用 Write 工具把渲染后的 HTML 写到 ' + args.article_dir + '/article.html。\n' +
  '若 {embed:...} 占位符与配置不匹配,立即报错不要硬渲染。'

const formatResult = await agent(formatPrompt, {
  label: '渲染', agentType: 'general',
  schema: {
    type: 'object',
    properties: {
      html_path: { type: 'string' },
      theme: { type: 'string' },
      scheme: { type: 'string' },
      embed_resolved: { type: 'number' },
      placeholders_remaining: { type: 'number' },
    },
    required: ['html_path'],
  },
})

phase('核对输出')
const checkResult = await agent(
  '你是排版核对员。对 ' + args.article_dir + '/article.html 做输出核对(见 下方规则 第3步):\n\n' +
  '1. 正文不含文章标题(article.md 首个 # 被跳过)\n' +
  '2. placeholder 仍保留为 <img>(等 images 替换)或已替换为真实路径\n' +
  '3. 无乱码、HTML 标签闭合正确\n' +
  '4. {embed:...} 占位符已正确处理或报错\n' +
  '5. 内联样式齐全(微信要求)\n\n' +
  '输出: 各项 [OK]/[FAIL] + 说明;总体 ok。不合格项给具体修复建议。',
  { label: '核对', agentType: 'general', schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      report: { type: 'string' },
    },
    required: ['ok', 'report'],
  } }
)

if (!checkResult.ok) {
  await agent(
    '排版核对发现不合格项,请修复 ' + args.article_dir + '/article.html:\n\n' +
    checkResult.report + '\n\n只改不合格项,用 Write 工具覆盖原 article.html。',
    { label: '修复', agentType: 'general' }
  )
}

log('排版完成: ' + formatResult.html_path)

return {
  html_path: formatResult.html_path,
  theme: formatResult.theme,
  scheme: formatResult.scheme,
  ok: true,
}
