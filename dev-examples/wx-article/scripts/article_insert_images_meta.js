export const meta = {
  name: 'article_insert_images_meta',
  description: '给文章按章节批量插入 imgs/ 配图并生成/更新 article.yaml 元数据。流程: 扫描 .md 章节+imgs 文件名 -> 按图名语义匹配章节 -> 在每章"一句话记住"前插入图片标记 -> 写/更新 article.yaml(title/digest/author/content_source/image_medium) -> 可选调 article_humanize 去 AI 味并输出问题报告 -> 检查图数量与路径。适用于"每章一个术语+一句话记住"类文章。',
}

// 输入 args:
//   article_dir  : 文章目录(必填,含 1 个 .md 源文件 + imgs/ 图片目录)
//   insert_script: 插图 py 脚本路径覆盖(可选,默认仓库相对路径 insert_images.py,从仓库根启动时无需传)
//   md_file      : 指定 .md 绝对路径(可选,不传则自动找:排除 article/draft/review/审稿/pre-humanize,取最长名)
//   title        : 覆盖 article.yaml 标题(可选,不传则用 agent 建议)
//   digest       : 覆盖 article.yaml 摘要(可选)
//   author       : 覆盖 article.yaml 作者(可选,不传则保留现有或 default_author)
//   skip_confirm : 跳过插图中的人工确认(可选,默认 false)
//   skip_humanize: 跳过去 AI 味(可选,默认 false,即默认在检查前调 article_humanize)
//   humanize_voice     : 去AI味 voice(casual/professional/technical/warm/blunt,默认 professional)
//   humanize_aggressive: 去AI味是否重度改写(默认 false)
//   humanize_iterate   : 去AI味迭代次数 1-3(默认 2)
// 输出: { article_dir, md_path, inserted, cover, cover_state, failed_count, unmatched[], title, digest, yaml_path, check_ok, sections_without_img[], humanize{}, ok }

if (!args.article_dir) {
  throw new Error('缺少必填参数 article_dir(文章目录,含 1 个 .md 源文件与 imgs/ 图片目录)')
}

// 插入脚本路径:仓库相对路径(wechat start / pi-workflow run 均从仓库根启动,见 CLAUDE.md 手动测试约定);换布局时传 args.insert_script。
const INSERT_SCRIPT = args.insert_script || 'dev-examples/wx-article/scripts/references/article_insert_images_meta/scripts/insert_images.py'

phase('扫描与匹配')
const scan = await agent(
  '你是文章配图匹配器。目标目录: ' + args.article_dir + '\n\n' +
  '1. 定位 .md 源文件: ' +
  (args.md_file
    ? '使用用户指定文件 ' + args.md_file
    : '在目标目录下用 Glob 找 *.md, 排除文件名以 article/draft/review 开头、含"审稿"、含 pre-humanize 的, 取文件名最长的一个') +
  '。记下其绝对路径(md_path)与文件名(md_name)。\n\n' +
  '2. 用 Read 读该 .md, 列出所有 "## " 开头的章节标题(完整行文本, 如 "## 01. RAG（检索增强生成）：让 AI 学会开卷考试")。\n\n' +
  '3. 用 Glob 列 目标目录/imgs 下的所有图片文件名(计数记 imgs_count)。若没有 imgs 目录或为空, 直接返回空匹配并说明。\n\n' +
  '3.5 封面检测(与发布流程同约定): 目录根 cover.(png|jpg|jpeg|webp) 优先; 其次 imgs/ 下 cover 开头的图片。找到则 cover 写相对文章目录路径(如 "cover.png" 或 "imgs/cover-xxx.png", imgs 下的保持 imgs/ 前缀不复制); 两处都没有则 cover 写空字符串。\n\n' +
  '4. 语义匹配: 对每张图片, 根据文件名里的主题词与章节标题的含义匹配, 选出最合适的章节。规则:\n' +
  '   - imgs 下 cover 开头的图是封面候选, 不参与章节匹配, 也不进 unmatched。\n' +
  '   - image 字段写 "imgs/<图片文件名>"(图片位于目标目录/imgs 下)。\n' +
  '   - heading 字段写该章节完整的 "## " 行文本(必须与 .md 中原文逐字一致, 用于脚本精确匹配)。\n' +
  '   - alt 字段写一句简短中文描述, 形如 "术语插画：<图意>"。\n' +
  '   - 一张图只匹配一个章节; 多个图可匹配不同章节。无法判断归属的放进 unmatched(写文件名)。\n\n' +
  '5. 生成 suggested_title: 不超过 32 字, 概括全文所有术语, 风格参考 "RAG、Embedding、向量数据库……9 个 AI 术语，接着讲"。\n' +
  '6. 生成 suggested_digest: 80-120 字, 用生活化比喻概括这篇文章讲了什么。\n\n' +
  '返回 JSON: { md_path, md_name, imgs_count, cover, images:[{image,heading,alt}], unmatched:[], suggested_title, suggested_digest }。',
  { label: '扫描', agentType: 'general', schema: {
    type: 'object',
    properties: {
      md_path: { type: 'string' },
      md_name: { type: 'string' },
      imgs_count: { type: 'number' },
      cover: { type: 'string' },
      images: { type: 'array', items: { type: 'object', properties: {
        image: { type: 'string' }, heading: { type: 'string' }, alt: { type: 'string' },
      }, required: ['image', 'heading'] } },
      unmatched: { type: 'array', items: { type: 'string' } },
      suggested_title: { type: 'string' },
      suggested_digest: { type: 'string' },
    },
    required: ['md_path', 'images'],
  } }
)

