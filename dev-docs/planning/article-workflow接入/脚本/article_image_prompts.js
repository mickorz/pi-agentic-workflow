export const meta = {
  name: 'article_image_prompts',
  description: '独立配图 prompt 生成器: 输入文章 markdown + 规则文档, 输出封面与正文配图的生图 prompt。不依赖 .aws-article 配置, 不调生图 API, 纯 prompt 生成。自包含, 可独立运行。',
}

// 输入 args:
//   input_md      : 文章 markdown 文件路径(必填)
//   rules_doc     : 配图规则文档路径(必填, 指向"公众号配图prompt生成规则.md")
//   output_dir    : prompt 输出目录(默认 input_md 同目录下 imgs/prompts/)
//   cover_aspect  : 封面比例(2.35:1 / 16:9 / 1:1, 默认 2.35:1)
//   image_density : 配图密度(每节一图/按需配图/少图/多图, 默认 按需配图)
//   tone          : 账号调性(用于否决明显不搭的媒介, 可选)
//   prev_medium   : 上一篇用的媒介(用于平手时避开, 可选)
// 输出: { cover_prompt_path, image_prompts, deleted_slots, medium, output_dir }

phase('读文章与规则')
const analysis = await agent(
  '你是公众号配图 prompt 工程师。请完成以下分析:\n\n' +
  '1. 用 Read 工具读文章全文: ' + args.input_md + '\n' +
  '2. 用 Read 工具读配图规则文档全文: ' + args.rules_doc + '\n\n' +
  '3. 解析文章中的配图标记: 找出所有 ![类型:描述](placeholder) 标记。类型有: 封面/实证/信息图/氛围。无标记的段落, 按 image_density=' + (args.image_density || '按需配图') + ' 判断是否需要补图位。\n\n' +
  '4. 对每个图位, 按规则文档第二部分第一步判断:\n' +
  '   - 删掉它读者会「看不懂」= 信息位(必须留, 必须带文章真实内容)\n' +
  '   - 删掉它读者会「读不下去」= 节奏位(可留可换)\n' +
  '   - 都不影响 = 候选删除(每篇最多删 1 个, 必须写明原因)\n\n' +
  '5. 对每个信息位图位, 按规则文档第二部分第一步半判断: 该用图还是用组件?\n' +
  '   - 有空间关系(大小/流向/嵌套/位置) -> 用图\n' +
  '   - 只是文字并列/对照/枚举 -> 用组件(不从图位生成 prompt)\n' +
  '   - 金句卡片(> ... —— 出处) -> 用组件, 不生成配图 prompt\n' +
  '   \n' +
  '   ⛔ 防漏规则(重要): 只要文章里有 ![...] 配图标记, 就必须为它生成 prompt, use_component=false。不要因为前面有代码块/表格/列表就把配图标记判定为用组件跳过。代码块是纯文本箭头, 配图是可视化图(白板/笔记本等媒介画出来的), 两者不重复——配图用空间布局(箭头方向/节点位置/高低大小)表达代码块用文字表达的内容, 信息密度更高、更直观。唯一用组件的是金句卡片(> ... —— 出处)。演进路径/流程步骤/对比/数据这些有空间关系(流向/大小/嵌套/位置)的内容, 即使前面有代码块或表格, 也要用图, use_component=false。\n\n' +
  '6. 按规则文档第二部分第四步为本篇定媒介:\n' +
  '   - 第一顺位: 按本篇讲的内容定(命令行->终端等宽, 评测->打印稿批注, 流程->白板...)\n' +
  '   - 第二顺位: tone=' + (args.tone || '(未指定)') + ' 只否决明显不搭的\n' +
  '   - 第三顺位: 平手时避开上一篇用的媒介=' + (args.prev_medium || '(未指定)') + '\n' +
  '   - 扁平矢量是 AI 味默认值, 别的场合别选\n' +
  '   - 记住: 篇内所有信息位配图共用同一个媒介\n\n' +
  '7. 提取封面信息: 文章标题、摘要、核心张力(什么变成了什么)、关系类型(并置/融合/替代/氛围)\n\n' +
  '返回以下结构化结果。',
  { label: '分析', agentType: 'general', schema: {
    type: 'object',
    properties: {
      article_title: { type: 'string' },
      article_summary: { type: 'string' },
      core_tension: { type: 'string', description: '核心张力: 什么变成了什么' },
      relation_type: { type: 'string', description: '并置/融合/替代/氛围' },
      cover_marker: { type: 'string', description: '文章中的封面标记描述, 无则 null' },
      image_slots: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'number' },
            type: { type: 'string', description: '封面/信息图/氛围/实证' },
            desc: { type: 'string', description: '标记描述或补画的描述' },
            position: { type: 'string', description: '在文章中的位置(行号或小节名)' },
            role: { type: 'string', description: '信息位/节奏位/候选删除' },
            use_component: { type: 'boolean', description: '该用组件而非图' },
            content_to_draw: { type: 'string', description: '信息位: 从文章抄的真实内容; 节奏位: 空' },
          },
        },
      },
      medium: { type: 'string', description: '本篇选定的媒介' },
      medium_reason: { type: 'string', description: '选这个媒介的理由' },
      deleted_slots: { type: 'string', description: '删除的图位及原因, 无则空' },
    },
    required: ['article_title', 'core_tension', 'image_slots', 'medium'],
  } }
)

