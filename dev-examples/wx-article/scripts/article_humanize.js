export const meta = {
  name: 'article_humanize',
  description: '独立去 AI 味 workflow: 对指定 markdown 做 detect -> rewrite -> detect, 输出改写前后 AI 味评分与具体修复项。参考 wechat_article_polish 的 humanizer 阶段抽离, 可单独运行。保留全部 markdown 结构与图片标记, 不改标题。',
}

// 输入 args:
//   md_path     : 要改写的 markdown 绝对路径(必填; 也可只给 article_dir 让其自动找)
//   article_dir : 文章目录(可选; 不给则用 md_path 所在目录, 用于放备份)
//   voice       : casual / professional / technical / warm / blunt, 默认 professional
//   aggressive  : 是否重度改写, 默认 false
//   iterate     : detect-rewrite-detect 迭代次数 1-3, 默认 2
//   purpose     : 写作用途, 默认 essay
// 输出: { ok, article_md_path, score_before, score_after, patterns_fixed, problems[], backup_path, change_summary }

phase('定位全文')
const locate = await agent(
  '请定位要改写的 markdown:\n\n' +
  '1. 用户指定 md_path: ' + (args.md_path || '(未指定)') + '\n' +
  '2. 用户指定 article_dir: ' + (args.article_dir || '(未指定)') + '\n' +
  '若 md_path 已给, 用 Glob 确认存在; 若只有 article_dir, 则在其下找 .md: ' +
  '优先 article.md; 否则排除 article/draft/review/审稿/pre-humanize 后取文件名最长的一个。\n' +
  '3. 用 Read 读该 .md 全文, 统计字符数(去掉 markdown 符号的正文长度)。\n' +
  '4. 前置检查 humanizer skill 是否可用: 用 bash 分别检查以下路径是否存在, 任一存在即 skill_ready=true:\n' +
  '   - ~/.pi/agent/skills/humanizer/SKILL.md\n' +
  '   - .pi/skills/humanizer/SKILL.md (项目级)\n' +
  '   两个都不存在则 skill_ready=false(不猜路径, 只报告检查结果)。\n\n' +
  '返回 JSON: { md_path, article_dir, char_count, exists, skill_ready }。',
  { label: '定位', agentType: 'general', schema: {
    type: 'object',
    properties: {
      md_path: { type: 'string' },
      article_dir: { type: 'string' },
      char_count: { type: 'number' },
      exists: { type: 'boolean' },
      skill_ready: { type: 'boolean' },
    },
    required: ['md_path', 'exists', 'skill_ready'],
  } }
)

if (!locate.exists) {
  return { ok: false, error: '找不到要改写的 .md: ' + (locate.md_path || args.md_path || '') }
}

// 前置门: humanizer skill 缺失则立即失败, 不静默降级(改写质量依赖 ZH1-ZH15 模式库)。
// 被上层 article_insert_images_meta 嵌套调用时, 该失败会被父流程记录并跳过, 不影响配图结果。
if (locate.skill_ready !== true) {
  return {
    ok: false,
    error: 'humanizer skill 未安装。安装: 复制 ~/.claude/skill-vault/humanizer 整个目录到 ~/.pi/agent/skills/humanizer (Windows 为 %USERPROFILE%\.pi\agent\skills\humanizer), 重启 wechat 后重试。',
    article_md_path: locate.md_path,
  }
}