if (!scan.images || scan.images.length === 0) {
  return {
    article_dir: args.article_dir, md_path: scan.md_path || '',
    inserted: 0, failed_count: 0, unmatched: scan.unmatched || [],
    title: args.title || scan.suggested_title || '', digest: args.digest || scan.suggested_digest || '',
    yaml_path: '', check_ok: false, sections_without_img: [], ok: false,
    error: '没有可插入的图片(imgs 为空或未匹配到章节)',
  }
}

if (args.skip_confirm !== true) {
  await checkpoint(
    '即将把 ' + scan.images.length + ' 张图按章节插入到:\n' + (scan.md_name || scan.md_path) + '\n\n' +
    scan.images.map((x, i) => (i + 1) + '. ' + (x.image || '') + '  ->  ' + (x.heading || '')).join('\n') +
    (scan.cover ? ('\n封面: ' + scan.cover + '  ->  头部段落末尾(首个 ## 章节前)') : '') +
    ((scan.unmatched && scan.unmatched.length) ? ('\n\n未匹配(不会插入): ' + scan.unmatched.join(', ')) : '') +
    '\n\n允许=执行插入; 拒绝=终止。'
  )
}

phase('插入图片')
const mappingPath = args.article_dir + '/_insert_mapping.json'
// 解释器解析:Windows 装 python.org 版时 python3 是 Store 占位符(必败),macOS 只有 python3——先探测再用
const PY = args.python_bin || 'PY=$(command -v python3 || command -v python); "$PY"'
const insertCmd = PY + ' "' + INSERT_SCRIPT + '" --article-dir "' + args.article_dir + '" --md-file "' + (scan.md_path || (args.article_dir + '/article.md')) + '" --mapping-path "' + mappingPath + '"' + (scan.cover ? ' --cover-image "' + scan.cover + '"' : '')
const insert = await agent(
  '你是配图插入执行者。请按以下顺序操作:\n\n' +
  '1. 用 Write 工具把下面的 JSON 数组原样写入文件 ' + mappingPath + ' (UTF-8):\n' +
  JSON.stringify(scan.images) + '\n\n' +
  '2. 用 bash 工具执行(一条命令):\n' +
  insertCmd + '\n\n' +
  '脚本行为: 找到 .md -> 按每项的 heading 定位章节 -> 在该章节的"**一句话记住"行前插入 ![alt](image) 三行(空行+图+空行); 若章节无"一句话记住"则插到章节末尾。' +
  (scan.cover ? '另: 本次传了 -CoverImage "' + scan.cover + '", 脚本会把封面标记 ![文章封面](' + scan.cover + ') 插到头部段落末尾(首个 ## 章节前, 已存在则跳过)。' : '') + '\n' +
  '3. 解析 stdout: "[OK] ..." 表示成功插入; "[OK] cover ..."/"[SKIP] cover ..." 为封面插入/跳过; "=== inserted N / M ; cover: <state> ; md img markers now: K ===" 给出统计; 末尾 "=== ALL DONE ===" 表示全部成功; 有 "[FAIL]" 或退出码非 0 表示有失败项。cover_state 取统计行的 cover: 值(inserted/skipped/none/failed)。\n' +
  '4. 无论成功失败, 最后用 bash 删除临时文件 ' + mappingPath + ' (rm -f)。\n\n' +
  '不要自行改写 .md 正文, 只依赖脚本插入。\n' +
  '返回 JSON: { inserted, cover_state, failed_count, detail }(detail 放脚本关键输出行)。',
  { label: '插入', agentType: 'general', schema: {
    type: 'object',
    properties: {
      inserted: { type: 'number' },
      cover_state: { type: 'string' },
      failed_count: { type: 'number' },
      detail: { type: 'string' },
    },
    required: ['inserted', 'failed_count'],
  } }
)

