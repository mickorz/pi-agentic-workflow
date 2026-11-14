export const meta = {
  name: 'wechat_sticker_cards',
  description: '小绿书卡片化：文章/截图/笔记 -> pages.json 页面规划 -> 版式卡片渲染与 AI 生图 -> 规范化与人工审图 -> 两阶段发布授权 -> 发布小绿书(newspic 入草稿箱)。方案: dev-docs/planning/2026-11-05-小绿书卡片化接入执行方案.md(V1.1)',
}

// 术语(2026-11 定案)：贴图=小绿书。
// 架构约束(T6 定案)：Agent 只负责页面规划/内容交互/审图；所有 Python/渲染脚本为确定性执行节点。
// 独立授权：仅发布授权不受 skip_confirm 影响(P0-5)；AI 生图付费授权已取消(2026-11-12，image-use 唯一通道订阅内消耗)
// 状态机(P0-6)：cards_status ∈ PLANNING|GENERATING|READY|RENDER_BLOCKED|REVIEW_REJECTED|FAILED
//              publish_status ∈ NOT_STARTED|SKIPPED|DRAFTED|UNKNOWN|FAILED|LOCKED
// 断点续跑：pages.json/aigen-state.json/publish-state.json 落盘，重跑跳过已完成步骤。

const SC = 'dev-examples/wx-article/scripts/sticker_cards'
const SKILL_GZ = 'thirdparties/guizang-social-card-skill'
const RENDER_MJS = SKILL_GZ + '/scripts/render.mjs'

// 跨平台 python 探测 + spawnSync 参数数组直传（不经 shell）
const RUNNER_SRC = [
  "const { spawnSync } = require('child_process');",
  "let py = null;",
  "for (const c of ['python3', 'python', 'py']) {",
  "  const pr = spawnSync(c, ['-c', 'import sys'], { encoding: 'utf8' });",
  "  if (pr.status === 0) { py = c; break; }",
  "}",
  "if (!py) { console.error('[FAIL] no usable python on PATH'); process.exit(49); }",
  "const a = process.argv.slice(1);",
  "const r = spawnSync(py, [a[0]].concat(a.slice(1)), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });",
  "process.stdout.write((r.stdout || '') + (r.stderr || ''));",
  "process.exit(r.status);",  // 透传原码（UNKNOWN=2 等语义由上层区分）
].join('\n')

async function runPy(scriptPath, pyArgs, label, timeoutMs = 180000) {
  const r = await command({
    executable: 'node',
    args: ['-e', RUNNER_SRC, scriptPath].concat(pyArgs),
    timeoutMs, label: label || 'python:' + scriptPath.split('/').pop(),
  })
  return { ok: r.exitCode === 0, output: r.stdout, exitCode: r.exitCode }
}

async function fileExists(p) {
  const r = await command({
    executable: 'node',
    args: ['-e', "process.exit(require('fs').existsSync(process.argv[1]) ? 0 : 1)", p],
    timeoutMs: 15000, label: 'exists:' + p,
  })
  return r.exitCode === 0
}

const CARD = (args.article_dir || '.') + '/_cards'
const pagesPath = CARD + '/pages.json'
const mockArgs = []
if (args.mock) mockArgs.push('--mock')
if (args.mock_store) mockArgs.push('--mock-store', args.mock_store)
if (args.inject) mockArgs.push('--inject', args.inject)

let cards_status = 'PLANNING'
let publish_status = 'NOT_STARTED'
const artifacts = {
  pages: pagesPath, manifest: CARD + '/cards-manifest.json',
  output: CARD + '/output/', prompts: CARD + '/prompts/',
  state: CARD + '/aigen-state.json',
}

