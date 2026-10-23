export const meta = {
  name: 'obsidian_outline',
  description: 'Obsidian 目录分析并制作文章大纲:下载引用图片到 imgs,生成图片引用清单,结合目录内容产出大纲',
  phases: [{ title: '目录定位' }, { title: '图片收集' }, { title: '图片分析' }, { title: '目录分析' }, { title: '大纲制作' }],
}

// 需求:《文章工作流接入需求》1 / 1.1 / 1.2
// 输入 args:
//   vaultDir : Obsidian 目录 A 绝对路径(定位通道之一;正斜杠或反斜杠均可)
//   vaultRef : Obsidian 逻辑引用(定位通道之二,VR S3.2): 目录名或 vault 相对路径(如 AI生图 或 newsky/AI生图),
//              服务端 vault_resolver 确定性解析(want=dir,精确路径/唯一目录命中;歧义列候选不猜)
//   vault_scope : 限定搜索范围(vault 相对目录或配置别名,可选,硬约束)
//   vault_ref_pinned_rel : 审批锚点(vault 相对路径;服务端审批链注入,外部传入仅作一致性比对)
// 输出: { outline_path, image_list_path, downloaded_count, image_count }

phase('目录定位')
let vaultDir = String(args.vaultDir || '').replace(/\\/g, '/')
if (!vaultDir && args.vaultRef) {
  const r = await vaultResolve(args.vaultRef, { scope: args.vault_scope, want: 'dir' })
  await check(
    () => r.ok === true,
    '目录定位失败: ' + JSON.stringify({ issues: r.issues, candidates: r.candidates }),
  )
  if (args.vault_ref_pinned_rel) {
    await check(
      () => r.resolved_rel === args.vault_ref_pinned_rel,
      '定位结果与批准目标不一致，请重新授权',
    )
  }
  vaultDir = String(r.resolved_path || '').replace(/\\/g, '/')
  log('vault 定位: ' + args.vaultRef + ' -> ' + r.resolved_rel)
}
if (!vaultDir) {
  throw new Error('缺少定位参数: vaultDir(绝对路径)或 vaultRef(Obsidian 逻辑引用)至少一个')
}
const imgsDir = vaultDir + '/imgs'

phase('图片收集')
// 需求 1.1:扫描目录内文章的图片引用(含外部 URL),下载到 A/imgs
const collect = await workflow('article_collect_images', {
  reference_dir: vaultDir,
  assets_dir: imgsDir,
})
log('图片收集完成: 下载 ' + collect.downloaded_count + ' 张, 失败 ' + (collect.failed_count || 0) + ' 张')

phase('图片分析')
// 需求 1.2:逐图分析作用,整理成图片引用清单文章,便于后续写作时判断插图位置
const imageList = await agent(
  '你是图片分析员。请分析目录中的图片并生成图片引用清单文章。\n\n' +
  '图片目录: ' + imgsDir + '\n' +
  '图片来源清单(扫描阶段产物,含描述/本地路径/来源): ' + JSON.stringify(collect.images || []).slice(0, 3000) + '\n\n' +
  '步骤:\n' +
  '1. 用 Glob 列出 ' + imgsDir + ' 下全部图片文件。\n' +
  '2. 用 Read 工具逐张读取图片(Read 支持图片),分析每张图的内容与作用(截图/示意图/数据图/背景素材等)。\n' +
  '3. 结合来源清单中的原始描述与出处,综合给出每张图的用途判断。\n' +
  '4. 把结果写成一篇 Markdown 清单文章并保存到: ' + vaultDir + '/图片引用清单.md\n' +
  '   格式: 每张图一节,含:文件名、来源出处、内容描述、适合插入的文章位置建议。\n' +
  '5. 文末加一节「使用建议」:汇总哪些图适合大纲中哪些章节。\n\n' +
  '返回 JSON: { image_count: 分析的图片数, image_list_path: 清单文件路径 }。',
  {
    label: '图片分析',
    agentType: 'general',
    schema: {
      type: 'object',
      properties: {
        image_count: { type: 'number', description: '分析的图片数量' },
        image_list_path: { type: 'string', description: '清单 md 文件路径' },
      },
      required: ['image_count', 'image_list_path'],
    },
  },
)
log('图片引用清单完成: ' + imageList.image_list_path)

phase('目录分析')
// 分析目录内容结构,为大纲提供素材
const dirAnalysis = await agent(
  '你是资料分析员。请分析 Obsidian 目录的文章结构。\n\n' +
  '目录: ' + vaultDir + '\n\n' +
  '步骤:\n' +
  '1. 用 Glob 列出 ' + vaultDir + ' 下全部 .md 文章(不含 imgs 与清单/大纲产出)。\n' +
  '2. 逐篇读取,提炼每篇的主题、核心观点、关键论据或数据。\n' +
  '3. 归纳目录整体的主题分布与内容脉络(哪些主题材料多、哪些单薄、相互关系)。\n\n' +
  '返回 JSON: { articles: [{ file, topic, key_points }], theme_summary: 目录整体主题脉络概述 }。',
  {
    label: '目录分析',
    agentType: 'general',
    schema: {
      type: 'object',
      properties: {
        articles: { type: 'array', items: { type: 'object' }, description: '每篇文章的主题与要点' },
        theme_summary: { type: 'string', description: '目录整体主题脉络' },
      },
      required: ['articles', 'theme_summary'],
    },
  },
)
log('目录分析完成: ' + (dirAnalysis.articles || []).length + ' 篇文章')

phase('大纲制作')
// 结合图片清单 + 目录分析,产出文章大纲
const outline = await agent(
  '你是内容策划师。基于以下材料为一篇文章制作大纲。\n\n' +
  '目录分析: ' + JSON.stringify(dirAnalysis).slice(0, 6000) + '\n\n' +
  '图片引用清单(可插图素材): ' + imgsDir + '/ 下的图片,清单见 ' + imageList.image_list_path + '\n\n' +
  '要求:\n' +
  '1. 从目录主题脉络中提炼最有价值的文章主线,确定目标读者与文章定位。\n' +
  '2. 产出结构化大纲: 标题(含备选)、各章节标题、每章要点(2-4 条)、建议篇幅占比。\n' +
  '3. 在合适章节标注可插入的图片文件名(来自图片清单的使用建议)。\n' +
  '4. 把大纲保存为: ' + vaultDir + '/大纲.md\n\n' +
  '返回 JSON: { title, outline_path, section_count }。',
  {
    label: '大纲制作',
    agentType: 'general',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文章标题' },
        outline_path: { type: 'string', description: '大纲 md 路径' },
        section_count: { type: 'number', description: '章节数' },
      },
      required: ['title', 'outline_path'],
    },
  },
)

// 产物确定性校验
const okOutline = await check(() => fileExists(outline.outline_path), '大纲文件应已生成')
const okList = await check(() => fileExists(imageList.image_list_path), '图片引用清单应已生成')

return {
  title: outline.title,
  outline_path: outline.outline_path,
  image_list_path: imageList.image_list_path,
  downloaded_count: collect.downloaded_count,
  image_count: imageList.image_count,
  section_count: outline.section_count || null,
  ok: okOutline && okList,
}
