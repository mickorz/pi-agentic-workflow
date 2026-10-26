export const meta = {
  name: 'wechat_article_pipeline',
  description: '公众号一条龙:选题→写稿→审稿→排版→配图→终审→发布。父编排脚本,用 workflow() 原语串联 6 个子 workflow,自身不调 agent。对应 skill: wechat_article_main',
}

// 对应 skill: .opencode-workflows/workflows/references/wechat_article_main
// 这是纯编排父脚本(零 agent),全部经 workflow() 子流程 dispatch。
// 子 workflow 内部的 checkpoint 会在前台运行时弹窗;后台运行走 headless 默认值。
// 如需人工交互,用 background:false 前台运行本脚本。
//
// 输入 args:
//   hint           : 主题提示(topics 用)
//   mode           : 'A'|'B'|'C'|'D' 选题模式。缺省按 hint 判断
//   count          : 选题数量
//   drafts_root    : 草稿根目录。缺省 drafts
//   article_dir    : 已存在的本篇目录(续写/重入时用)
//   theme          : 排版模版名
//   scheme         : 排版配色名
//   account        : 发布账号槽位
//   publish_method : 'draft'|'published'|'none'
//   force_publish  : 单次强制带发布
//   skip_topic_confirm  : 选题不单独确认(一条龙默认 true)
//   skip_image_confirm  : 配图不单独确认(一条龙默认 true)
// 输出: { article_dir, title, media_id, publish_completed }

phase('配置自检')
await check(() => fileExists('.aws-article/config.json'), '需要 .aws-article/config.json(按首次引导创建)')
await check(() => fileExists('aws.env'), '需要仓库根 aws.env(按首次引导创建)')
log('环境与配置自检完成')

phase('选题')
const topics = await workflow('wechat_article_topics', {
  mode: args.mode || (args.hint ? 'A' : 'C'),
  hint: args.hint,
  count: args.count,
  drafts_root: args.drafts_root,
  article_dir: args.article_dir,
  skip_confirm: args.skip_topic_confirm !== false,
})
log('选题完成: ' + topics.title + ' -> ' + topics.article_dir)

phase('写稿')
const writing = await workflow('wechat_article_writing', {
  article_dir: topics.article_dir,
  mode: 'draft',
})
log('写稿完成: ' + writing.draft_path)

phase('内容审')
const review = await workflow('wechat_article_review', {
  article_dir: topics.article_dir,
  mode: 'content',
})
log('内容审完成: ' + review.article_md_path)

phase('排版')
const formatting = await workflow('wechat_article_formatting', {
  article_dir: topics.article_dir,
  theme: args.theme,
  scheme: args.scheme,
})
log('排版完成: ' + formatting.html_path)

phase('配图')
const images = await workflow('wechat_article_images', {
  article_dir: topics.article_dir,
  skip_confirm: args.skip_image_confirm !== false,
})
log('配图完成: ' + (images.cover_path || '') + ' + ' + (images.imgs ? images.imgs.length : 0) + ' 张正文图')

phase('终审')
const finalReview = await workflow('wechat_article_review', {
  article_dir: topics.article_dir,
  mode: 'final',
})
log('终审完成: ok=' + finalReview.ok)

phase('发布')
const publish = await workflow('wechat_article_publish', {
  article_dir: topics.article_dir,
  account: args.account,
  publish_method: args.publish_method,
  force_publish: args.force_publish,
})
log('发布完成: publish_completed=' + publish.publish_completed)

return {
  article_dir: topics.article_dir,
  title: topics.title,
  digest: topics.digest,
  media_id: publish.media_id,
  publish_id: publish.publish_id,
  publish_completed: publish.publish_completed,
  ok: publish.ok,
}
