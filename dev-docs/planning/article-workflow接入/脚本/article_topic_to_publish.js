export const meta = {
  name: 'article_topic_to_publish',
  description: '主题到成稿全流程: 主题+引用素材 -> article_draft_from_topic 生成初稿 -> 用户审阅修改 -> wechat_article_polish(审稿->humanizer->图片提示词->排版) -> 输出。父编排, 串联 draft+polish, polish 内部集成 article_image_prompts。不依赖 aws.env(不发布)。',
}

// 输入 args:
//   topic             : 目标主题(必填, 如"Goal 命令是如何实现的")
//   main_doc          : 主文档路径(必填, 如 Goal命令是如何实现的.md。可为空文件, 初稿写入这里)
//   reference_subdir  : 引用子文件夹名(默认"引用"。找不到则找主文档同名去 .md 的文件夹)
//   rules_doc         : 配图规则文档路径(必填, 传给 polish 的图片提示词步骤)
//   target_word_count : 初稿目标字数(默认 2000-3000)
//   humanizer_voice   : humanizer voice(casual/professional/technical/warm/blunt), 缺省 professional
//   humanizer_aggressive: 是否重度改写, 缺省 false
//   humanizer_iterate : detect-rewrite-detect 迭代次数(1-3), 缺省 2
//   cover_aspect      : 封面比例(2.35:1/16:9/1:1, 缺省 2.35:1)
//   image_density     : 配图密度(每节一图/按需配图/少图/多图, 缺省 按需配图)
//   theme             : 排版模版名(亲和/资讯/书卷/杂志/活力/手账/硬朗/技术)
//   scheme            : 排版配色名
//   tone              : 账号调性(用于否决明显不搭的配图媒介, 可选)
//   skip_image_prompts: 跳过图片提示词步骤(不传 rules_doc 或显式 true 时跳过), 缺省 false
// 输出: { draft_path, topic, title, word_count, reference_count, article_md_path, article_html_path, review_path, ai_tell_score_before, ai_tell_score_after, image_prompts, ok }

phase('生成初稿')
const draft = await workflow('article_draft_from_topic.js', {
  topic: args.topic,
  main_doc: args.main_doc,
  reference_subdir: args.reference_subdir,
  target_word_count: args.target_word_count,
  auto_polish: false,
  skip_draft_confirm: true,
})

if (!draft.ok || !draft.draft_path) {
  log('初稿生成失败, 终止全流程')
  return {
    topic: args.topic,
    error: draft.error || '初稿生成失败',
    ok: false,
  }
}

log('初稿完成: ' + draft.draft_path + ' (' + draft.word_count + ' 字, ' + draft.reference_count + ' 篇引用)')

phase('用户审阅修改')
const approved = await checkpoint(
  '初稿已生成并写入: ' + draft.draft_path + '\n' +
  '标题: ' + draft.title + '\n' +
  '字数: ' + draft.word_count + '\n' +
  '引用素材: ' + draft.reference_count + ' 篇 (来自 ' + (draft.reference_dir || '') + ')\n\n' +
  '请现在用编辑器审阅修改该文件。\n' +
  '修改完成后点「允许」继续执行 polish 全流程:\n' +
  '  审稿(诊断AI味+敏感词+错别字) -> humanizer(去AI味) -> 图片提示词(封面+正文配图prompt) -> 排版(Markdown转HTML)\n' +
  '点「拒绝」则只保留初稿, 不跑 polish。'
)

if (!approved) {
  log('用户拒绝 polish, 只保留初稿')
  return {
    draft_path: draft.draft_path,
    topic: args.topic,
    title: draft.title,
    word_count: draft.word_count,
    reference_count: draft.reference_count,
    reference_files: draft.reference_files,
    polish_skipped: true,
    ok: true,
  }
}

phase('polish 全流程')
const polishResult = await workflow('wechat_article_polish.js', {
  input_md: draft.draft_path,
  rules_doc: args.rules_doc,
  humanizer_voice: args.humanizer_voice,
  humanizer_aggressive: args.humanizer_aggressive,
  humanizer_iterate: args.humanizer_iterate,
  cover_aspect: args.cover_aspect,
  image_density: args.image_density,
  theme: args.theme,
  scheme: args.scheme,
  tone: args.tone,
  skip_image_prompts: args.skip_image_prompts,
})

log('polish 完成: ' + (polishResult.article_html_path || ''))

return {
  draft_path: draft.draft_path,
  topic: args.topic,
  title: draft.title,
  word_count: draft.word_count,
  reference_count: draft.reference_count,
  reference_files: draft.reference_files,
  reference_dir: draft.reference_dir,
  article_dir: polishResult.article_dir,
  article_md_path: polishResult.article_md_path,
  article_html_path: polishResult.article_html_path,
  review_path: polishResult.review_path,
  article_pre_humanize_path: polishResult.article_pre_humanize_path,
  theme: polishResult.theme,
  scheme: polishResult.scheme,
  ai_tell_score_before: polishResult.ai_tell_score_before,
  ai_tell_score_after: polishResult.ai_tell_score_after,
  humanizer_report: polishResult.humanizer_report,
  image_prompts: polishResult.image_prompts,
  ok: polishResult.ok,
}
