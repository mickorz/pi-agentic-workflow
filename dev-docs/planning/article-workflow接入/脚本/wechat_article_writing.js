export const meta = {
  name: 'wechat_article_writing',
  description: '公众号长文写作:从提纲或话题生成完整初稿,支持改写、续写、润色。对应 skill: wechat_article_writing',
}

// 对应 skill: .opencode-workflows/workflows/references/wechat_article_writing
// 输入 args:
//   article_dir : 本篇目录(必填,含 article.yaml 与 topic-card.md)
//   mode        : 'draft'|'rewrite'|'continue'|'prompt'。缺省 draft
//   input       : rewrite/continue 时的输入文本或段落;draft 时用 topic-card.md
//   reference   : 可选参考文档路径(--reference)
// 输出: { draft_path, word_count, check_report, ok }

const SKILL = '.opencode-workflows/workflows/references/wechat_article_writing'
const mode = args.mode || 'draft'

phase('读本篇约束与写作规范')
const constraints = await agent(
  '你是公众号写作引擎。请读取并合并本篇写作约束(见 下方规则 第3步):\n\n' +
  '1. 读 .aws-article/config.json(不含 writing_model/image_model 两段),提取: article_category, target_reader, tone, writing_style, default_structure, default_closing_block, forbidden_words, custom_sensitive_words, paragraph_preference, image_density, caption_style, embeds, original_attribution。\n' +
  '2. 读本篇 ' + args.article_dir + '/article.yaml,同键以本篇优先。确认 title/author/digest/publish_completed/image_source/image_density/default_structure/default_closing_block。\n' +
  '3. 读 .aws-article/writing-spec.md(如有)。\n' +
  '4. 读 ' + SKILL + '/structure-template.md 了解结构模板与配图标记规则。\n' +
  '5. 读 ' + SKILL + '/branches.md 了解预设多候选处理与用户供图分支。\n' +
  '6. ls .aws-article/products/ 看业务资料库,本篇涉及用户业务时读相关产品 *.md 作底稿。\n' +
  (args.reference ? '7. 参考文档: ' + args.reference + ',读全文。\n' : '') + '\n' +
  '确认 article_category / target_reader 非空且 default_author 或本篇 author 非空。缺则暂停并说明缺什么。\n' +
  '把合并后的写作约束整理成一份「写作简报」返回: 读者画像、调性、文风、结构、字数、配图密度、禁用词、embeds、业务底稿要点。',
  { label: '读约束', agentType: 'general' }
)

phase('写作')
const writePrompt =
  '你是公众号长文写手。按以下写作简报与 SKILL 规范写一篇完整文章初稿。\n\n' +
  '写作简报:\n' + constraints + '\n\n' +
  '本篇目录: ' + args.article_dir + '\n' +
  '写作模式: ' + mode + '\n' +
  (mode === 'draft' ? '输入: 读 ' + args.article_dir + '/topic-card.md,按选定的标题与大纲写完整初稿。\n' : '') +
  (mode === 'rewrite' ? '输入: 读 ' + args.article_dir + '/draft.md,按以下要求改写: ' + (args.input || '整体润色') + '\n' : '') +
  (mode === 'continue' ? '输入: 读 ' + args.article_dir + '/draft.md,从以下位置续写: ' + (args.input || '末尾续写') + '\n' : '') +
  '\n必须遵守的规范(见 下方规则 第6步):\n' +
  '- Markdown 语法: 小标题用 ## / ### (井号后空格,不写 # 一级);加粗用 **加粗**;链接 [文字](url);配图 ![类型名:画面内容](placeholder "图注");列表 - 项;引用 > 引文;表格带分隔行;代码用反引号。禁止 HTML 标签、::: 自定义块、四空格缩进代码、裸 URL。\n' +
  '- 产出配额(硬性,不是参考值):\n' +
  '  * 摘要: 第一个 ## 之前写一段 > 引用,80-128 字,且与 article.yaml 的摘要不是同一句话。\n' +
  '  * 加粗划重点: 每 100 字左右一个落点,连续 200 字不许没有加粗。每个 ## 小节至少一处,结尾段要有。加粗要能独立看懂(数字连意思,判断连对象)。不要加粗整句概括。\n' +
  '  * 三项以上并列写成 - **标签**:说明 列表。\n' +
  '  * 金句恰好一处: > 金句。 —— 出处\n' +
  '  * --- 独占一行作转场,上下空行。\n' +
  '  * 段距: 段间空一行。\n' +
  '- 配图占位: image_source 不为 user 时,按 image_density 生成 ![类型:描述](placeholder),封面占位放标题之前。类型只有 封面/实证/信息图/氛围 四种。密度词: 每节一图(每个 ## 一张)/按需配图(讲不清处才配)/少图(1-2 张)/多图(每 2-3 段一张)。未配置默认每节一图。\n' +
  '- target_reader 决定深度与用词,tone 决定语气,writing_style 决定结构。\n' +
  '- forbidden_words 一个都不许出现。\n' +
  '- 涉及业务时优先复用业务底稿内容。\n\n' +
  '用 Write 工具把初稿写到 ' + args.article_dir + '/draft.md。不要写 article.md(那是 review 阶段的产物)。'