// ---------- Stage 1: 页面规划（Agent 唯一内容产出点） ----------
phase('页面规划')
if (!args.article_dir) {
  return { cards_status: 'FAILED', publish_status, artifacts,
    report: '缺少 article_dir（文章目录）。小绿书卡片化需要文章目录存放 _cards/ 与产物。' }
}
// 守卫(2026-11-14)：article_dir 禁止位于本仓库内——仓库根 .aws-article 会截胡 publish.py 向上查找致凭据找不到，
// 且仓库内目录未 gitignore 会把素材混入 git；文章目录必须建在 vault E:/Obsidian/newsky/60_Workspace/ 下
// （踩坑：dev-docs/experience/xiaolvshu-article-dir-must-be-in-vault.md）
{
  const guard = await command({
    executable: 'node',
    args: ['-e', "const path=require('path');const a=path.resolve(process.argv[1]);const rel=path.relative(process.cwd(),a);const inRepo=rel && !rel.startsWith('..') && !path.isAbsolute(rel);const sandbox=rel.split(path.sep)[0]==='dev-examples';process.exit(inRepo && !sandbox ? 7 : 0)", args.article_dir],
    timeoutMs: 15000, label: 'guard:article-dir-not-in-repo',
  })
  if (guard.exitCode === 7) {
    return { cards_status: 'FAILED', publish_status, artifacts,
      report: 'article_dir 位于 pi-workflow 仓库内（' + args.article_dir + '）。文章目录必须建在 vault E:/Obsidian/newsky/60_Workspace/写作/单篇/ 下，禁止建在仓库内；详见 dev-docs/experience/xiaolvshu-article-dir-must-be-in-vault.md。' }
  }
}
const pagesExists = await fileExists(pagesPath)
if (pagesExists) {
  log('检测到既有 pages.json，跳过规划（断点续跑）')
} else {
  await agent(
    '你是小绿书页面规划师。基于素材产出页面规划文件（用 Write 工具写）：' + pagesPath + '\n\n' +
    '素材：\n' +
    (args.source_text ? '- 文本素材：' + args.source_text + '\n' : '') +
    (args.shots_dir ? '- 截图目录：' + args.shots_dir + '（列出其中图片，作为截图证据页素材，并把图片复制到 ' + CARD + '/assets/ 下）\n' : '') +
    '- 文章目录：' + args.article_dir + '（可读其中 md/笔记文件）\n' +
    '- 页数上限：' + (args.count || 6) + '（硬上限 9，含封面）\n' +
    '- 风格：' + (args.style_mode || 'editorial') + '\n\n' +
    '必读规范（相对仓库根）：\n' +
    '1. dev-examples/wx-article/scripts/sticker_cards/components.py —— 组件表与 schema v2（唯一事实来源）\n' +
    '2. ' + SKILL_GZ + '/references/content-planning.md —— 压缩阶梯/页角色/封面钩子\n' +
    '3. ' + SKILL_GZ + '/references/platform-specs.md —— 3:4 尺寸/封面结构\n\n' +
    '硬性要求：\n' +
    '- schema_version=2；page 1 必须 role=cover；页数 1~9；no 唯一递增\n' +
    '- source 仅 html|ai-image；html 页 layout 必须是组件表枚举：cover-hook/text-card/screenshot-with-caption/checklist/quote\n' +
    '- screenshot 页 asset 以 _cards/assets/ 开头且文件真实存在（把用户截图复制到 ' + CARD + '/assets/）\n' +
    '- ai-image 页必须写 prompt（画面语义+3:4 竖版+中文文字直写+统一色板）\n' +
    '- title <=20 字（微信小绿书后台标题上限，2026-11-10 实测）；content(配文) <=1000 字\n\n' +
    '写完后返回：页表摘要（页号/角色/layout/素材）。',
    { label: '页面规划', agentType: 'general' })
}
cards_status = 'PLANNING'
const vr = await runPy(SC + '/validate_pages.py',
  ['--pages', pagesPath, '--cards-root', args.article_dir], 'validate_pages')
if (!vr.ok) {
  return { cards_status: 'FAILED', publish_status, artifacts,
    report: 'pages.json 校验未通过:\n' + vr.output }
}
log('pages.json schema v2 校验通过')

