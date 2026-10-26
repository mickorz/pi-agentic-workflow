export const meta = {
  name: 'wechat_article_polish',
  description: '原文 polish 一条龙: 接收原文 markdown 文件路径 -> review 审稿(诊断AI味+敏感词+错别字,定稿article.md) -> humanizer skill 去AI味 -> 图片提示词生成(可选,调 article_image_prompts.js) -> formatting 排版转HTML -> 输出。父编排, 串联 review/humanizer/image-prompts/formatting, 不依赖 aws.env(不发布)。',
}

// 输入 args:
//   input_md             : 原文 markdown 文件路径(必填)
//   article_slug         : 本篇目录名(不传则从 input_md 文件名去扩展名得到)
//   title                : 文章标题(不传则从原文首行 # 提取)
//   author               : 作者(不传则读 .aws-article/config.json 的 default_author, 再无则空)
//   theme                : 排版模版名(亲和/资讯/书卷/杂志/活力/手账/硬朗/技术)
//   scheme               : 排版配色名
//   humanizer_voice      : humanizer voice(casual/professional/technical/warm/blunt), 缺省 professional
//   humanizer_aggressive : 是否重度改写, 缺省 false
//   humanizer_iterate    : detect-rewrite-detect 迭代次数(1-3), 缺省 2
//   rules_doc            : 配图规则文档路径(传入则生成图片提示词, 不传则跳过该步)
//   cover_aspect         : 封面比例(2.35:1/16:9/1:1, 缺省 2.35:1)
//   image_density        : 配图密度(每节一图/按需配图/少图/多图, 缺省 按需配图)
//   tone                 : 账号调性(用于否决明显不搭的配图媒介, 可选)
//   skip_image_prompts   : 跳过图片提示词步骤, 缺省 false(有 rules_doc 时默认生成)
//   skip_setup_confirm   : 目录准备阶段不单独确认, 缺省 true(一条龙默认不弹)
// 输出: { article_dir, article_md_path, article_html_path, review_path, ai_tell_score_before, ai_tell_score_after, humanizer_report, image_prompts }