phase('去 AI 味改写')
const result = await agent(
  '你是去 AI 味改写员。任务: 对 ' + locate.md_path + ' 做去 AI 味改写, 改写后覆盖写回同一路径。\n\n' +
  '执行步骤:\n\n' +
  '1. 用 skill 工具加载 humanizer skill (skill name: "humanizer")。加载后, 用 Read 按需读取 skill 目录下的 references/patterns.zh.md (中文原生模式 ZH1-ZH15) 与 references/patterns.md (英文 P1-P55, 中文场景仅参考)。\n\n' +
  '2. 用 Read 读 ' + locate.md_path + ' 全文。先跑 detect 模式扫描, 计算原稿 AI 味分(0-100, 0=人味十足, 100=机味浓), 记为 score_before。同时记录命中的具体问题到 problems(每条含: 模式编号/短名 + 所在小节或原句片段)。\n\n' +
  '3. 用 bash 工具(PowerShell)把原稿备份到 ' + locate.article_dir + '/article-pre-humanize.md:\n' +
  '   Copy-Item -LiteralPath "' + locate.md_path + '" -Destination "' + locate.article_dir + '/article-pre-humanize.md" -Force\n\n' +
  '4. 按 humanizer skill 的 Step 3 (Rewrite Craft) 与中文附录 ZH1-ZH15 改写。voice=' + (args.voice || 'professional') + ', purpose=' + (args.purpose || 'essay') + ', ' + (args.aggressive ? 'aggressive=true ' : '') + 'iterate=' + (args.iterate || 2) + ', ignore-code=true, ignore-quotes=true。\n' +
  '   关键改写点(按命中优先级):\n' +
  '   - ZH3 套话开头: 删「随着...的发展」「在当今时代」, 直接从最具体的句子开始\n' +
  '   - ZH4 AI 高频词: 「此外/值得注意的是/至关重要/赋能/抓手/闭环/底层逻辑」换日常说法或删\n' +
  '   - ZH2 首先/其次/最后 罗列: 删套话序词, 让逻辑本身决定顺序\n' +
  '   - ZH1 四字词语堆砌: 删空心四字成语与对仗排比, 换带场景/代价/判断的压缩句\n' +
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
  '   - 不发明新事实/数字/人名/引语; 只把原文已暗示的细节显化, 缺则 flag 不编\n' +
  '   - 保留所有 markdown 结构(只许保留不许新增): ## ### 小标题、**加粗**、> 引用与金句卡、- 列表、--- 分隔、表格、{embed:...} 占位符原样不动\n' +
  '   - 图片标记铁律: 不新增、不修改、不删除任何 ![...](...) 图片标记。已有的 imgs/xxx 路径与 alt 原文都不许改; 图片由配图阶段负责, 你只管文字\n' +
  '   - 过滤社交媒体用户名: 全文不许出现 @ 开头的英文用户名, 改为泛指("有开发者"/"一位面试官"/"评论区有人")\n' +
  '   - 标题(首个 # 行, 若有)保留不改; 若原文无 # 主标题则不动首行加粗标题\n' +
  '   - 加粗密度不破坏: 大致每 100 字一个落点, 不连续 200 字无加粗\n' +
  '   - 不改原文已有的 > ... —— 出处 金句卡\n' +
  '   - 改后字数与原稿差不超过 +-20%\n' +
  '   - 标点统一中文全角(,。?!: 「」『』), 不让半角混进中文\n\n' +
  '6. 改写后再跑一次 detect 扫描, 计算改写后 AI 味分, 记为 score_after。若 score_after > score_before - 10 且 iterate 次数未用完, 再改一轮(最多 ' + (args.iterate || 2) + ' 轮)。\n\n' +
  '7. 用 Write 工具把改写后的全文覆盖写回 ' + locate.md_path + ' (不写到别的文件)。文件首行不加 [Score:...] 头标。\n\n' +
  '8. 返回以下结构化结果。',
  { label: '去 AI 味', agentType: 'general', schema: {
    type: 'object',
    properties: {
      score_before: { type: 'number' },
      score_after: { type: 'number' },
      patterns_fixed: { type: 'string' },
      problems: { type: 'array', items: { type: 'string' } },
      backup_path: { type: 'string' },
      article_md_path: { type: 'string' },
      change_summary: { type: 'string' },
    },
    required: ['score_before', 'score_after', 'article_md_path'],
  } }
)

if (!result) {
  log('humanizer 返回 null(可能网络/超时), 未执行去AI味')
  return { ok: false, article_md_path: locate.md_path, error: 'humanizer 返回 null' }
}

log('去 AI 味完成: ' + result.score_before + ' -> ' + result.score_after + ', 修复项 ' + ((result.problems && result.problems.length) || 0) + ' 条')

return {
  ok: true,
  article_md_path: result.article_md_path || locate.md_path,
  score_before: result.score_before,
  score_after: result.score_after,
  patterns_fixed: result.patterns_fixed || '',
  problems: result.problems || [],
  backup_path: result.backup_path || (locate.article_dir + '/article-pre-humanize.md'),
  change_summary: result.change_summary || '',
}
