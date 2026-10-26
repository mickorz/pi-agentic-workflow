export const meta = {
  name: 'wechat_article_review',
  description: '公众号审稿与合规:敏感词、错别字、平台规范、AI味诊断,输出修改清单并定稿。对应 skill: wechat_article_review',
}

// 对应 skill: .opencode-workflows/workflows/references/wechat_article_review
// 输入 args:
//   article_dir : 本篇目录(必填)
//   mode        : 'content'|'final'。有 article.html 自动判 final;缺省 content
//   auto_fix    : 是否自动修复红项。缺省 true
// 输出: { review_path, article_md_path, red_count, yellow_count, ok }

const SKILL = '.opencode-workflows/workflows/references/wechat_article_review'
const WRITING_SKILL = '.opencode-workflows/workflows/references/wechat_article_writing'
const mode = args.mode || 'content'

phase('读约束与检查清单')
const constraints = await agent(
  '你是公众号审稿员。请读取审稿约束(见 下方规则 第1步):\n\n' +
  '1. 读 .aws-article/config.json(不含 writing_model/image_model),提取 review_output_format, custom_sensitive_words, forbidden_words, target_reader, tone, image_density, embeds, original_attribution。\n' +
  '2. 读本篇 ' + args.article_dir + '/article.yaml,同键本篇优先。embeds.related_articles 与全局深度合并。\n' +
  '3. 读 .aws-article/writing-spec.md(如有)。\n' +
  '4. 读 .aws-article/presets/review-rules.yaml(如有)。\n' +
  '5. 读 ' + SKILL + '/checklist.md 完整清单。\n' +
  '6. 读 ' + SKILL + '/ai-flavor-check.md AI 味诊断信号。\n' +
  '7. 读 ' + SKILL + '/output-format.md 输出模板。\n' +
  (mode === 'content' ? '8. 读 ' + args.article_dir + '/draft.md 待审稿件。\n' : '8. 读 ' + args.article_dir + '/article.html,以及 cover.* 与 imgs/ 做终审。\n') +
  '\n把「合并后的审稿约束 + 检查清单要点」整理返回,作为逐项检查依据。',
  { label: '读约束', agentType: 'general' }
)

phase('逐项检查')
const checklistPrompt =
  '你是公众号审稿员。按以下约束与清单逐项检查(见 下方规则 第2步)。\n\n' +
  '审稿约束与清单:\n' + constraints + '\n\n' +
  '审稿模式: ' + mode + '\n\n' +
  (mode === 'content' ? '内容审维度:\n' :
   '终审维度(在内容审基础上额外):\n') +
  '- 标题: 长度、禁用套路、与正文一致性\n' +
  '- 摘要: 长度、信息量、与正文一致;且与正文首个 > 导语不是同一句话\n' +
  '- 正文: 敏感词、禁用词、错别字、事实出处、社交媒体用户名过滤(全文不许出现 @ 符号开头的英文用户名如 @leoshen0/@LinearUncle, 必须改为泛指如"有开发者"/"一位面试官", 红项)\n' +
  '- 写作规范: 对照 writing-spec.md 检查用词句式段落;深度调性是否与 target_reader/tone 一致\n' +
  '- AI 味自检: 对照 ai-flavor-check.md 逐处诊断并标注信号强度。默认只诊断,一律折算黄项,不 blocking\n' +
  '- 配图标记: 封面标记存在、数量与 image_density 匹配、描述具体\n' +
  '- 文末 embed: 定稿前须完成(本步先记录是否需要)\n' +
  '- 原创标注: 按 original_attribution 处理\n' +
  (mode === 'final' ? '\n终审额外:\n- 排版: article.html 存在且完整无乱码\n- 图片: 文章目录下有 cover.*(不在 imgs/ 里)、imgs/ 正文图齐全、placeholder 已全部替换、文件真实存在\n- 发布要素: 标题/摘要/作者/封面全部就绪\n' : '') +
  '\n结果分三级: 红项(必须改)、黄项(建议改)、绿项(通过)。\n' +
  '按 review_output_format 输出(分块详细或简要清单)。每项给具体修改建议。\n' +
  '用 Write 工具把审稿结果写到 ' + args.article_dir + '/review.md。'