if (!args.skip_confirm) {
  await checkpoint(
    '小绿书页面规划已完成并通过 schema 校验。\n页表：' + pagesPath + '\n' +
    '后续将进行：截图预处理 / AI 生图（按页计费）/ HTML 渲染。\n' +
    '允许=开始制作；拒绝=终止。')
}
cards_status = 'GENERATING'

// ---------- Stage 2: 素材准备 ----------
phase('截图预处理')
const prep = await runPy(SC + '/prep_screenshots.py',
  ['--assets-dir', CARD + '/assets', '--out', CARD + '/shots-report.json'], 'prep_screenshots')
log(prep.output.split('\n').filter(l => l.startsWith('[')).join('\n'))
if (prep.output.indexOf('需人工确认') !== -1) {
  if (!args.skip_confirm) {
    await checkpoint(
      '截图预处理发现需要人工确认的项（报告：' + CARD + '/shots-report.json）。\n' +
      '如需裁切请编辑 pages.json 对应页 crop 字段后重跑（断点续跑）。\n' +
      '允许=按当前页表继续；拒绝=终止（先修改）。')
  } else {
    log('[WARN] 截图存在需人工确认项（skip_confirm 跳过交互），详见 shots-report.json')
  }
}

phase('AI 生图（如页表含 ai-image 页）')
const genPlan = await runPy(SC + '/generate_ai_images.py',
  ['--pages', pagesPath, '--cards-dir', CARD, '--article-dir', args.article_dir,
   '--max-images', String(Math.min(args.count || 6, 9))], 'generate_plan(dry)')
if (genPlan.output.indexOf('无 ai-image 页面') !== -1) {
  log('无 ai-image 页，跳过生图')
} else {
  const m = genPlan.output.match(/张数=(\d+)/)
  const n = m ? parseInt(m[1], 10) : 0
  if (n > 0) {
    // 2026-11-12 定案：付费授权 checkpoint 取消——生图通道唯一 image-use（ChatGPT 订阅 web，
    // 零 API 计费，消耗订阅配额，无边际费用），订阅内使用不再需要逐次人工授权。
    log('[INFO] AI 生图 ' + n + ' 张，通道 image-use（chrome-use + ChatGPT 订阅 web，零 API 计费；唯一通道，无需授权门）')
    const gen = await runPy(SC + '/generate_ai_images.py',
      ['--pages', pagesPath, '--cards-dir', CARD, '--article-dir', args.article_dir,
       '--yes', '--max-images', String(Math.min(args.count || 6, 9))].concat(mockArgs),
      'generate_ai_images', 900000)
    log(gen.output.split('\n').filter(l => l.startsWith('[')).join('\n'))
    if (gen.exitCode === 2) {
      return { cards_status: 'GENERATING', publish_status: 'NOT_STARTED', artifacts,
        report: 'AI 生图存在 UNKNOWN（可能已扣费）。按 [HOLD] 提示人工核对/恢复后重跑（断点续跑），禁止自动重试。' }
    }
    if (gen.exitCode === 1) {
      return { cards_status: 'FAILED', publish_status: 'NOT_STARTED', artifacts,
        report: 'AI 生图明确失败（提示词已存档）。修复后重跑本工作流可断点续跑。' }
    }
  }
}

phase('HTML 构建（如页表含 html 页）')
const build = await runPy(SC + '/build_html.py',
  ['--pages', pagesPath, '--out', CARD + '/index.html', '--cards-root', args.article_dir], 'build_html')
if (!build.ok) {
  return { cards_status: 'FAILED', publish_status, artifacts,
    report: 'HTML 构建失败（Agent 零 HTML，注入器确定性构建）:\n' + build.output }
}
log('index.html 构建完成')

