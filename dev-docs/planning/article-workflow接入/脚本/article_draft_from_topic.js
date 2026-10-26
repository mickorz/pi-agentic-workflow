export const meta = {
  name: 'article_draft_from_topic',
  description: '从主题+引用文档生成初稿: 输入主题+主文档路径, 读取主文档所在目录下引用子文件夹的所有文章, 结合主题生成初稿 markdown。用户审阅后可调 polish 流程。不依赖 .aws-article 配置, 自包含。',
}

// 输入 args:
//   topic            : 目标主题(必填, 如"Goal 命令是如何实现的")
//   main_doc         : 主文档路径(必填, 如 Goal命令是如何实现的.md。可为空文件, 作为输出目标)
//   reference_subdir : 引用子文件夹名(默认"引用"。找不到则找主文档同名去 .md 的文件夹)
//   target_word_count: 目标字数(默认 2000-3000)
//   auto_polish      : 审阅确认后自动调用 polish 流程, 缺省 false(只生成初稿, 用户手动跑 polish)
//   skip_draft_confirm: 跳过初稿审阅 checkpoint(父编排统一处理审阅时传 true), 缺省 false
//   polish_args      : 传给 polish 的额外参数(rules_doc/humanizer_voice/cover_aspect 等 JSON)
// 输出: { draft_path, topic, reference_count, reference_files, polish_result }

phase('读主文档与引用文件夹')
const gather = await agent(
  '你是初稿写作的素材收集员。请完成以下步骤:\n\n' +
  '1. 用 Read 工具读主文档: ' + args.main_doc + '\n' +
  '   - 如果文件为空, 记录为空(它是占位文件, 初稿将写入这里)\n' +
  '   - 如果有内容, 提取要点作为写作参考\n\n' +
  '2. 查找引用子文件夹:\n' +
  '   - 先用 Glob 工具查找主文档所在目录下的 ' + (args.reference_subdir || '引用') + '/ 文件夹(匹配 "' + (args.reference_subdir || '引用') + '/*.md")\n' +
  '   - 如果找不到, 用 Glob 查找主文档同名去 .md 的文件夹(如 ' + args.main_doc + ' 去掉 .md 后的同名目录下的 *.md)\n' +
  '   - 两种都找不到则报错终止\n\n' +
  '3. 用 Read 工具读引用文件夹下的所有 .md 文章全文。每篇提取:\n' +
  '   - 文件名\n' +
  '   - 核心观点(1-3 句)\n' +
  '   - 关键事实/数据/案例(可引用的具体内容)\n' +
  '   - 与主题 "' + args.topic + '" 的关联点\n\n' +
  '4. 返回以下结构化结果。',
  { label: '收集素材', agentType: 'general', schema: {
    type: 'object',
    properties: {
      main_doc_content: { type: 'string', description: '主文档内容摘要, 空则记 "(空文件)"' },
      reference_dir: { type: 'string', description: '找到的引用文件夹路径' },
      reference_files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            filename: { type: 'string' },
            core_points: { type: 'string' },
            key_facts: { type: 'string' },
            relevance: { type: 'string' },
          },
        },
      },
      reference_count: { type: 'number' },
    },
    required: ['reference_dir', 'reference_files', 'reference_count'],
  } }
)

if (!gather.reference_count || gather.reference_count === 0) {
  log('引用文件夹为空或未找到, 终止')
  return {
    draft_path: null,
    topic: args.topic,
    error: '引用文件夹未找到或为空。请在主文档所在目录下创建 "' + (args.reference_subdir || '引用') + '" 文件夹并放入参考文章',
    ok: false,
  }
}

log('素材收集完成: ' + gather.reference_count + ' 篇引用文章, 来自 ' + gather.reference_dir)

