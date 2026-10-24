import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { makeRunner } from '../helpers/fake-runner.js'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const execFileP = promisify(execFile)
const IDEA_FILES = path.join(repoRoot, 'dev-examples/wx-article/scripts/draft_manager/idea_files.py')
const WRITE_SCRIPT = fs.readFileSync(path.join(repoRoot, 'dev-examples/wx-article/scripts/idea_article_write.js'), 'utf-8')
const STATUS_SCRIPT = fs.readFileSync(path.join(repoRoot, 'dev-examples/wx-article/scripts/idea_article_status.js'), 'utf-8')

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64')

async function py(vault: string, args: string[], stdin = '') {
  const { stdout } = await execFileP('python3', [IDEA_FILES, '--vault-root', vault, ...args], {
    input: stdin,
    maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  })
  return JSON.parse(stdout)
}

interface Fixture {
  vault: string
  dir: string
  articleId: string
}

const BRIEF_MD = [
  '# Brief',
  '',
  '## 目标读者',
  '想用 AI 提效的公众号作者，对自动化感兴趣但怕复杂。这是一段足够长的验收标准铺垫文字，用于满足 Brief 的最低长度校验要求，保证生成链检查通过。',
  '## 核心观点',
  '自动化不是取代人，而是把重复劳动交给流程。',
  '## 结构',
  '开头痛点→三个场景→收束。',
  '## 验收标准',
  '读者能复现第一个场景；总字数达标；语气口语化。',
  '## 确认记录',
  '用户于本轮确认方向: A',
  '',
].join('\n')

async function buildFixture(t: test.TestContext, title: string, status?: string, files: Record<string, string> = {}, reuse?: Fixture): Promise<Fixture> {
  if (reuse) {
    const init2 = await py(reuse.vault, ['init', '--title', title, '--message-id', `msg-${Date.now()}-x`, '--source-channel', 'wechat', '--user-id', 'u1', '--content-b64', b64('补充素材')])
    assert.equal(init2.ok, true, 'fixture init2 失败: ' + JSON.stringify(init2))
    return { ...reuse, dir: init2.dir, articleId: init2.articleId }
  }
  const vault = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ia-write-'))
  fs.mkdirSync(path.join(vault, '60_Workspace/写作/灵感'), { recursive: true })
  t.after(() => fs.promises.rm(vault, { recursive: true, force: true }))
  const prev = process.env.OBSIDIAN_VAULT_ROOT
  process.env.OBSIDIAN_VAULT_ROOT = vault
  t.after(() => {
    if (prev === undefined) delete process.env.OBSIDIAN_VAULT_ROOT
    else process.env.OBSIDIAN_VAULT_ROOT = prev
  })
  const init = await py(vault, ['init', '--title', title, '--message-id', `msg-${Date.now()}`, '--source-channel', 'wechat', '--user-id', 'u1', '--content-b64', b64('原始灵感内容')])
  assert.equal(init.ok, true, 'fixture init 失败: ' + JSON.stringify(init))
  const dir: string = init.dir
  const defaultFiles: Record<string, string> = { '2-topic.md': '# 选题卡\n', '3-brief.md': BRIEF_MD }
  for (const [f, c] of Object.entries({ ...defaultFiles, ...files })) {
    const w = await py(vault, ['write', '--dir', dir, '--file', f, '--content-b64', b64(c)])
    assert.equal(w.ok, true, `fixture write ${f} 失败`)
  }
  if (status) {
    const s = await py(vault, ['state', '--dir', dir, '--set', `status=${status}`])
    assert.equal(s.ok, true, 'fixture state 失败')
  }
  return { vault, dir, articleId: init.articleId }
}

function yamlField(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`^${key}: (\\S+)$`, 'm'))
  return m?.[1]
}

async function runWorkflowScript(script: string, args: Record<string, unknown>, impls: Record<string, () => Promise<unknown>>) {
  const labels = new Map<string, () => Promise<unknown>>()
  const counts = new Map<string, number>()
  const runner = makeRunner(async (_prompt: unknown, options: { label?: string }) => {
    const label = options.label ?? ''
    counts.set(label, (counts.get(label) ?? 0) + 1)
    const impl = labels.get(label) ?? impls[label]
    if (!impl) throw new Error('no impl for label: ' + label)
    const v = await impl()
    return { type: 'structured' as const, value: v as object, sessionId: 'fake' }
  }).runner
  const { runWorkflow } = await import('../../src/runtime/workflow-runtime.js')
  const result = await runWorkflow(script, { agent: runner, cwd: repoRoot, args })
  return { result: JSON.parse(JSON.stringify(result.result)), counts }
}