phase('环境自检与目录准备')
const setup = await agent(
  '你是公众号 polish 流程的初始化器。请完成以下步骤:\n\n' +
  '1. 验证原文存在: ' + args.input_md + ' (用 Read 工具读全文, 文件不存在则立即报错终止)。\n\n' +
  '2. 检查 .aws-article/config.json 是否存在(用 Glob 工具匹配 ".aws-article/config.json")。\n' +
  '   若不存在, 用 Read 工具读取 .opencode-workflows/workflows/my.json (JSON 预设包), 然后初始化:\n' +
  '   ```powershell\n' +
  '   New-Item -ItemType Directory -Path .aws-article/presets -Force | Out-Null\n' +
  '   ```\n' +
  '   - 用 Write 工具把 JSON 的 config 对象序列化写入 .aws-article/config.json (JSON 格式, UTF-8)。\n' +
  '   - 遍历 JSON 的 presets 数组, 每项 { path, content } 用 bash 写入 .aws-article/presets/<path> (保留原格式, 先 mkdir -p 父目录再写文件)。\n' +
  '   写完后用 Glob 工具验证 .aws-article/config.json 现在存在; 仍不存在则报错终止。\n\n' +
  '3. 从原文 markdown 提取元信息:\n' +
  '   - title: 第一个 # 行的标题文本(去掉 # 与前后空格); 原文无 # 则取首段第一句\n' +
  '   - author: ' + (args.author ? args.author : '读 .aws-article/config.json 的 default_author 字段; 没有则空字符串') + '\n' +
  '   - digest: 原文正文第一段(80-128 字, 去掉 markdown 标记); 若原文有 > 引用首段则用那段\n' +
  '   ' + (args.title ? '用户指定 title=' + args.title + ', 覆盖提取值' : '') + '\n\n' +
  '4. 计算本篇目录(在原文档所在目录下新建, 所有中间文件与最终文档都放这里):\n' +
  '   - slug: ' + (args.article_slug ? '用户指定=' + args.article_slug : '从 ' + args.input_md + ' 文件名去扩展名(用 bash: [System.IO.Path]::GetFileNameWithoutExtension("' + args.input_md + '"))') + '\n' +
  '   - parent_dir = ' + args.input_md + ' 所在目录(用 bash: Split-Path -LiteralPath "' + args.input_md + '" -Parent)\n' +
  '   - article_dir = parent_dir + "/" + slug\n' +
  '   - 用 bash 工具创建该目录(New-Item -ItemType Directory -Path <article_dir> -Force)\n' +
  '   - 后续所有产物(draft.md/article.yaml/article.md/article.html/review.md/imgs/prompts/等)都写到这个目录下, 不放到项目的 drafts 目录\n\n' +
  '5. 用 Write 工具在该目录创建 article.yaml, 最小字段(按 review/formatting 依赖):\n' +
  '   ```yaml\n' +
  '   title: <提取的 title>\n' +
  '   author: <提取的 author>\n' +
  '   digest: <提取的 digest>\n' +
  '   publish_completed: false\n' +
  '   image_source: user\n' +
  '   image_density: 按需配图\n' +
  '   default_structure: ""\n' +
  '   default_closing_block: ""\n' +
  '   ```\n' +
  '   注意: 原文若无配图标记, image_source=user 表示用户自带图, formatting 不会强制生成 placeholder。\n\n' +
  '6. 用 bash 工具把 ' + args.input_md + ' 复制到 article_dir/draft.md:\n' +
  '   ```powershell\n' +
  '   Copy-Item -LiteralPath "' + args.input_md + '" -Destination "<article_dir>/draft.md" -Force\n' +
  '   ```\n\n' +
  '7. 返回以下结构化结果。',
  { label: '初始化', agentType: 'general', schema: {
    type: 'object',
    properties: {
      article_dir: { type: 'string' },
      title: { type: 'string' },
      author: { type: 'string' },
      digest: { type: 'string' },
      config_ready: { type: 'boolean' },
      draft_path: { type: 'string' },
      article_yaml_path: { type: 'string' },
    },
    required: ['article_dir', 'title', 'config_ready', 'draft_path'],
  } }
)

if (!setup.config_ready) {
  log('配置初始化失败: .aws-article/config.json 不可用, 终止 polish 流程')
  return {
    article_dir: setup.article_dir || null,
    error: '配置初始化失败: .aws-article/config.json 不可用. 请确认 .opencode-workflows/workflows/my.json 存在且为合法 JSON 预设包, 或手动初始化到 .aws-article/',
    ok: false,
  }
}

log('目录准备完成: ' + setup.article_dir + ' (title=' + setup.title + ')')

phase('审稿')
const review = await workflow('wechat_article_review.js', {
  article_dir: setup.article_dir,
  mode: 'content',
  auto_fix: true,
})
log('审稿完成: red=0 ok=' + review.ok + ' -> ' + review.article_md_path)

if (!review.ok || !review.article_md_path) {
  return {
    article_dir: setup.article_dir,
    review_path: review.review_path,
    error: '审稿未通过, 已终止后续流程。请处理 review.md 中的红项后重跑',
    ok: false,
  }
}