phase('收集引用图片')
var mainDocDir = args.main_doc.replace(/[/\\][^/\\]+$/, '')
var assetsDir = mainDocDir + '/assets'
var imageCollect = await workflow('article_collect_images.js', {
  reference_dir: gather.reference_dir,
  assets_dir: assetsDir,
})
log('图片收集完成: 下载 ' + imageCollect.downloaded_count + ' 张, 失败 ' + imageCollect.failed_count + ' 张, 目录 ' + imageCollect.assets_dir)

phase('结合主题生成初稿')
var mainDocSlug = args.main_doc.replace(/^.*[/\\]/, '').replace(/\.md$/i, '')
var mainDocDir2 = args.main_doc.replace(/[/\\][^/\\]+$/, '')
var draftOutputPath = mainDocDir2 + '/' + mainDocSlug + '_初稿.md'
const draftResult = await agent(
  '你是公众号长文写手。根据主题和引用素材, 生成一篇结构完整、内容扎实的初稿 markdown 文章。\n\n' +
  '主题: ' + args.topic + '\n\n' +
  '主文档内容(如有):\n' + (gather.main_doc_content || '(空文件)') + '\n\n' +
  '引用素材(' + gather.reference_count + ' 篇):\n' +
  JSON.stringify(gather.reference_files, null, 2) + '\n\n' +
  (imageCollect && imageCollect.downloaded_count > 0
    ? '引用文章图片(' + imageCollect.downloaded_count + ' 张, 已下载到 ' + imageCollect.assets_dir + '):\n' +
      JSON.stringify(imageCollect.images, null, 2) + '\n\n' +
      '初稿里引用这些图片时用相对路径 assets/<filename>, 格式: ![描述](assets/<filename>)。\n' +
      '在初稿合适的位置(讲不清的地方/概念图/截图/封面)插入相关图片引用, 不要强求每张都用, 只用与该段落内容相关的。\n' +
      '封面图如果有合适的可以直接用 assets/ 下的图片。\n\n'
    : '引用文章无图片, 不需要插入图片引用。\n\n') +
  '写作要求:\n' +
  '1. 文章结构: 先定 3-5 个 ## 小标题章节, 每节 300-600 字, 总字数 ' + (args.target_word_count || '2000-3000') + '\n' +
  '2. 内容来源: 核心观点和事实必须来自引用素材, 不要编造。可以在引用素材基础上归纳、对比、重组, 但不能发明新的事实/数据/人名/引语\n' +
  '   过滤社交媒体用户名: 引用素材里的 @username(如 @leoshen0/@LinearUncle/@Stephen4171127)是 Twitter/X 平台用户名, 公众号文章不保留这种格式。改用泛指(如"有开发者"/"一位面试官"/"评论区有人"/"某位读者")或引用素材里提到的真实姓名。全文不许出现 @ 符号开头的英文用户名原文。\n' +
  '3. markdown 格式规范:\n' +
  '   - 首行 # 文章标题(从主题提炼, 不超过 20 字)\n' +
  '   - ## 二级小标题(井号后空格)\n' +
  '   - **加粗**划重点(每 100 字左右一个落点, 加粗要能独立看懂)\n' +
  '   - > 引用做导语(第一个 ## 之前, 80-128 字概括全文核心价值)\n' +
  '   - 段间空一行\n' +
  '   - 中英文之间空格(AI/Goal/Agent 等)\n' +
  '   - 列表用 - 项\n' +
  '   - 禁止 HTML 标签、::: 自定义块、裸 URL\n' +
  '4. 写作调性: 专业但不学术, 有观点有取舍, 不面面俱到。开头 2-3 句要抓人(具体场景/数据/反问), 不要套话开头(随着...的发展/在当今时代)\n' +
  '5. 避免 AI 味:\n' +
  '   - 不要「不是 X 而是 Y」句式滥用(800 字内不超过 2 次)\n' +
  '   - 不要首先/其次/最后 罗列套话\n' +
  '   - 不要四字成语堆砌\n' +
  '   - 不要「你值得/愿你」式祝福收尾\n' +
  '   - 句长要有变化(短句 3-8 字 + 长句 25-40 字混用)\n' +
  '6. 配图标记(可选, 按 image_density=按需配图):\n' +
  '   - 只在文字讲不清的地方(流程/对比/数据/结构)标 ![信息图:描述](placeholder)\n' +
  '   - 封面标记 ![封面:描述](cover.png) 放首行 # 之前\n' +
  '   - 不强求每节配图\n' +
  '7. 文末标注引用来源: *本文基于以下素材整理: <引用文件名列表>*\n\n' +
  '用 Write 工具把初稿写到: ' + draftOutputPath + '\n' +
  '(新建文件, 不覆盖主文档 ' + args.main_doc + ')',
  { label: '写初稿', agentType: 'general', schema: {
    type: 'object',
    properties: {
      draft_path: { type: 'string' },
      word_count: { type: 'number' },
      title: { type: 'string' },
      structure: { type: 'string', description: '章节结构摘要' },
    },
    required: ['draft_path', 'word_count', 'title'],
  } }
)