log('分析完成: ' + analysis.image_slots.length + ' 个图位, 媒介=' + analysis.medium)

phase('生成封面 prompt')
const coverPrompt = await agent(
  '你是公众号封面 prompt 工程师。按规则文档第一部分的七步推导法, 为本篇文章生成封面配图的生图 prompt。\n\n' +
  '规则文档(已读): ' + args.rules_doc + '\n' +
  '如果你没读过, 用 Read 工具读它, 重点看第一部分「封面配图(七步推导)」。\n\n' +
  '文章分析结果:\n' +
  '- 标题: ' + analysis.article_title + '\n' +
  '- 摘要: ' + (analysis.article_summary || '') + '\n' +
  '- 核心张力: ' + analysis.core_tension + '\n' +
  '- 关系类型: ' + analysis.relation_type + '\n' +
  '- 封面标记: ' + (analysis.cover_marker || '(无, 需自己推导)') + '\n' +
  '- 封面比例: ' + (args.cover_aspect || '2.35:1') + '\n\n' +
  '七步推导:\n' +
  '1. 核心张力已有: ' + analysis.core_tension + '\n' +
  '2. 关系类型已有: ' + analysis.relation_type + '\n' +
  '3. 找视觉隐喻: 列 3 个候选, 按三条筛(一眼读懂/有点意外/调性搭), 选最强的。禁止陈词滥调(机器人/发光大脑/电路板大脑/机械手/握手/灯泡/齿轮/二进制雨/蓝色光环)\n' +
  '4. 选形态模板: 从 12 个封面形态里挑(菜品特写/人物出镜/场景实拍/剧照氛围/纯色大字/图上压字/信息表/数字冲击/对比式/截图标注/扁平插画/产品实拍)。判断: 主体在 345px 缩略图里自不自明\n' +
  '5. 按信息流尺寸布局: 标题 4-7 字, 字高占画面 25-35%, 元素不超过 3 个\n' +
  '6. 写成 150-300 字散文: 场景->主体细节->光->氛围->像什么不像什么->标题。正面描述, 不写不要X\n' +
  '7. 回看六条(在返回里写明每条通过/不通过)\n\n' +
  '输出格式: frontmatter 含 aspect(值加引号如 "2.35:1") 和 position: "文章首行 # 标题之前, 全文最顶部", 正文是散文 prompt。\n' +
  '用 Write 工具把 prompt 写到 ' + (args.output_dir || deriveOutputDir(args.input_md)) + '/cover.md\n' +
  '封面标题文案(4-7 字)必须用中文直接写出, 不要写 labels in Chinese。',
  { label: '封面prompt', agentType: 'general', schema: {
    type: 'object',
    properties: {
      prompt_path: { type: 'string' },
      visual_metaphor: { type: 'string', description: '选定的视觉隐喻' },
      metaphor_candidates: { type: 'string', description: '3 个候选及筛选理由' },
      form_template: { type: 'string', description: '选定的封面形态' },
      title_text: { type: 'string', description: '封面上的标题文案(4-7 字)' },
      review: { type: 'string', description: '回看六条结果' },
    },
    required: ['prompt_path', 'form_template', 'title_text'],
  } }
)