const OUTLINE_MD = '# 大纲\n\n## 一、开头痛点\n\n讲清重复劳动的浪费：每天手动搬运灵感、找图、排版，占掉写作时间的一半以上，而且极易出错。用一段真实场景引入。\n\n## 二、三个场景\n\n灵感自动落盘只是第一步，接着是配图建议自动生成、发布流程自动编排，逐个展开讲清前后对比。\n\n## 三、收束\n\n把重复交给流程，把创造留给自己，给出读者今天就能上手的第一步。'
const ARTICLE_MD = `---\ntitle: 测试文章标题\n---\n\n## 一、开头痛点\n\n${'每天重复的粘贴复制耗费大量时间，而且于得很累。'.repeat(14)}\n\n## 二、三个场景\n\n${'灵感自动落盘只是第一步，后面还有配图与发布两个场景。'.repeat(14)}\n\n## 三、收束\n\n${'把重复交给流程，把创造留给自己，这是本文想传递的核心。'.repeat(10)}`
const DIMS_CLEAR = Array.from({ length: 8 }, (_, i) => ({ 维度: `维度${i + 1}`, blocking: false, 意见: '不错' }))

test('write 全链: brief_confirmed→大纲→正文→审稿→draft_ready (T06/T07)', async (t) => {
  const fx = await buildFixture(t, '微信自动化', 'brief_confirmed')
  const { result, counts } = await runWorkflowScript(WRITE_SCRIPT, { title: '微信自动化' }, {
    '大纲生成': async () => ({ outline_md: OUTLINE_MD }),
    '正文生成': async () => ({ article_md: ARTICLE_MD }),
    审稿: async () => ({ dimensions: DIMS_CLEAR, summary: '通过' }),
    播报: async () => ({ message: '文章完成' }),
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.branch, 'full_chain')
  assert.equal(result.status, 'draft_ready')
  assert.equal(result.review.blocking, 0)
  assert.equal((counts.get('大纲生成') ?? 0), 1)
  assert.equal((counts.get('审稿') ?? 0), 1)
  const yamlText = fs.readFileSync(path.join(fx.dir, 'article.yaml'), 'utf-8')
  assert.equal(yamlField(yamlText, 'status'), 'draft_ready')
  for (const f of ['4-outline.md', '5-article.md', '6-review.md']) {
    assert.ok(fs.existsSync(path.join(fx.dir, f)), f + ' 应存在')
  }
  const reviewMd = fs.readFileSync(path.join(fx.dir, '6-review.md'), 'utf-8')
  assert.ok(!reviewMd.includes('⛔'), '无 blocking 审稿报告不应含 ⛔')
})

test('write outlineApproval=true: 大纲后暂停等确认; 确认大纲后复用大纲续写 (T08)', async (t) => {
  const fx = await buildFixture(t, '需要确认的大纲任务', 'brief_confirmed')
  await py(fx.vault, ['state', '--dir', fx.dir, '--set', 'config.outlineApproval=true'])
  const r1 = await runWorkflowScript(WRITE_SCRIPT, { title: '需要确认的大纲任务' }, {
    '大纲生成': async () => ({ outline_md: OUTLINE_MD }),
    播报: async () => ({ message: '大纲已生成等确认' }),
  })
  assert.equal(r1.result.ok, true, JSON.stringify(r1.result))
  assert.equal(r1.result.branch, 'awaiting_outline_approval')
  const yaml1 = fs.readFileSync(path.join(fx.dir, 'article.yaml'), 'utf-8')
  assert.equal(yamlField(yaml1, 'status'), 'outline_generated')
  const outlineBefore = fs.readFileSync(path.join(fx.dir, '4-outline.md'), 'utf-8')

  const r2 = await runWorkflowScript(WRITE_SCRIPT, { title: '需要确认的大纲任务', message: '确认大纲' }, {
    '正文生成': async () => ({ article_md: ARTICLE_MD }),
    审稿: async () => ({ dimensions: DIMS_CLEAR, summary: '通过' }),
    播报: async () => ({ message: '完成' }),
  })
  assert.equal(r2.result.ok, true, JSON.stringify(r2.result))
  assert.equal((r2.counts.get('大纲生成') ?? 0), 0, '确认后续写不应重新生成大纲')
  assert.equal(r2.result.status, 'draft_ready')
  assert.equal(fs.readFileSync(path.join(fx.dir, '4-outline.md'), 'utf-8'), outlineBefore, '大纲文件应保持不变')
  const yaml2 = fs.readFileSync(path.join(fx.dir, 'article.yaml'), 'utf-8')
  assert.equal(yamlField(yaml2, 'status'), 'draft_ready')
})

test('write blocking 审稿修复循环: 1 blocking→修复→复审通过, fixRounds=1 (T09)', async (t) => {
  const fx = await buildFixture(t, '审稿修复任务', 'brief_confirmed')
  let reviewCalls = 0
  const { result } = await runWorkflowScript(WRITE_SCRIPT, { title: '审稿修复任务' }, {
    '大纲生成': async () => ({ outline_md: OUTLINE_MD }),
    '正文生成': async () => ({ article_md: ARTICLE_MD }),
    审稿: async () => {
      reviewCalls++
      if (reviewCalls === 1) {
        const dims = DIMS_CLEAR.map((d) => ({ ...d }))
        dims[3] = { 维度: '论据充分性', blocking: true, 意见: '第二个场景缺少例子' }
        return { dimensions: dims, summary: '有一处 blocking' }
      }
      return { dimensions: DIMS_CLEAR, summary: '修复后通过' }
    },
    '修复循环': async () => ({ article_md: ARTICLE_MD + '\n\n补充例子：每晚自动汇总当日灵感。' }),
    播报: async () => ({ message: '已修复完成' }),
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.review.fixRounds, 1)
  assert.equal(result.review.blocking, 0)
  assert.equal(reviewCalls, 2)
  const article = fs.readFileSync(path.join(fx.dir, '5-article.md'), 'utf-8')
  assert.ok(article.includes('补充例子'), '修复后正文应落盘')
  const reviewMd = fs.readFileSync(path.join(fx.dir, '6-review.md'), 'utf-8')
  assert.ok(reviewMd.includes('修复 1 轮'), '审稿报告应记录修复轮次')
})

test('write 修改文章: Brief 修订后全链重生成, branch=modify_regenerated (T10)', async (t) => {
  const fx = await buildFixture(t, '待修改任务', 'draft_ready', {
    '4-outline.md': OUTLINE_MD,
    '5-article.md': ARTICLE_MD,
    '6-review.md': '# 审稿报告\n\n全部通过。\n',
  })
  const { result } = await runWorkflowScript(WRITE_SCRIPT, { title: '待修改任务', message: '修改文章: 结尾再口语化一点' }, {
    'Brief 修订': async () => ({ brief_md: BRIEF_MD + '\n用户修改意见: 结尾再口语化一点\n' }),
    '大纲生成': async () => ({ outline_md: OUTLINE_MD + '\n## 四、口语化结尾\n' }),
    '正文生成': async () => ({ article_md: ARTICLE_MD + '\n\n（口语化结尾）' }),
    审稿: async () => ({ dimensions: DIMS_CLEAR, summary: '通过' }),
    播报: async () => ({ message: '已按意见重写' }),
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.branch, 'modify_regenerated')
  assert.equal(result.status, 'draft_ready')
  const brief = fs.readFileSync(path.join(fx.dir, '3-brief.md'), 'utf-8')
  assert.ok(brief.includes('用户修改意见'), 'Brief 应含修改意见记录')
  const article = fs.readFileSync(path.join(fx.dir, '5-article.md'), 'utf-8')
  assert.ok(article.includes('口语化结尾'))
})

test('write 断点续写: reviewing+已有正文→跳过正文直接审稿, branch=resume_review (T11)', async (t) => {
  const fx = await buildFixture(t, '断点续写任务', 'reviewing', {
    '4-outline.md': OUTLINE_MD,
    '5-article.md': ARTICLE_MD,
  })
  const { result, counts } = await runWorkflowScript(WRITE_SCRIPT, { title: '断点续写任务' }, {
    审稿: async () => ({ dimensions: DIMS_CLEAR, summary: '通过' }),
    播报: async () => ({ message: '续写完成' }),
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.branch, 'resume_review')
  assert.equal((counts.get('正文生成') ?? 0), 0, '断点续写不应重新生成正文')
  assert.equal((counts.get('大纲生成') ?? 0), 0, '断点续写不应重新生成大纲')
  assert.equal(result.status, 'draft_ready')
})

test('write not_ready: waiting_topic_confirmation 引导先选方向 (T02 出口)', async (t) => {
  await buildFixture(t, '未确认方向任务', 'waiting_topic_confirmation', { '2-topic.md': '# 选题卡\n' })
  const { result } = await runWorkflowScript(WRITE_SCRIPT, { title: '未确认方向任务' }, {
    播报: async () => ({ message: 'x' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not_ready')
})

test('write already_done: draft_ready 无修改意见→引导交接 (T10 边界)', async (t) => {
  await buildFixture(t, '已完成任务', 'draft_ready', {
    '4-outline.md': OUTLINE_MD,
    '5-article.md': ARTICLE_MD,
    '6-review.md': '# 审稿报告\n',
  })
  const { result } = await runWorkflowScript(WRITE_SCRIPT, { title: '已完成任务' }, {
    播报: async () => ({ message: 'x' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'already_done')
})

test('status 列表模式: 无 title→任务清单+下一步提示 (T17)', async (t) => {
  const fxA = await buildFixture(t, '列表任务甲', 'brief_confirmed')
  await buildFixture(t, '列表任务乙', 'waiting_topic_confirmation', undefined, fxA)
  const { result } = await runWorkflowScript(STATUS_SCRIPT, {}, {
    播报: async () => ({ message: '两个任务' }),
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.mode, 'list')
  const titles = result.tasks.map((x: { title: string }) => x.title)
  assert.ok(titles.includes('列表任务甲'))
  assert.ok(titles.includes('列表任务乙'))
})

test('status 详情模式: title→文件清单+最近讨论 (T17)', async (t) => {
  const fx = await buildFixture(t, '详情任务', 'draft_ready', {
    '4-outline.md': OUTLINE_MD,
    '5-article.md': ARTICLE_MD,
    '6-review.md': '# 审稿报告\n',
  })
  await py(fx.vault, ['append', '--dir', fx.dir, '--file', 'messages.jsonl', '--role', 'user', '--turn', '1', '--content-b64', b64('继续写')])
  await py(fx.vault, ['append', '--dir', fx.dir, '--file', 'messages.jsonl', '--role', 'assistant', '--turn', '1', '--content-b64', b64('已完成正文')])
  const { result } = await runWorkflowScript(STATUS_SCRIPT, { title: '详情任务' }, {
    播报: async () => ({ message: '详情如下' }),
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.mode, 'detail')
  assert.equal(result.task.status, 'draft_ready')
  const files = result.task.files.map((x: { file: string }) => x.file)
  for (const f of ['1-idea.md', '2-topic.md', '3-brief.md', '4-outline.md', '5-article.md', '6-review.md']) {
    assert.ok(files.includes(f), '详情应含 ' + f)
  }
  assert.ok(result.task.recentMessages.length >= 2)
})

test('status not_found/ambiguous 引导', async (t) => {
  const r1 = await runWorkflowScript(STATUS_SCRIPT, { title: '不存在的任务' }, {})
  assert.equal(r1.result.ok, false)
  assert.equal(r1.result.code, 'not_found')

  const fxA = await buildFixture(t, '歧义任务一号', 'brief_confirmed')
  await buildFixture(t, '歧义任务二号', 'brief_confirmed', undefined, fxA)
  const r2 = await runWorkflowScript(STATUS_SCRIPT, { title: '歧义任务' }, {})
  assert.equal(r2.result.ok, false)
  assert.equal(r2.result.code, 'ambiguous')
  assert.equal(r2.result.candidates.length, 2)
})
