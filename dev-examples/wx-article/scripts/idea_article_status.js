export const meta = {
  name: 'idea_article_status',
  description: '文章任务进展只读查询: title 给定→单任务详情(状态机位置/阶段文件清单与大小/最近讨论); title 为空→任务列表(标题+状态+当前阶段)。话术:「这篇文章进展怎么样」「灵感任务列表」「<标题>写到哪了」。',
  phases: [{ title: '任务查询' }, { title: '播报' }],
}

// idea_to_article V1.0 Phase C（执行方案 §5.2 status；read-only）
// 输入 args:
//   title : 任务标题（可选；空=列表模式。仅标题字符串，绝不含路径）
// 输出: { ok, mode, tasks|task, message }

const IDEA_FILES = 'dev-examples/wx-article/scripts/draft_manager/idea_files.py'

let PY_CACHE = null
async function resolvePy() {
  if (PY_CACHE) return PY_CACHE
  for (const py of ['python3', 'python', 'py']) {
    const probe = await command({ executable: py, args: ['-c', 'import sys'], timeoutMs: 15_000, label: 'python 探测 ' + py })
    if (probe.exitCode === 0) { PY_CACHE = py; return py }
  }
  throw new Error('无可用的 python 解释器（python3/python/py）')
}

async function runIdea(action, flagArgs) {
  const py = await resolvePy()
  const r = await command({ executable: py, args: [IDEA_FILES, action, ...flagArgs], timeoutMs: 60_000, label: 'idea_files ' + action })
  if (r.exitCode !== 0) return { ok: false, code: 'crash', issues: ['exit=' + r.exitCode] }
  try { return JSON.parse(r.stdout) } catch (e) { return { ok: false, code: 'bad_output', issues: [String(r.stdout).slice(0, 200)] } }
}

const STAGE_FILES = ['1-idea.md', '2-topic.md', '3-brief.md', '4-outline.md', '5-article.md', '6-review.md', '7-publish.md', '配图建议.md']
const NEXT_HINT = {
  idea_captured: '选题分析中',
  topic_generated: '选题分析中',
  waiting_topic_confirmation: '下一步: 回复「选 A/B/C」确认方向',
  brief_confirmed: '下一步: 回复「继续写文章」开始生成',
  outline_generated: '大纲已生成（等待确认或续写）',
  drafting: '正文写作中',
  reviewing: '审稿中',
  draft_ready: '已完成: 可「准备文章」进入配图/交接',
  handed_off: '已交接至文章流水线',
  paused: '已暂停: 回来说「继续 <标题>」',
}

phase('任务查询')
const title = String(args.title || '').trim()

if (title === '') {
  const list = await runIdea('list', [])
  await check(() => list.ok === true, '任务列表读取失败: ' + JSON.stringify(list.issues || []))
  const tasks = (list.tasks || []).map((t) => ({
    title: t.title,
    status: t.status,
    currentStage: t.currentStage || '',
    updatedAt: t.updatedAt || '',
  }))
  const rep = await agent(
    '生成微信回复: 文章任务列表。每个任务一行（标题+状态+下一步提示，来自 NEXT_HINT 映射或状态本身）；无任务时说明还没有任务并用一句话给主话术示例。\n\n' +
    '任务数据: ' + JSON.stringify(tasks) + '\n下一步提示映射: ' + JSON.stringify(NEXT_HINT) + '\n返回 JSON: { message: string }。',
    { label: '播报', agentType: 'general', schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } })
  return { ok: true, mode: 'list', tasks, message: rep.message }
}

const loc = await runIdea('locate', ['--title', title])
if (loc.ok !== true) {
  if (loc.code === 'ambiguous') {
    const list = (loc.candidates || []).map((c, i) => String(i + 1) + '. ' + c.title + '（' + c.status + '）').join('\n')
    return { ok: false, code: 'ambiguous', candidates: loc.candidates, message: '有多个任务匹配「' + title + '」：\n' + list + '\n请用完整标题重发。' }
  }
  return { ok: false, code: 'not_found', message: '没有找到「' + title + '」的任务。' }
}
const dir = loc.dir

const files = []
for (const f of STAGE_FILES) {
  const r = await runIdea('read', ['--dir', dir, '--file', f])
  if (r.ok === true) files.push({ file: f, size: r.size })
}
const messagesR = await runIdea('read', ['--dir', dir, '--file', 'messages.jsonl'])
let recent = []
if (messagesR.ok === true) {
  const lines = messagesR.content.trim().split('\n').filter((l) => l.trim() !== '')
  recent = lines.slice(-4).map((l) => { try { const j = JSON.parse(l); return j.role + ': ' + j.content.slice(0, 60) } catch (e) { return '' } }).filter((x) => x !== '')
}
const task = {
  title: loc.title,
  articleId: loc.articleId,
  status: loc.status,
  currentStage: loc.currentStage || '',
  updatedAt: loc.updatedAt || '',
  files,
  recentMessages: recent,
}

phase('播报')
const rep = await agent(
  '生成微信回复: 单任务进展报告。要素: 标题、当前状态与位置（下一步提示见映射）、已有阶段文件（file+size 约KB）、最近讨论 2-4 条摘句。结尾给一句下一步操作指引。\n\n' +
  '任务数据: ' + JSON.stringify(task) + '\n下一步提示映射: ' + JSON.stringify(NEXT_HINT) + '\n返回 JSON: { message: string }。',
  { label: '播报', agentType: 'general', schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } })

return { ok: true, mode: 'detail', task, message: rep.message }