log('封面 prompt 完成: ' + coverPrompt.prompt_path + ' (形态=' + coverPrompt.form_template + ', 标题=' + coverPrompt.title_text + ')')

phase('生成正文配图 prompt')
const validSlots = analysis.image_slots.filter(s =>
  s.role !== '候选删除' && !s.use_component && s.type !== '封面'
)

const bodyPrompts = await agent(
  '你是公众号正文配图 prompt 工程师。按规则文档第二部分的七步推导法, 为本篇文章的每个保留图位生成生图 prompt。\n\n' +
  '规则文档: ' + args.rules_doc + '\n' +
  '如果你没读过, 用 Read 工具读它, 重点看第二部分「正文配图(七步推导)」和第三部分「Prompt 构建通用规则」。\n\n' +
  '本篇选定媒介: ' + analysis.medium + '\n' +
  '媒介理由: ' + (analysis.medium_reason || '') + '\n\n' +
  '保留的图位(' + validSlots.length + ' 个):\n' +
  JSON.stringify(validSlots, null, 2) + '\n\n' +
  '为每个图位生成 prompt, 规则:\n' +
  '1. 每个图位按内容选形态(流程步骤/结构分层/数据图表/对比两栏/清单要点/概念隐喻/场景还原)\n' +
  '2. 信息位: 内容必须从文章里取(已在 content_to_draw 字段给出), 逐字写进 prompt, 不让模型自由发挥\n' +
  '3. 节奏位: 不加具体信息, 概念隐喻或场景还原\n' +
  '4. prompt 第一句必须是媒介的完整物理描述(整句抄, 不是六字名号):\n' +
  '   ' + mediumPhysicalDesc(analysis.medium) + '\n' +
  '5. aspect: "16:9", 正文宽 1080px\n' +
  '6. 负向指令压不住模型默认形态: 不要写「不要 emoji」「不要卡片」, 要正面描述一个不含这些元素的具体画面\n' +
  '7. 图中文字必须中文, 直接写出要显示的中文原文, 不要写 labels in Chinese\n' +
  '8. 同一篇内多张配图必须错开可轮换维度(方向/格数/连接/配色等)\n' +
  '9. ⛔ 防漏规则: 不要跳过任何保留图位。即使图位内容前面已有代码块/表格/列表表达, 也要为该图位生成 prompt——配图用空间布局(箭头/节点/高低)可视化表达, 与纯文本代码块不重复。每个 validSlot 必须产出对应编号的 prompt 文件, 不许漏。\n\n' +
  '每个图位写一个 prompt 文件, 用 Write 工具写到 ' + (args.output_dir || deriveOutputDir(args.input_md)) + '/ 下:\n' +
  '- 文件名: 01.md, 02.md, 03.md...(按文章顺序)\n' +
  '- 每个文件 frontmatter 含 aspect: "16:9" 和 position(值为该图位在文章中的位置, 从 analysis slots 的 position 字段取, 必须含章节标题, 如"放在 ## 最简实现 下方"或"放在 ## 分水岭 下方第二段之后"), 正文是 prompt 散文\n' +
  '   position 字段告诉用户这张图放在文章的哪里, 必填, 不许省略\n\n' +
  '返回每个图位的 prompt 路径与要点。',
  { label: '正文prompt', agentType: 'general', schema: {
    type: 'object',
    properties: {
      prompts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'number' },
            path: { type: 'string' },
            form: { type: 'string', description: '选定的形态' },
            role: { type: 'string', description: '信息位/节奏位' },
            key_content: { type: 'string', description: '信息位: 画了什么真实内容' },
            review: { type: 'string', description: '回看四条结果' },
          },
        },
      },
    },
    required: ['prompts'],
  } }
)

log('正文 prompt 完成: ' + (bodyPrompts.prompts ? bodyPrompts.prompts.length : 0) + ' 个')