const draftResult = await agent(writePrompt, {
  label: '写稿', agentType: 'general',
  schema: {
    type: 'object',
    properties: {
      draft_path: { type: 'string' },
      word_count: { type: 'number' },
      summary: { type: 'string' },
    },
    required: ['draft_path'],
  },
})

phase('产出配额自检')
const checkReport = await agent(
  '你是写作自检器。对 ' + (draftResult.draft_path || args.article_dir + '/draft.md') + ' 跑一遍产出配额检查(见 下方规则 第7步)。\n\n' +
  '逐条量:\n' +
  '1. 摘要: 第一个 ## 前有 > 引用,80-128 字,且与 article.yaml digest 不同句。\n' +
  '2. 加粗密度: 每 100 字左右一个落点,连续 200 字无加粗为不合格。把全文加粗按顺序抽出来串成一行,判断读起来像不像一份提要。\n' +
  '3. 三项以上并列是否用列表。\n' +
  '4. 金句恰好一处(> ... —— 出处)。\n' +
  '5. 配图占位数与 image_density 是否一致,格式是否合法(四个类型名)。\n' +
  '6. forbidden_words 是否出现。\n' +
  '7. 小标题密度、段落长度粗扫。\n\n' +
  '输出: 每条 [OK]/[FAIL] + 说明;加粗串行;总体 ok=true/false。不合格项给出具体修改建议。这是内容审之前最后一道机器关口。',
  { label: '自检', agentType: 'general', schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      report: { type: 'string' },
      bold_serial: { type: 'string' },
    },
    required: ['ok', 'report'],
  } }
)

if (!checkReport.ok) {
  phase('自检不合格修复')
  await agent(
    '自检发现以下不合格项,请修改 ' + (draftResult.draft_path || args.article_dir + '/draft.md') + ' 后再次保存:\n\n' +
    checkReport.report + '\n\n' +
    '加粗串行(判断是否像提要): ' + (checkReport.bold_serial || '(空)') + '\n\n' +
    '只改不合格项,不要整篇重写。改完用 Write 工具覆盖原 draft.md。',
    { label: '修复', agentType: 'general' }
  )
}

phase('展示并确认')
log('初稿已生成并自检,等待用户确认')
const approved = await checkpoint(
  '初稿已写入 ' + (draftResult.draft_path || args.article_dir + '/draft.md') + ' 并完成自检。\n' +
  '自检结果: ' + (checkReport.ok ? '通过' : '已修复') + '\n' +
  '确认后移交 review 做内容审。允许=继续;拒绝=终止。'
)

return {
  draft_path: draftResult.draft_path || args.article_dir + '/draft.md',
  word_count: draftResult.word_count || 0,
  check_report: checkReport.report,
  ok: true,
}