// ---------- Stage 3: 渲染与规范化 ----------
phase('渲染')
// 生产先试字体内嵌（离线高保真）；失败降级 --no-embed 在线字体重试
let render = await command({
  executable: 'node',
  args: [RENDER_MJS, CARD + '/index.html', '--out', CARD + '/render'],
  timeoutMs: 300000, label: 'render.mjs(嵌入字体)',
})
if (render.exitCode !== 0) {
  log('字体内嵌渲染失败，降级 --no-embed 在线字体重试')
  render = await command({
    executable: 'node',
    args: [RENDER_MJS, CARD + '/index.html', '--no-embed', '--out', CARD + '/render'],
    timeoutMs: 300000, label: 'render.mjs(no-embed)',
  })
}
if (render.exitCode !== 0) {
  const envMissing = (render.stderr || '').indexOf('Cannot find module') !== -1
    || (render.stderr || '').indexOf('Executable doesn') !== -1
  if (envMissing) {
    return { cards_status: 'RENDER_BLOCKED', publish_status, artifacts,
      report: '渲染环境未就绪（' + SKILL_GZ + ' 需 npm install；chromium 需 npx playwright install）。'
        + '已交付 ' + CARD + '/index.html，环境就绪后重跑本工作流（断点续跑）。' }
  }
  return { cards_status: 'RENDER_BLOCKED', publish_status, artifacts,
    report: '渲染失败:\n' + render.stdout.slice(-400) + (render.stderr || '').slice(-300) }
}
log('渲染完成: ' + (render.stdout.match(/xhs-\d+\.png/g) || []).join(','))

const norm = await runPy(SC + '/normalize_cards.py',
  ['--pages', pagesPath, '--cards-dir', CARD], 'normalize_cards')
if (!norm.ok) {
  return { cards_status: 'FAILED', publish_status, artifacts,
    report: '规范化失败（旧产物已失效保护）:\n' + norm.output }
}
const ver = await runPy(SC + '/verify_cards.py',
  ['--pages', pagesPath, '--cards-dir', CARD], 'verify_cards')
if (!ver.ok) {
  return { cards_status: 'FAILED', publish_status, artifacts,
    report: '序列验收未通过:\n' + ver.output }
}
log('规范化与序列验收通过')

// ---------- Stage 4: 人工审图（Agent 审 + 结构化记录） ----------
phase('人工审图')
const review = await agent(
  '你是小绿书审图员。逐页查看图片（读图工具读取 ' + args.article_dir + '/_cards/output/ 下 01.png 起的每一张）并审核。\n' +
  '审图清单：' + CARD + '/review-checklist.md\n' +
  '页表语义：' + pagesPath + '\n\n' +
  '分类型标准：\n' +
  '- screenshot 页：文字清晰、裁切正确（无地址栏/无关区域）、关键代码/数据完整\n' +
  '- ai-image 页：构图合理、与全组风格一致、事实准确、图中无错误文字\n' +
  '- layout-text 页：排版无溢出无重叠、层级清晰、留白得当\n' +
  '通用：首图封面缩略可辨、图序连贯、风格统一、中文无缺字。\n\n' +
  '输出要求：每页一行，格式固定为「页<页号>: <APPROVED|REJECTED|REVISION_REQUIRED> — <意见>」，最后给整组总结。',
  { label: '审图', agentType: 'general' })
log(String(review).slice(0, 600))
const verdicts = {}
String(review).split('\n').forEach(ln => {
  const m = ln.match(/页\s*(\d{1,2})\s*[:：]\s*(APPROVED|REJECTED|REVISION_REQUIRED)/i)
  if (m) verdicts[parseInt(m[1], 10)] = m[2].toUpperCase()
})
// 逐页页号列表（确定性：由 pages.json 读取，顺序即发布顺序）
const reviewPages = await command({
  executable: 'node',
  args: ['-e', "const p=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(p.pages.map(x=>x.no).join(','))", pagesPath],
  timeoutMs: 15000, label: 'pagesOrder',
})
let rejected = []
for (const p of (reviewPages.stdout.trim().split(',').map(x => parseInt(x, 10)))) {
  const v = verdicts[p]
  if (!v) { rejected.push(p); continue }
  const mr = await runPy(SC + '/mark_review.py',
    ['--manifest', CARD + '/cards-manifest.json', '--no', String(p),
     '--status', v, '--reviewer', 'ai-reviewer',
     '--notes', (String(review).match(new RegExp('页\\s*' + p + '\\s*[:：][^\\n]*')) || [''])[0].slice(0, 200)],
    'mark_review:' + p)
  if (v !== 'APPROVED') rejected.push(p)
}
const finalVerify = await runPy(SC + '/verify_cards.py',
  ['--pages', pagesPath, '--cards-dir', CARD, '--require-approved'], 'verify(require-approved)')