phase('更新元数据')
const metaResult = await agent(
  '你是 article.yaml 元数据维护者。目标目录: ' + args.article_dir + '\n\n' +
  '1. 用 Read 读 ' + args.article_dir + '/article.yaml (若不存在则视为空文件)。保留其中已有的其它字段原值。\n\n' +
  '2. 确定字段值(优先用户传入, 其次保留原值, 最后用建议值):\n' +
  '   - title : ' + (args.title ? '用户指定=' + args.title : '优先用原 title; 若原 title 明显与本文不符则用 ' + (scan.suggested_title || '')) + '\n' +
  '   - author: ' + (args.author ? '用户指定=' + args.author : '保留原 author; 没有则用 AI奇点') + '\n' +
  '   - digest: ' + (args.digest ? '用户指定=' + args.digest : '优先用原 digest; 若与本文不符则用 ' + (scan.suggested_digest || '')) + '\n' +
  '   - content_source: ' + (scan.md_name || '') + ' (本篇 .md 文件名)\n' +
  '   - image_medium: 形如 "AI生成插画（正文 ' + (scan.images ? scan.images.length : 0) + ' 张）"(若原值描述了错误的图片数量则更新)\n' +
  '   - publish_completed: false (本次插图+改元数据后需重新发布)\n' +
  '   其余字段(image_source/image_density/default_structure/default_closing_block 等)保留原值, 没有则不写。\n\n' +
  '3. 用 Write 工具把完整 YAML 覆盖写回 ' + args.article_dir + '/article.yaml (UTF-8, 键值顺序: title/author/digest/publish_completed/content_source/image_source/image_density/image_medium/default_structure/default_closing_block)。\n' +
  '   注意: YAML 值若含英文冒号或 # 才需要加引号; 中文全角标点无需引号。\n\n' +
  '返回 JSON: { yaml_path, title, digest, ok }。',
  { label: '元数据', agentType: 'general', schema: {
    type: 'object',
    properties: {
      yaml_path: { type: 'string' },
      title: { type: 'string' },
      digest: { type: 'string' },
      ok: { type: 'boolean' },
    },
    required: ['ok'],
  } }
)

phase('去 AI 味')
let humanizeResult = null
if (args.skip_humanize !== true) {
  humanizeResult = await workflow('article_humanize.js', {
    md_path: scan.md_path,
    article_dir: args.article_dir,
    voice: args.humanize_voice,
    aggressive: args.humanize_aggressive,
    iterate: args.humanize_iterate,
  })
  if (humanizeResult && humanizeResult.ok) {
    log('去 AI 味: ' + humanizeResult.score_before + ' -> ' + humanizeResult.score_after + ', 问题 ' + ((humanizeResult.problems && humanizeResult.problems.length) || 0) + ' 条')
  } else {
    log('去 AI 味未成功或返回 null, 跳过(不影响配图结果)')
  }
} else {
  log('skip_humanize=true, 跳过去 AI 味')
}

phase('检查')
const check = await agent(
  '你是配图与元数据检查员。请核对:\n\n' +
  '1. 读 ' + scan.md_path + ', 统计 "![...](imgs/...)" 图片标记数量(img_markers)。\n' +
  '2. 逐个校验每张引用图在 ' + args.article_dir + ' 下真实存在(路径相对 article_dir), 收集不存在的到 missing。\n' +
  (scan.cover ? '2.5 封面核对: 本篇封面是 ' + scan.cover + ', 确认 md 中存在指向它的 ![...](...) 标记(应在头部段落末尾、首个 ## 章节前)且文件真实存在; 缺失或位置不对写进 issues。\n' : '') +
  '3. 列出所有 "## " 章节, 标出没有任何配图的章节到 sections_without_img(有些章节本就无需图, 仅作提示)。\n' +
  '4. 读 ' + args.article_dir + '/article.yaml, 确认 title/digest/content_source 已更新且 content_source 指向的文件真实存在, 不一致写进 issues。\n' +
  '5. 综合判断 ok: 图片标记数 >= 已插数量且 missing 为空且 yaml 关键字段就绪。\n\n' +
  '返回 JSON: { ok, img_markers, missing:[], sections_without_img:[], issues }。',
  { label: '检查', agentType: 'general', schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      img_markers: { type: 'number' },
      missing: { type: 'array', items: { type: 'string' } },
      sections_without_img: { type: 'array', items: { type: 'string' } },
      issues: { type: 'string' },
    },
    required: ['ok'],
  } }
)

return {
  article_dir: args.article_dir,
  md_path: scan.md_path || '',
  md_name: scan.md_name || '',
  inserted: insert.inserted,
  cover: scan.cover || '',
  cover_state: insert.cover_state || 'none',
  failed_count: insert.failed_count,
  unmatched: scan.unmatched || [],
  title: (metaResult && metaResult.title) || '',
  digest: (metaResult && metaResult.digest) || '',
  yaml_path: (metaResult && metaResult.yaml_path) || '',
  check_ok: check.ok,
  img_markers: check.img_markers || 0,
  missing: check.missing || [],
  sections_without_img: check.sections_without_img || [],
  issues: check.issues || '',
  humanize: humanizeResult ? {
    score_before: humanizeResult.score_before,
    score_after: humanizeResult.score_after,
    problems: humanizeResult.problems || [],
    backup_path: humanizeResult.backup_path || '',
    change_summary: humanizeResult.change_summary || '',
  } : null,
  ok: insert.failed_count === 0 && check.ok,
}