phase('humanizer 去 AI 味')
const humanize = await agent(
  '你是去 AI 味改写员。任务: 对 ' + review.article_md_path + ' 做去 AI 味改写, 改写后覆盖写回同一路径。\n\n' +
  '执行步骤:\n\n' +
  '1. 用 skill 工具加载 humanizer skill (skill name: "humanizer")。加载后, 用 Read 工具按需读取 skill 目录下的 references/patterns.zh.md (中文原生模式 ZH1-ZH15, 实验性附录) 与 references/patterns.md (英文 P1-P55, 中文场景仅作参考)。\n\n' +
  '2. 用 Read 工具读 ' + review.article_md_path + ' 全文。先跑 detect 模式扫描, 计算原稿 AI 味分(0-100, 0=人味十足, 100=机味浓)。记为 score_before。\n\n' +
  '3. 用 bash 工具(PowerShell)把原稿备份到同目录 article-pre-humanize.md:\n' +
  '   ```powershell\n' +
  '   Copy-Item -LiteralPath "' + review.article_md_path + '" -Destination "' + setup.article_dir + '/article-pre-humanize.md" -Force\n' +
  '   ```\n\n' +
  '4. 按 humanizer skill 的 Step 3 (Rewrite Craft) 与中文附录 ZH1-ZH15 改写。voice=' + (args.humanizer_voice || 'professional') + ', purpose=essay, ' + (args.humanizer_aggressive ? 'aggressive=true ' : '') + 'iterate=' + (args.humanizer_iterate || 2) + ', ignore-code=true, ignore-quotes=true。\n' +
  '   关键改写点(按命中优先级):\n' +
  '   - ZH3 套话开头: 删「随着...的发展」「在当今时代」, 直接从最具体的句子开始\n' +
  '   - ZH4 AI 高频词: 「此外/值得注意的是/至关重要/赋能/抓手/闭环/底层逻辑」换日常说法或删\n' +
  '   - ZH2 首先/其次/最后 罗列: 删套话序词, 让逻辑本身决定顺序\n' +
  '   - ZH1 四字词语堆砌: 删空心的四字成语与对仗排比, 换带场景/代价/判断的压缩句\n' +
  '   - ZH6 设问-回答套路: 通篇出现则改直接陈述\n' +
  '   - 工整三段式排比: 几乎每节都排比则打散, 单处排比保留\n' +
  '   - 「不是 X 是 Y」800 字内 >=3 次才算命中, 命中则减少\n' +
  '   - 翻译腔长前置定语: 拆成中文口语短句\n' +
  '   - 句长均匀: 混入短句(3-8 字)与长句(25-40 字), 偶尔单字句\n' +
  '   - 「你值得/愿你」式祝福收尾: 删或换具体事实\n' +
  '   - 强行拔高升华: 删扯到人生/时代/意义的小技巧结尾\n' +
  '   - 命名仪式感: 删「我把这套方法称为『XX 法则』」式硬安名\n' +
  '   - 面面俱到: 砍到有偏袒的观点, 略过适用边界与例外\n\n' +
  '5. 改写硬约束(违反则失败):\n' +
  '   - 不发明新事实/数字/人名/引语; Concretizer pass 只把原文已暗示的具体细节显化, 缺则 flag 不编\n' +
  '   - 保留所有 markdown 结构(只许保留不许新增): ## ### 小标题、**加粗**、> 引用与金句卡、- 列表、![类型:描述](路径 "图注") 配图标记、--- 分隔、表格、{embed:...} 文末占位符原样不动\n' +
  '   - 图片标记铁律: 不新增、不修改、不删除任何 ![...](...) 图片标记。已有的 assets/xxx 路径不许改, 不许编造新路径如 imgs/01-xxx.png。图片由后续阶段处理, humanizer 只管文字\n' +
  '   - 过滤社交媒体用户名: 全文不许出现 @ 符号开头的英文用户名(如 @leoshen0/@LinearUncle/@Stephen4171127), 改为泛指(如"有开发者"/"一位面试官"/"评论区有人")\n' +
  '   - 标题(首个 # 行)保留不改\n' +
  '   - 加粗密度不破坏(review 刚自检过): 每 100 字一个落点, 连续 200 字不许无加粗\n' +
  '   - 不改原文已有的 > ... —— 出处 金句卡(那不是 AI 味, 是规范要求)\n' +
  '   - 改后字数与原稿差不超过 +-20% (不大幅扩写或删减)\n' +
  '   - 标点统一中文全角(,。?!: 「」『』), 不让半角混进中文\n\n' +
  '6. 改写后再跑一次 detect 扫描, 计算改写后 AI 味分, 记为 score_after。若 score_after > score_before - 10 且 iterate 次数未用完, 再改一轮(最多 ' + (args.humanizer_iterate || 2) + ' 轮)。\n\n' +
  '7. 用 Write 工具把改写后的全文覆盖写回 ' + review.article_md_path + ' (注意: 不写到别的文件, 就是 article.md 本身, 后续 formatting 要读它)。文件首行不加 [Score:...] 头标(那是给 chat 输出用的, 不进 article.md 正文)。\n\n' +
  '8. 返回以下结构化结果。',
  { label: '去 AI 味', agentType: 'general', schema: {
    type: 'object',
    properties: {
      score_before: { type: 'number' },
      score_after: { type: 'number' },
      patterns_fixed: { type: 'string' },
      backup_path: { type: 'string' },
      article_md_path: { type: 'string' },
      change_summary: { type: 'string' },
    },
    required: ['score_before', 'score_after', 'article_md_path'],
  } }
)