if (!draftResult) {
  log('初稿生成 agent 返回 null(可能网络/超时), 终止')
  return {
    draft_path: null,
    topic: args.topic,
    error: '初稿生成 agent 失败(返回 null), 请重试',
    ok: false,
  }
}

log('初稿生成完成: ' + (draftResult.draft_path || draftOutputPath) + ' (' + (draftResult.word_count || 0) + ' 字, 标题=' + (draftResult.title || args.topic) + ')')

var draftPath = draftResult.draft_path || draftOutputPath
var draftTitle = draftResult.title || args.topic
var draftWordCount = draftResult.word_count || 0

phase('用户审阅')
let approved = true
if (args.skip_draft_confirm !== true) {
  approved = await checkpoint(
    '初稿已生成并写入: ' + draftPath + '\n' +
    '标题: ' + draftTitle + '\n' +
    '字数: ' + draftWordCount + '\n' +
    '结构: ' + (draftResult.structure || '') + '\n\n' +
    (args.auto_polish
      ? '请现在用编辑器审阅修改该文件。修改完成后点「允许」继续执行 polish 流程(审稿->humanizer->图片提示词->排版)。点「拒绝」则只保留初稿, 不跑 polish。'
      : '请用编辑器审阅修改该文件。修改完成后手动跑 polish:\n' +
        '  workflow("wechat_article_polish.js", { input_md: "' + draftPath + '", rules_doc: "<规则文档路径>", ... })\n' +
        '点「允许」标记流程完成(不自动跑 polish)。点「拒绝」则终止。')
  )
}

if (!args.auto_polish) {
  log('初稿流程完成(auto_polish=false), 用户可手动跑 polish')
  return {
    draft_path: draftPath,
    topic: args.topic,
    title: draftTitle,
    word_count: draftWordCount,
    reference_count: gather.reference_count,
    reference_files: gather.reference_files.map(function(f) { return f.filename }),
    reference_dir: gather.reference_dir,
    approved: approved,
    ok: true,
  }
}

if (!approved) {
  log('用户拒绝, 不跑 polish, 只保留初稿')
  return {
    draft_path: draftPath,
    topic: args.topic,
    title: draftTitle,
    word_count: draftWordCount,
    reference_count: gather.reference_count,
    polish_skipped: true,
    ok: true,
  }
}

phase('polish')
const polishResult = await workflow('wechat_article_polish.js', Object.assign({
  input_md: draftPath,
}, args.polish_args || {}))

log('polish 完成: ' + (polishResult.article_html_path || ''))

return {
  draft_path: draftResult.draft_path,
  topic: args.topic,
  title: draftResult.title,
  word_count: draftResult.word_count,
  reference_count: gather.reference_count,
  reference_files: gather.reference_files.map(function(f) { return f.filename }),
  reference_dir: gather.reference_dir,
  polish_result: polishResult,
  ok: true,
}
