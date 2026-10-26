export const meta = {
  name: 'wechat_article_images',
  description: '公众号封面与正文配图:按文章内容自动匹配画风,生成 prompt 并调生图 API。对应 skill: wechat_article_images',
}

// 对应 skill: .opencode-workflows/workflows/references/wechat_article_images
// 输入 args:
//   article_dir    : 本篇目录(必填,含 article.md)
//   image_source   : 'generated'|'user'。缺省读 article.yaml,再无 generated
//   skip_confirm   : 一条龙时不单独确认。缺省 false
//   skip_generate  : 只写 prompt 不调 API(调试)。缺省 false
// 输出: { cover_path, imgs, prompts, ok }

const SKILL = '.opencode-workflows/workflows/references/wechat_article_images'

phase('读配置与解析配图标记')
const parseResult = await agent(
  '你是公众号配图助手。请读配置并解析配图标记(见 下方规则 第1-2步):\n\n' +
  '1. 读 .aws-article/config.json: cover_aspect, image_density, caption_style, tone, image_model(provider/base_url/model)。\n' +
  '2. 读本篇 ' + args.article_dir + '/article.yaml: default_cover_image_style(单元素), default_article_image_style(多元素候选池,不收敛), image_source, image_medium。\n' +
  '3. 读 ' + args.article_dir + '/article.md 全文,提取所有 ![类型:描述](placeholder) 标记。类型只有: 封面/实证/信息图/氛围。存量旧类型名(流程图/对比)按信息图处理。\n' +
  '4. ls .aws-article/products/ 看业务配图库,正文优先用业务配图(见 ' + SKILL + '/branches.md 第一节配图来源优先级)。\n\n' +
  'image_source: ' + (args.image_source || '读 article.yaml') + '\n' +
  (args.image_source === 'user' ? '用户供图模式: 不生成,走 user_image_prepare 建 imgs/ 与 img_analysis.md\n' : '') +
  '\n返回 JSON: 封面标记描述, 正文图位列表(每个含 类型/描述/是否用业务配图库), image_model 配置摘要, cover_aspect。',
  { label: '解析标记', agentType: 'general', schema: {
    type: 'object',
    properties: {
      cover_desc: { type: 'string' },
      image_slots: { type: 'array', items: { type: 'object' } },
      image_model: { type: 'string' },
      cover_aspect: { type: 'string' },
    },
    required: ['cover_desc', 'image_slots'],
  } }
)

phase('确定风格与写prompt')
const promptGen = await agent(
  '你是公众号配图 prompt 工程师。为每个图位写生图 prompt(见 下方规则 第3-4步)。\n\n' +
  '解析结果:\n封面: ' + parseResult.cover_desc + '\n正文图位: ' + JSON.stringify(parseResult.image_slots) + '\ncover_aspect: ' + parseResult.cover_aspect + '\n\n' +
  '风格确定规则:\n' +
  '- 封面: 内置 12 形态在 ' + SKILL + '/cover-styles/(每个 .example.md 含 用于/主体/影调/文案/版式)。用户自定义在 .aws-article/presets/cover-styles/。加载优先级: 用户指定 > article.yaml default_cover_image_style > custom_* 候选池。\n' +
  '- 正文: 内置 8 形态在 ' + SKILL + '/image-styles/。判据: 删掉这张图读者看不懂(信息位)还是读不下去(节奏位)。default_article_image_style 是多元素候选池,逐个图位各选一个,不收敛成单选。\n' +
  '- 先按内容定形态,每个图位形态各自选。\n\n' +
  '写 prompt 规则(见 ' + SKILL + '/cover-method.md 与 image-method.md):\n' +
  '- 封面: frontmatter 含 aspect(值加引号,如 "16:9"),正文 150-300 字散文,含标题文案(4-7 字,字高占画面 25-35%)+ 位置 + 字体感 + 颜色。不要关键词清单,不要写不要X,不要照抄范例。\n' +
  '- 正文信息位: 内容必须从文章里取,不要让模型自由发挥生成无关鸡汤。氛围位: 概念隐喻/场景还原,不放具体信息。\n' +
  '- 图中文字必须为中文,在 prompt 里直接写出要显示的那几个字,不要写 labels in Chinese。\n' +
  '- 通用规则: 媒介优先(照片/插画/3D等),构图要求,禁用绘图库重画。\n' +
  '- 实证图不生成,来源说明写进 imgs/sources/。\n\n' +
  '为每个图位生成一个 prompt 文件,用 Write 工具写到 ' + args.article_dir + '/imgs/prompts/ 下,文件名主干与图片一致(封面: cover.md;正文: 01.md 02.md ...)。\n' +
  '返回 JSON: 封面 prompt 路径与要点, 每个正文图位的 类型/风格/路径/prompt要点/来源(业务库或生成)。',
  { label: '写prompt', agentType: 'general', schema: {
    type: 'object',
    properties: {
      cover: { type: 'object' },
      slots: { type: 'array', items: { type: 'object' } },
    },
    required: ['cover', 'slots'],
  } }
)