if (!finalVerify.ok || rejected.length) {
  return { cards_status: 'REVIEW_REJECTED', publish_status: 'NOT_STARTED', artifacts,
    report: '审图未全部通过（页: ' + rejected.join(',') + '）。按修改意见调整后重跑（断点续跑，已审页保留）。' }
}
cards_status = 'READY'
log('全部页面 APPROVED')

// ---------- Stage 5/6: 独立发布授权 + 发布 ----------
if (args.publish_method === 'none') {
  publish_status = 'SKIPPED'
  log('publish_method=none，只制作不发布')
  return { cards_status, publish_status, artifacts,
    report: '小绿书卡片制作完成（未发布）。产物：' + CARD + '/output/', review: String(review).slice(0, 400) }
}
phase('发布授权（独立 checkpoint，skip_confirm 不影响）')
const prepPub = await runPy(SC + '/publish_sticker_cards.py',
  ['--pages', pagesPath, '--cards-dir', CARD,
   '--account-slot', String(args.account_slot || 1), '--prepare']
    .concat(args.title ? ['--title', args.title] : [])
    .concat(args.content ? ['--content', args.content] : []), 'publish_prepare')
if (!prepPub.ok) {
  return { cards_status: 'READY', publish_status: 'NOT_STARTED', artifacts,
    report: '发布资格未通过（Gate 1）:\n' + prepPub.output }
}
const fp = (prepPub.output.match(/发布授权指纹: ([0-9a-f]{64})/) || [])[1] || ''
if (!fp) {
  return { cards_status: 'READY', publish_status: 'NOT_STARTED', artifacts,
    report: '未取得发布授权指纹:\n' + prepPub.output }
}
await checkpoint(
  '发布授权（独立 checkpoint，本步不可被 skip_confirm 跳过）：\n' +
  prepPub.output.split('\n').filter(l => l.startsWith('[') || l.startsWith('     ')).join('\n') + '\n\n' +
  '授权指纹：' + fp + '\n' +
  '确认后以该指纹执行发布（内容任一变化授权自动作废）。允许=发布到草稿箱；拒绝=只保留卡片。')

publish_status = 'PENDING_APPROVAL'
const pub = await runPy(SC + '/publish_sticker_cards.py',
  ['--pages', pagesPath, '--cards-dir', CARD,
   '--account-slot', String(args.account_slot || 1),
   '--execute', '--approval', fp]
    .concat(args.title ? ['--title', args.title] : [])
    .concat(args.content ? ['--content', args.content] : [])
    .concat(mockArgs), 'publish_execute', 600000)
publish_status = pub.exitCode === 0 ? 'DRAFTED'
  : pub.exitCode === 2 ? 'UNKNOWN' : pub.exitCode === 3 ? 'LOCKED' : 'FAILED'
if (publish_status === 'DRAFTED') {
  const m = pub.output.match(/draft_media_id=(\S+)/)
  log('发布小绿书成功: ' + (m ? m[1] : '') + '（请到公众号后台草稿箱手动发表）')
} else if (publish_status === 'UNKNOWN') {
  log('发布 UNKNOWN：publish.py 已进入 pending 保护。人工核对草稿箱后用 '
    + '--clear-pending（未产生草稿）或 --resolve-media-id <id>（已产生）恢复，再重跑 --execute 同指纹')
} else {
  log('发布未成功: ' + publish_status + '（卡片已就绪，修复后重跑断点续跑）')
}

return {
  cards_status,
  publish_status,
  artifacts,
  report: '小绿书卡片化完成。cards_status=' + cards_status + ' publish_status=' + publish_status,
  review: String(review).slice(0, 400),
}