phase('回看自检')
const selfCheck = await agent(
  '你是配图 prompt 自检员。对已生成的所有 prompt 做回看自检。\n\n' +
  '规则文档: ' + args.rules_doc + '\n' +
  '用 Read 工具读以下 prompt 文件, 逐个检查:\n' +
  '- 封面: ' + (coverPrompt.prompt_path || '未生成') + '\n' +
  '- 正文: ' + (bodyPrompts.prompts || []).map(function(p) { return p.path }).join(', ') + '\n\n' +
  '封面检查六条(规则文档第一部分第七步):\n' +
  '1. 标题文案的字对不对、全不全(4-7 字)\n' +
  '2. 主体位置与标题区有无冲突\n' +
  '3. 元素是否不超过 3 个\n' +
  '4. 信息流 345px 宽可读性\n' +
  '5. 与文章相关性\n' +
  '6. 形态选择是否匹配内容自明性\n\n' +
  '正文检查四条(规则文档第二部分第七步):\n' +
  '1. 中文有无错字, 信息位内容是否文章真实内容\n' +
  '2. 有无 emoji/英文标点/多余说明小字\n' +
  '3. 手机满屏宽可读性\n' +
  '4. 与段落相关性\n\n' +
  '额外检查:\n' +
  '- 每个 prompt 第一句是否媒介完整物理描述(不是六字名号)\n' +
  '- 信息位内容是否逐字来自文章(不是模型编的)\n' +
  '- 同一篇内多张配图维度是否错开\n' +
  '- 图中文字是否直接写了中文原文(不是 labels in Chinese)\n' +
  '- 有无负向指令(不要 emoji/不要卡片 -> 应改为正面描述)\n\n' +
  '输出: 每个 prompt 的检查结果(通过/不通过+原因), 总体 ok。',
  { label: '自检', agentType: 'general', schema: {
    type: 'object',
    properties: {
      cover_check: { type: 'string' },
      body_checks: { type: 'string' },
      issues: { type: 'string', description: '发现的问题清单, 无则空' },
      ok: { type: 'boolean' },
    },
    required: ['ok'],
  } }
)

if (!selfCheck.ok) {
  phase('修复不合格项')
  await agent(
    '自检发现以下问题, 请修复对应 prompt 文件:\n\n' +
    selfCheck.issues + '\n\n' +
    '用 Read 工具读有问题的 prompt 文件, 用 Write 工具覆盖修复。\n' +
    '只改不合格项, 不要整篇重写。修复后再次自检。',
    { label: '修复', agentType: 'general' }
  )
}

log('配图 prompt 生成完成, 自检 ' + (selfCheck.ok ? '通过' : '已修复'))

return {
  cover_prompt_path: coverPrompt.prompt_path,
  cover_form: coverPrompt.form_template,
  cover_title_text: coverPrompt.title_text,
  cover_metaphor: coverPrompt.visual_metaphor,
  image_prompts: bodyPrompts.prompts || [],
  deleted_slots: analysis.deleted_slots || '',
  medium: analysis.medium,
  medium_reason: analysis.medium_reason,
  article_title: analysis.article_title,
  output_dir: args.output_dir || deriveOutputDir(args.input_md),
  self_check: selfCheck.ok,
  issues: selfCheck.issues || '',
  ok: true,
}

function deriveOutputDir(inputMd) {
  var sep = inputMd.lastIndexOf('/')
  var sep2 = inputMd.lastIndexOf('\\')
  var dir = sep >= 0 ? inputMd.substring(0, sep) : (sep2 >= 0 ? inputMd.substring(0, sep2) : '.')
  return dir + '/imgs/prompts'
}

function mediumPhysicalDesc(medium) {
  var descs = {
    '马克笔白板': '磁性白板、金属边框、手写行楷、红笔圈注、旧字迹残影',
    '方格笔记本': '格子纸、钢笔手绘、墨迹洇开、涂改、红笔波浪线',
    '便签手写': '彩色便签贴在木桌上、翘边投影、签字笔字迹',
    '黑板粉笔': '深墨绿黑板、粉笔飞白、云雾状旧擦痕、槽里的粉笔头与板擦',
    '牛皮纸圆珠笔': '牛皮纸折痕、蓝黑圆珠笔、划掉重写、咖啡渍',
    '终端等宽': '深色终端窗、等宽字、青色正文 + 橙色提示行、方块光标',
    '打印稿批注': 'A4 印刷体 + 红笔圈划、页边手写批注与箭头、卷边',
    '扁平矢量': '圆角矩形、箭头、低饱和色块(AI 味默认值, 别的场合别选)',
  }
  return descs[medium] || '(媒介未识别, 请从规则文档媒介池里整句抄)'
}