phase('展示方案并确认')
if (!args.skip_confirm) {
  log('配图方案已生成,等待用户确认')
  const approved = await checkpoint(
    '配图方案已生成(封面 + ' + (promptGen.slots ? promptGen.slots.length : 0) + ' 张正文图)。\n' +
    '允许=开始生成图片(会调生图 API 产生费用);拒绝=终止,调整后重跑。'
  )
}

phase('生成图片')
let genResult
if (args.skip_generate) {
  genResult = { generated: [], skipped: true }
} else {
  genResult = await agent(
    '你是图片生成执行者。按已确认的 prompt 调生图 API 生成图片(见 下方规则 第6步)。\n\n' +
    '封面 prompt: ' + JSON.stringify(promptGen.cover) + '\n' +
    '正文图位: ' + JSON.stringify(promptGen.slots) + '\n\n' +
    'image_model 配置: ' + parseResult.image_model + '\n' +
    'cover_aspect: ' + parseResult.cover_aspect + '\n\n' +
    '执行规则:\n' +
    '1. 读 ' + args.article_dir + '/imgs/prompts/ 下每个 prompt 文件。\n' +
    '2. 从 aws.env 读 IMAGE_MODEL_API_KEY,从 config.json 读 image_model.base_url 与 model。\n' +
    '3. 用 bash + curl 调生图 API: POST image_model.base_url,Authorization: Bearer <key>,body 含 model 与 prompt。把返回的图片 URL 下载到 ' + args.article_dir + '/imgs/ 下(封面存为文章根目录 cover.png 或 imgs 同级)。\n' +
    '4. 先检查返回比例与文字完整性。脚本默认 fit: preserve 保留完整图;比例不符告警不自动裁。目标比例发布前验收。\n' +
    '5. 封面回看(必做): 主体位置与标题区、元素<=3、缩略图可读、与文章相关。不过关改 prompt 再生成,不要盲目重跑。\n' +
    '6. 实证图不生成,只用业务配图库或用户素材。\n' +
    '7. 用 bash mkdir -p ' + args.article_dir + '/imgs/{prompts,sources,raw} 确保目录分工: 根目录只放正文引用最终图,prompts/ 放 prompt,sources/ 放实证来源,raw/ 放中间产物。\n' +
    '8. 出字问题先改 prompt 不换工具。\n\n' +
    '若 API 不可用(key 缺失/端点不通),降级为只产出 prompt 文件并返回 ok=false,说明原因。不要伪造生成。\n' +
    '返回 JSON: 已生成图片列表(路径+类型), 失败列表(原因), 封面路径。',
    { label: '生图', agentType: 'general', schema: {
      type: 'object',
      properties: {
        generated: { type: 'array', items: { type: 'object' } },
        failed: { type: 'array', items: { type: 'object' } },
        cover_path: { type: 'string' },
        ok: { type: 'boolean' },
      },
      required: ['generated', 'ok'],
    } }
  )
}

phase('插入文章与收尾自检')
const finalize = await agent(
  '你是配图收尾执行者。完成插入文章与六条收尾自检(见 下方规则 第7步)。\n\n' +
  '生成结果: ' + JSON.stringify(genResult) + '\n\n' +
  '收尾规则:\n' +
  '1. 替换 ' + args.article_dir + '/article.md 与 article.html 中的 placeholder 为实际图片路径。封面不进正文: ![封面:...] 仅用于微信封面上传,替换时跳过或删除该行,封面单独存为文章根目录 cover.{ext}。\n' +
  '2. 仅当 article.html 里确实存在 href="placeholder" 或 placeholder 被渲染成链接时才修 HTML,不要默认每次都执行修复 HTML。\n' +
  '3. 六条收尾自检(缺一不可):\n' +
  '   a. 每张正文图各有一个 imgs/prompts/*.md,文件名主干与图片一致。先落 prompt 再生成。\n' +
  '   b. 实证图说明放 imgs/sources/,不许放 prompts/。\n' +
  '   c. article.yaml 的 image_medium 非空且等于实际用的媒介。\n' +
  '   d. 正文图数量与 image_density 对得上。删过图位要写明。\n' +
  '   e. 生成日志已落盘(image-generation.log)且看过腰斩告警。\n' +
  '   f. imgs/ 根目录只剩正文引用图,中间产物归 raw/;本篇所有信息位配图共用同一媒介,每个图位形态各自选。\n' +
  '4. 重跑生图后必须复核引用(返回格式会变 PNG/JPEG)。\n\n' +
  '把自检结果与最终 imgs 列表返回。',
  { label: '收尾', agentType: 'general', schema: {
    type: 'object',
    properties: {
      cover_path: { type: 'string' },
      imgs: { type: 'array', items: { type: 'string' } },
      self_check: { type: 'string' },
      ok: { type: 'boolean' },
    },
    required: ['imgs', 'ok'],
  } }
)

return {
  cover_path: finalize.cover_path || (genResult.cover_path || ''),
  imgs: finalize.imgs,
  prompts: promptGen,
  ok: finalize.ok,
}
