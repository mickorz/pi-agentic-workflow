export const meta = {
  name: 'wechat_sticker',
  description: '贴图与多图推送:构思、规划图序、生图到整组图审核,产出风格统一的图片+配文。对应 skill: wechat_sticker',
}

// 对应 skill: .opencode-workflows/workflows/references/wechat_sticker
// 输入 args:
//   topic       : 主题(或选题卡路径)
//   count       : 图片张数(<=9,微信限制)。缺省读 config multi_image_count 或 6
//   style       : 全组统一形态名。不传则按内容选
//   article_dir : 本篇目录(有则读 article.yaml 合并约束)
//   skip_confirm: 一条龙时不单独确认。缺省 false
//   skip_generate: 只写 prompt 不调 API。缺省 false
// 输出: { outline, imgs, prompts, ok }

const SKILL = '.opencode-workflows/workflows/references/wechat_sticker'
const count = Math.min(args.count || 6, 9)

phase('合并本篇约束')
const constraints = await agent(
  '你是贴图多图推送助手。请读配置合并本篇约束(见 下方规则 第1步):\n\n' +
  '1. 读 .aws-article/config.json: multi_image_count, tone, target_reader, custom_sticker_style > default_sticker_style, image_model(provider/base_url/model)。\n' +
  (args.article_dir ? '2. 读本篇 ' + args.article_dir + '/article.yaml,同键本篇优先。重点: multi_image_count, tone, target_reader, custom_sticker_style/default_sticker_style。\n' : '') +
  '3. 读 ' + SKILL + '/branches.md 三节了解风格加载优先级与九个形态分类(信息位 5 个 / 节奏位 3 个)。\n' +
  '4. 读 ' + SKILL + '/workflow.md 了解 outline.md 模板。\n' +
  '5. 读 ' + SKILL + '/checklist.md 审图清单。\n\n' +
  '主题: ' + (args.topic || '(待定)') + '\n' +
  '张数: ' + count + '\n\n' +
  '无有效 YAML 时用用户口述主题 + skill 默认值。返回合并约束摘要。',
  { label: '读约束', agentType: 'general' }
)

