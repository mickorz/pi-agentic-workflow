export const meta = {
  name: 'wechat_article_topics',
  description: '公众号选题与标题生成:热点调研、选题策划、起标题、写摘要、系列排期。对应 skill: wechat_article_topics',
}

// 对应 skill: .opencode-workflows/workflows/references/wechat_article_topics
// 输入 args:
//   mode      : 'A'|'B'|'C'|'D'  A=明确选题 B=有方向 C=无方向 D=系列策划。缺省按 hint 判断
//   hint      : 主题提示或领域方向。A 模式必填
//   count     : 选题数量。缺省按 config.json 的 update_frequency
//   drafts_root : 草稿根目录。缺省 drafts
//   article_dir : 已存在的本篇目录(一条龙时 main 已建好)。有则往里写,不改目录名
//   series_slug : D 模式的系列 slug
// 输出: { topic_card, research, article_dir, title, digest }

const SKILL = '.opencode-workflows/workflows/references/wechat_article_topics'
const MAIN = '.opencode-workflows/workflows/references/wechat_article_main'
const mode = args.mode || (args.hint ? 'A' : 'C')
const draftsRoot = args.drafts_root || 'drafts'

phase('读配置与账号画像')
const configBrief = await agent(
  '你是公众号选题助手。请完成配置读取:\n' +
  '1. 读 .aws-article/config.json(不存在则读 ~/.aws-article/config.json),提取并返回: article_category, target_reader, default_author, topic_direction, update_frequency, tone, writing_style, forbidden_words, custom_sensitive_words, topic_boundary。\n' +
  '2. 读 .aws-article/writing-spec.md(如有),摘要其选题相关约束。\n' +
  (args.article_dir ? `3. 本篇目录 ${args.article_dir} 若已有 article.yaml,读其 title/digest 避免冲突。\n` : '') +
  '4. ls .aws-article/products/ 看用户业务资料库,若有与本次主题相关的产品,读其根下 *.md 摘要要点。\n\n' +
  '把结果整理成「账号画像 + 选题边界」文本返回,所有非空字段都要列出。这是后续调研与选题的依据。',
  { label: '读配置', agentType: 'general' }
)

phase('调研')
const researchTarget = {
  A: '围绕用户给定主题,调研竞品文章怎么写、数据支撑、独特切入角度',
  B: '该方向近期热点、读者关注什么',
  C: 'config.json 的账号定位、topic_direction 与近期热点',
  D: '知识体系拆解、竞品系列分析、读者学习路径',
}[mode]

const research = await agent(
  '你是公众号选题调研员。调研目标: ' + researchTarget + '\n' +
  '用户提示: ' + (args.hint || '(无,按账号定位)') + '\n\n' +
  '账号画像与约束:\n' + configBrief + '\n\n' +
  '请使用 web_search 搜索 + web_fetch 深读,为选题提供数据支撑。调研策略参考 ' + SKILL + '/research-strategy.md。\n' +
  '产出一份调研摘要: 搜索发现、竞品分析、数据点、可切入角度。要具体、有出处,不要空泛。',
  { label: '调研', agentType: 'general' }
)

phase('生成选题')
const count = args.count || 4
const topicCards = await agent(
  '你是公众号选题策划。按以下输入生成 ' + count + ' 个选题卡片。\n\n' +
  '模式: ' + mode + ' (A=围绕主题多角度 B/C=筛热点 D=系列拆解)\n' +
  '用户提示: ' + (args.hint || '(无)') + '\n' +
  '账号画像:\n' + configBrief + '\n\n' +
  '调研摘要:\n' + research + '\n\n' +
  '每个选题卡片包含(模板见 ' + SKILL + '/output-format.md):\n' +
  '1. 标题候选 3-5 个(混合风格,风格预设见 ' + SKILL + '/title-presets.md 的悬念/干货/数字/反问/故事五种)\n' +
  '2. 切入角度(一两句)\n' +
  '3. 大纲预览(3-5 个小节)\n' +
  '4. 工作量评估\n' +
  '5. 摘要候选(80-128 字,要能独立成立,不是正文首段复述)\n' +
  '6. 选题类型标注(热点/常青/系列)\n\n' +
  (mode === 'D' ? '系列模式: 规划系列总线 + 拆出每篇选题,系列规划单独一段。\n' : '') +
  '禁忌: 标题不碰 config 的 forbidden_words;摘要不与正文导语写成同一句。\n' +
  '按 markdown 输出全部选题卡片,编号清晰。',
  { label: '生成选题', agentType: 'general' }
)

phase('展示并确认')
log('已生成 ' + count + ' 个选题卡片,等待用户确认落盘')
const approved = await checkpoint(
  '选题方案已生成(见上方输出)。确认采用并落盘吗?\n' +
  '允许=落盘 topic-card.md / research.md / article.yaml;\n' +
  '拒绝=终止,请调整 args(mode/hint/count)后重跑。'
)

phase('落盘')
const persistResult = await agent(
  '你是公众号选题落盘执行者。用户已确认选题方案,请落盘。\n\n' +
  '选题卡片全文:\n' + topicCards + '\n\n' +
  '调研摘要:\n' + research + '\n\n' +
  '落盘规则(见 下方规则 第8步):\n' +
  '1. 本篇目录: ' + (args.article_dir ? args.article_dir + ' (已存在,直接往里写,不改目录名)' : '新建 ' + draftsRoot + '/YYYYMMDD-标题slug/ (日期前缀用 args.today,缺省用 20260101)') + '\n' +
  '2. 选题卡片 -> topic-card.md\n' +
  '3. 调研摘要 -> research.md\n' +
  (mode === 'D' ? '4. 系列规划 -> .aws-article/series/' + (args.series_slug || 'series') + '/plan.md\n' : '') +
  '5. article.yaml: 用 YAML 写本篇元数据,字段参考 ' + MAIN + '/articlescreening-schema.md 的字段说明。必填: title(用户选定的标题), digest(对应摘要), publish_completed: false。用 Write 工具写。\n\n' +
  '若用户在选题卡片里选了某一个,以那一个的标题与摘要为准;若方案里只推荐了一个,用它。\n' +
  '完成后返回: article_dir(最终目录路径), title, digest, topic_card_path, research_path。',
  { label: '落盘', agentType: 'general', schema: {
    type: 'object',
    properties: {
      article_dir: { type: 'string' },
      title: { type: 'string' },
      digest: { type: 'string' },
      topic_card_path: { type: 'string' },
      research_path: { type: 'string' },
    },
    required: ['article_dir', 'title', 'digest'],
  } }
)

return {
  topic_card: topicCards,
  research: research,
  article_dir: persistResult.article_dir,
  title: persistResult.title,
  digest: persistResult.digest,
  topic_card_path: persistResult.topic_card_path,
  research_path: persistResult.research_path,
}