if (!humanize) {
  log('humanizer agent 返回 null(可能网络/超时), 跳过去AI味, 使用 review 后的 article.md 继续')
} else {
  log('humanizer 完成: AI 味 ' + humanize.score_before + ' -> ' + humanize.score_after)
}

var humanizeMdPath = (humanize && humanize.article_md_path) || review.article_md_path
var humanizeBackup = humanize ? humanize.backup_path : null
var humanizeScoreBefore = humanize ? humanize.score_before : 0
var humanizeScoreAfter = humanize ? humanize.score_after : 0
var humanizeReport = humanize ? humanize.change_summary : 'humanizer 失败(返回 null), 未执行去AI味'

phase('图片提示词')
let imagePrompts = null
if (args.rules_doc && args.skip_image_prompts !== true) {
  imagePrompts = await workflow('article_image_prompts.js', {
    input_md: humanizeMdPath,
    rules_doc: args.rules_doc,
    output_dir: setup.article_dir + '/imgs/prompts',
    cover_aspect: args.cover_aspect || '2.35:1',
    image_density: args.image_density || '按需配图',
    tone: args.tone,
  })
  log('图片提示词完成: 封面=' + (imagePrompts.cover_prompt_path || '无') + ' + ' + (imagePrompts.image_prompts ? imagePrompts.image_prompts.length : 0) + ' 张正文图, 媒介=' + (imagePrompts.medium || '未定'))
} else {
  log('跳过图片提示词步骤(rules_doc 未传或 skip_image_prompts=true)')
}

phase('排版')
const formatting = await workflow('wechat_article_formatting.js', {
  article_dir: setup.article_dir,
  theme: args.theme,
  scheme: args.scheme,
})
const htmlPath = (formatting && formatting.html_path) || (setup.article_dir + '/article.html')
log('排版完成: ' + htmlPath + (formatting ? '' : ' (formatting 返回 null, 已回退到默认路径)'))

return {
  article_dir: setup.article_dir,
  title: setup.title,
  author: setup.author,
  digest: setup.digest,
  review_path: review.review_path,
  article_pre_humanize_path: humanizeBackup,
  article_md_path: humanizeMdPath,
  article_html_path: htmlPath,
  theme: formatting ? formatting.theme : (args.theme || '亲和'),
  scheme: formatting ? formatting.scheme : args.scheme,
  ai_tell_score_before: humanizeScoreBefore,
  ai_tell_score_after: humanizeScoreAfter,
  humanizer_report: humanizeReport,
  image_prompts: imagePrompts ? {
    cover_prompt_path: imagePrompts.cover_prompt_path,
    cover_form: imagePrompts.cover_form,
    cover_title_text: imagePrompts.cover_title_text,
    body_prompts: imagePrompts.image_prompts,
    medium: imagePrompts.medium,
    output_dir: imagePrompts.output_dir,
  } : null,
  ok: true,
}