phase('确定风格')
const styleResult = await agent(
  '你是贴图风格策划。确定全组统一形态(见 下方规则 第3步)。\n\n' +
  '约束:\n' + constraints + '\n\n' +
  '规则:\n' +
  '- 全组图统一一个形态,组图的价值在整齐,每张换一个等于没有风格。\n' +
  '- 九个形态分两类: 信息位 5 个(讲内容)、节奏位 3 个(换口气)。加载优先级: 用户指定 > article.yaml custom_sticker_style > default_sticker_style > custom_* 候选池。\n' +
  '- ' + (args.style ? '用户指定形态: ' + args.style + ',以此为准。\n' : '按主题内容选一个最适合的形态。\n') +
  '\n返回: 选定形态名, 分类(信息位/节奏位), 选择理由。',
  { label: '定风格', agentType: 'general', schema: {
    type: 'object',
    properties: {
      style: { type: 'string' },
      category: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['style'],
  } }
)

phase('规划图序')
const outline = await agent(
  '你是贴图图序规划师。产出 imgs/outline.md(见 下方规则 第4步 + workflow.md 模板)。\n\n' +
  '主题: ' + (args.topic || '(待定)') + '\n' +
  '张数: ' + count + '\n' +
  '全组形态: ' + styleResult.style + ' (' + styleResult.category + ')\n' +
  '约束:\n' + constraints + '\n\n' +
  '规划规则:\n' +
  '- 每张图的用途、配文(独立成立的一段短文)、文件名(01/02/.../09)。\n' +
  '- 张数 <= 9(微信限制)。\n' +
  '- 贴图类型与叙事线见 ' + SKILL + '/branches.md 四节。\n' +
  '- 全组风格统一不漂移。\n' +
  '- 第一张缩略图下仍可辨(微信列表只显示第一张)。\n\n' +
  '用 Write 工具把 outline.md 写到 ' + (args.article_dir || '.') + '/imgs/outline.md。\n' +
  '返回 outline 全文。',
  { label: '规划图序', agentType: 'general' }
)

phase('展示方案并确认')
if (!args.skip_confirm) {
  log('贴图方案已生成,等待用户确认')
  const approved = await checkpoint(
    '贴图方案已生成(' + count + ' 张图,形态: ' + styleResult.style + ')。\n' +
    'outline 已写入。允许=开始写 prompt 与生图(会调 API 产生费用);拒绝=终止。'
  )
}

phase('写prompt与生图')
const genResult = await agent(
  '你是贴图生图执行者。为每张图写 prompt 并调生图 API(见 下方规则 第6步)。\n\n' +
  'outline:\n' + outline + '\n\n' +
  '全组形态: ' + styleResult.style + '\n' +
  '约束:\n' + constraints + '\n\n' +
  '执行步骤:\n' +
  '1. 为每张图生成一个 prompt 文件,用 Write 工具写到 ' + (args.article_dir || '.') + '/imgs/prompts/01.md ~ ' + count + '.md。\n' +
  '2. prompt 规则与长文配图一致(见 .opencode-workflows/workflows/references/wechat_article_images/image-styles/prompt-construction.md): 媒介优先、构图要求、图中文字必须为中文且在 prompt 里直接写出、禁用绘图库重画。全组统一形态风格不漂移。\n' +
  (args.skip_generate ? '3. skip_generate=true,只写 prompt 不调 API。\n' :
  '3. 从 aws.env 读 IMAGE_MODEL_API_KEY,从 config.json 读 image_model.base_url 与 model。用 bash + curl 调生图 API,把图片下载到 ' + (args.article_dir || '.') + '/imgs/01.png ~ ' + count + '.png。\n' +
  '4. 优先调专用生图 API;环境未就绪时降级为只出 prompts 并说明原因,不要伪造生成。\n' +
  '5. 必须告知用户当前用的是哪种(用 log 记录)。\n') +
  '\n返回: 已写 prompt 路径列表, 已生成图片路径列表(或空若 skip), 失败列表, ok。',
  { label: '写prompt生图', agentType: 'general', schema: {
    type: 'object',
    properties: {
      prompts: { type: 'array', items: { type: 'string' } },
      imgs: { type: 'array', items: { type: 'string' } },
      failed: { type: 'array', items: { type: 'object' } },
      ok: { type: 'boolean' },
    },
    required: ['prompts', 'ok'],
  } }
)

phase('审图')
const reviewResult = await agent(
  '你是贴图审图员。按贴图专用清单审图(见 ' + SKILL + '/checklist.md)。\n\n' +
  '生成结果: ' + JSON.stringify(genResult) + '\n\n' +
  '重点是整组看:\n' +
  '- 风格是否统一(全组一个形态)\n' +
  '- 第一张缩略图下是否仍可辨\n' +
  '- 图序是否读得通(叙事线连贯)\n' +
  '- 每张配文是否独立成立\n' +
  '- 图中文字完整无缺字\n' +
  '- 比例与微信要求一致\n\n' +
  '输出: 各项 [OK]/[FAIL] + 整组是否通过。不合格给具体修改建议(改 prompt 重生成,不要盲目重跑)。',
  { label: '审图', agentType: 'general', schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      report: { type: 'string' },
    },
    required: ['ok', 'report'],
  } }
)

phase('交付')
log('贴图完成: ' + (genResult.imgs ? genResult.imgs.length : 0) + ' 张图')
await checkpoint(
  '贴图整组已完成' + (reviewResult.ok ? '并通过审图' : ',审图有不合格项') + '。\n' +
  '图片在 ' + (args.article_dir || '.') + '/imgs/\n' +
  '注意: 微信原生图片消息本套件未实现。要么拼成图文走常规链路(formatting+publish),要么只交付图由用户后台手发。\n\n' +
  '允许=结束;拒绝=标记问题。'
)

return {
  outline: outline,
  imgs: genResult.imgs || [],
  prompts: genResult.prompts || [],
  review: reviewResult.report,
  ok: reviewResult.ok,
}