const reviewResult = await agent(checklistPrompt, {
  label: '审稿', agentType: 'general',
  schema: {
    type: 'object',
    properties: {
      red_count: { type: 'number' },
      yellow_count: { type: 'number' },
      red_items: { type: 'string' },
      review_path: { type: 'string' },
    },
    required: ['red_count', 'yellow_count', 'review_path'],
  },
})

phase('修改循环')
let currentRed = reviewResult.red_count
let loopCount = 0
const autoFix = args.auto_fix !== false

while (currentRed > 0 && autoFix && loopCount < 3) {
  loopCount++
  await agent(
    '审稿发现 ' + currentRed + ' 个红项,请修改 ' + args.article_dir + '/draft.md:\n\n' +
    reviewResult.red_items + '\n\n' +
    '只改红项对应的问题,不要整篇重写。改完用 Write 工具覆盖 draft.md。\n' +
    '这是第 ' + loopCount + ' 轮修复。',
    { label: '修复红项 #' + loopCount, agentType: 'general' }
  )

  const recheck = await agent(
    '重新审 ' + args.article_dir + '/draft.md,只重审上一轮的红项:\n' + reviewResult.red_items + '\n\n' +
    '输出: 剩余红项数量与列表。若全部消除,red_count=0。',
    { label: '重审 #' + loopCount, agentType: 'general', schema: {
      type: 'object',
      properties: {
        red_count: { type: 'number' },
        red_items: { type: 'string' },
      },
      required: ['red_count'],
    } }
  )
  currentRed = recheck.red_count
  if (recheck.red_items) reviewResult.red_items = recheck.red_items
}

phase('确认审稿结果')
log('审稿完成,红项 ' + currentRed + ' 黄项 ' + reviewResult.yellow_count)
const approved = await checkpoint(
  '审稿结果已写入 ' + reviewResult.review_path + '。\n' +
  '红项: ' + currentRed + ' (须全部消除才能定稿)\n' +
  '黄项: ' + reviewResult.yellow_count + ' (建议改,不 blocking)\n' +
  (currentRed > 0 ? '仍有红项未消除,建议拒绝后手动修复再重跑。\n' : '') +
  '允许=进入定稿(剥离引用+文末embed+保存article.md);拒绝=终止。'
)

if (currentRed > 0) {
  return {
    review_path: reviewResult.review_path,
    article_md_path: null,
    red_count: currentRed,
    yellow_count: reviewResult.yellow_count,
    ok: false,
  }
}

phase('剥离引用与文末embed定稿')
const finalizeResult = await agent(
  '你是审稿定稿执行者。红项已全部消除,请完成定稿(见 下方规则 第5步 BLOCKING):\n\n' +
  '1. 剥离引用标注: 读 ' + args.article_dir + '/draft.md,去掉正文里所有 (资料路径:...) 引用标注(写作阶段为溯源注入,发布版必须去除)。把剥离后的稿子写到 ' + args.article_dir + '/draft-stripped.md。\n\n' +
  '2. 文末 embed: 在 draft-stripped.md 的正文末尾追加占位符(按合并后的 embeds 配置):\n' +
  '   - {embed:profile:昵称}  当 embeds.profiles 有非空 nickname 时,每条一行\n' +
  '   - {embed:miniprogram:标题}  当 embeds.miniprograms 有非空 title 时\n' +
  '   - {embed:miniprogram_card:标题}  当 embeds.miniprogram_cards 有非空 title 时\n' +
  '   - {embed:link:名称}  当 embeds.related_articles.manual 有有效项时,至多 3 条\n' +
  '   全空时显式标注(不省略)。\n\n' +
  '3. 保存定稿: 把已剥离引用且含文末 embed 的稿子用 Write 工具写到 ' + args.article_dir + '/article.md。\n\n' +
  '未完成第2步不得保存 article.md。占位符必须与配置一致,否则排版失败。\n' +
  '完成后返回 article.md 路径。',
  { label: '定稿', agentType: 'general', schema: {
    type: 'object',
    properties: {
      article_md_path: { type: 'string' },
      embed_count: { type: 'number' },
    },
    required: ['article_md_path'],
  } }
)

return {
  review_path: reviewResult.review_path,
  article_md_path: finalizeResult.article_md_path,
  red_count: 0,
  yellow_count: reviewResult.yellow_count,
  ok: true,
}
