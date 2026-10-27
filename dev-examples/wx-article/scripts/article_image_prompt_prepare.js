export const meta = {
  name: 'article_image_prompt_prepare',
  description: '生图提示词设计计划(P0-B T4+T9): 读文章+视觉规则 -> agent 规划图位与画面设计(仅语义,不产 id/filename) -> 确定性稳定 ID 分级匹配继承(V2.1 第七节: heading 精确相等 > 无歧义顺序辅助 > 歧义即冲突报告人工确认) -> 落盘 image-design-plan.json 并过 validate-plan.mjs schema 闸。零付费。',
}

// 输入 args:
//   article_dir      : 文章目录绝对路径(必填)
//   article_md       : 文章正文 md 路径(可选; 缺省在 article_dir 下探测,排除已知辅助名;多候选则 FAIL 列出)
//   visual_profile   : 栏目 id(可选; 优先级 文章 front matter > 本参数; 都无则 FAIL)
//   resolve_new      : true 时歧义条目自动新建 id(默认 false: 歧义 FAIL 输出冲突报告,人工确认后处理)
//   max_images       : 图位上限(默认 12,含 cover;防费用失控)
// 输出: { ok, article_dir, plan_path, profile, items, inherited, new_ids, conflicts }

const VALIDATE = 'dev-examples/wx-article/scripts/image_gen/validate-plan.mjs'
const STABLE_IDS = 'dev-examples/wx-article/scripts/image_gen/lib/stable-ids.mjs'
const VISUAL_DIR = 'dev-examples/wx-article/visual'

const AUX_MD_NAMES = new Set(['image-prompts.md', '配图建议.md', 'cover.md', 'README.md'])

// ---------- 1. 定位文章 md 与栏目 ----------
phase('定位输入')
const listDir = await command({
  executable: 'bash',
  args: ['-c', `ls -1 ${JSON.stringify(args.article_dir)}/*.md 2>/dev/null`],
  timeoutMs: 30000,
  label: 'list-article-md',
})
if (listDir.exitCode !== 0) throw new Error('列目录失败: ' + (listDir.stderr || listDir.stdout))

const allMd = String(listDir.stdout).split('\n').map((s) => s.trim()).filter(Boolean)
let articleMd = args.article_md ?? null
if (!articleMd) {
  const candidates = allMd.filter((p) => !AUX_MD_NAMES.has(p.split('/').pop()))
  if (candidates.length !== 1) {
    throw new Error('无法唯一定位文章正文 md, 请用 args.article_md 显式指定。候选: ' + (candidates.join(', ') || '(无)'))
  }
  articleMd = candidates[0]
}

const readMd = await command({
  executable: 'bash',
  args: ['-c', `cat ${JSON.stringify(articleMd)}`],
  timeoutMs: 30000,
  label: 'read-article-md',
})
if (readMd.exitCode !== 0) throw new Error('读文章失败: ' + (readMd.stderr || readMd.stdout))
const articleText = String(readMd.stdout)

// front matter visual_profile(仅在文首 --- 块内识别) > args > 账号规则默认声明(default-profile) > FAIL
let profile = args.visual_profile ?? null
const fm = articleText.match(/^---\r?\n([\s\S]*?)\r?\n---/)
if (!profile && fm) {
  const m = fm[1].match(/^visual_profile:\s*(.+)$/m)
  if (m) profile = m[1].trim()
}
if (!profile) {
  const defRun = await command({
    executable: 'bash',
    args: ['-c', `grep -oP '^>\\s*default-profile:\\s*\\K.*$' ${JSON.stringify(VISUAL_DIR + '/visual-rules.md')} 2>/dev/null | head -1 | tr -d '\\r'`],
    timeoutMs: 30000,
    label: 'read-default-profile',
  })
  const def = String(defRun.stdout).trim()
  if (def) {
    profile = def
    console.log('[DEFAULT] visual_profile 未显式指定，使用账号默认: ' + def)
  }
}
if (!profile) throw new Error('visual_profile 未定(args/front matter/visual-rules.md default-profile 均未提供)。可选栏目见 ' + VISUAL_DIR + '/series/')

// 栏目规则必须存在(不存在说明 profile 写错)
const checkSeries = await command({
  executable: 'bash',
  args: ['-c', `test -f ${JSON.stringify(`${VISUAL_DIR}/series/${profile}.md`)} && echo ok`],
  timeoutMs: 30000,
  label: 'check-series-rule',
})
if (checkSeries.stdout.trim() !== 'ok') {
  throw new Error('栏目规则不存在: ' + `${VISUAL_DIR}/series/${profile}.md` + '（profile=' + profile + '）')
}

// ---------- 2. 读既有 plan(稳定 ID 继承依据) ----------
phase('读取既有计划')
const oldPlanPath = args.article_dir + '/image-design-plan.json'
const oldPlanRaw = await command({
  executable: 'bash',
  args: ['-c', `cat ${JSON.stringify(oldPlanPath)} 2>/dev/null || echo __MISSING__`],
  timeoutMs: 30000,
  label: 'read-old-plan',
})
const oldPlanText = String(oldPlanRaw.stdout).trim()
let oldItems = []
if (!oldPlanText.endsWith('__MISSING__')) {
  try {
    const old = JSON.parse(oldPlanText)
    oldItems = Array.isArray(old.items) ? old.items : []
  } catch {
    // 旧 plan 损坏: 视为无既有(全部新建),不阻塞
    oldItems = []
  }
}

// ---------- 3. agent 规划设计语义(不产 id/filename) ----------
phase('AI 规划图位')
const TYPE_GUIDE = [
  'cover: 封面,整篇至多一张,核心视觉主体+标题安全区,承担第一眼吸引力',
  'infographic: 信息图,表达流程/关系/对比/分层,概念必须来自文章事实(source_facts 逐条列出)',
  'data-chart: 数据图,呈现文章中的真实数据(禁止编造),数据必须逐条写入 source_facts;文章没有真实数据就不选此类型',
  'illustration: 插画,用人物/场景/隐喻表达抽象概念,一个画面一个隐喻',
].join('\n')
const oldContext = oldItems.length
  ? '既有设计计划条目(heading 为准,新计划必须覆盖仍存在的章节,已删除章节不要保留):\n' +
    oldItems.map((o) => `- [${o.type}] ${o.heading || '(封面)'}`).join('\n')
  : '无既有设计计划。'

const designed = await agent(
  '你是公众号文章的视觉设计规划师。阅读下面的文章,规划配图设计计划。\n\n' +
  '规则:\n' +
  '- 整篇必须恰好一个 type=cover 条目(heading 填空字符串 "")\n' +
  '- 正文图按章节内容选择合适类型,不同章节可用不同类型(文章类型与图片类型是独立维度)\n' +
  '- infographic 与 data-chart 的 source_facts 必须逐条列出图中要呈现的事实(取自文章,不得编造)\n' +
  '- illustration 的 concept 中明确描述角色特征(体型/服装/主色调),保证同篇角色一致\n' +
  '- aspect_ratio: cover 用 2.35:1,正文图用 16:9\n' +
  '- 总图位数不超过 ' + String(args.max_images ?? 12) + ' 张\n' +
  '- 不要输出 id 与 filename(由下游确定性分配)\n\n' +
  '图片类型说明:\n' + TYPE_GUIDE + '\n\n' + oldContext + '\n\n文章全文:\n"""\n' + articleText.slice(0, 60000) + '\n"""',
  { label: 'plan-image-design', schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'heading', 'concept', 'layout', 'aspect_ratio', 'source_facts'],
          properties: {
            type: { enum: ['cover', 'infographic', 'data-chart', 'illustration'] },
            heading: { type: 'string' },
            concept: { type: 'string' },
            layout: { type: 'string' },
            aspect_ratio: { type: 'string' },
            source_facts: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  } },
)
if (!designed || !Array.isArray(designed.items) || designed.items.length === 0) {
  throw new Error('agent 未产出有效设计条目')
}
if (designed.items.length > (args.max_images ?? 12)) {
  throw new Error('设计条目数 ' + designed.items.length + ' 超过上限 ' + String(args.max_images ?? 12))
}
const coverCount = designed.items.filter((x) => x.type === 'cover').length
if (coverCount !== 1) throw new Error('cover 条目必须恰好一个,收到 ' + coverCount)

// ---------- 4. 稳定 ID 分级匹配（V2.1 第七节，逻辑在 lib/stable-ids.mjs，可独立测试） ----------
phase('稳定 ID 匹配')
const designedPath = args.article_dir + '/image-design-designed.tmp.json'
const writeDesigned = await command({
  executable: 'bash',
  args: ['-c', `cat > ${JSON.stringify(designedPath)} <<'D_EOF'\n${JSON.stringify({ items: designed.items })}\nD_EOF\n`],



  timeoutMs: 30000,
  label: 'write-designed-tmp',
})
if (writeDesigned.exitCode !== 0) throw new Error('写设计语义临时文件失败: ' + (writeDesigned.stderr || writeDesigned.stdout))

const matchArgs = ['--new', designedPath]
if (oldItems.length > 0) matchArgs.push('--old', oldPlanPath)
if (args.resolve_new === true) matchArgs.push('--resolve-new')
const matchRun = await command({
  executable: 'node',
  args: [STABLE_IDS, ...matchArgs],
  timeoutMs: 60000,
  label: 'stable-ids-match',
})
const matchOut = String(matchRun.stdout)
if (matchRun.exitCode === 3 || matchOut.startsWith('[CONFLICT]')) {
  throw new Error(
    '[CONFLICT] 存在歧义条目,不自动继承(V2.1 原则: 宁可重新分配 ID,不错误继承已付费图片)。' +
    '人工确认后: 修改文章 heading 或编辑 image-design-plan.json,或传 resolve_new=true 强制新建。明细: ' + matchOut.trim(),
  )
}
if (matchRun.exitCode !== 0) throw new Error('稳定 ID 匹配失败: ' + (matchOut.trim() || matchRun.stderr))
const matchLine = matchOut.split('\n').find((l) => l.startsWith('[MATCH] '))


if (!matchLine) throw new Error('匹配器输出缺少 [MATCH] 行: ' + matchOut.slice(0, 500))
const matched = JSON.parse(matchLine.slice('[MATCH] '.length))
const finalItems = matched.items
let inherited = matched.inherited
const newIds = []

const sourceArticleHash = await command({
  executable: 'bash',
  args: ['-c', `sha256sum ${JSON.stringify(articleMd)} | cut -d' ' -f1`],
  timeoutMs: 30000,
  label: 'hash-article-md',
})
if (sourceArticleHash.exitCode !== 0) throw new Error('文章哈希失败: ' + (sourceArticleHash.stderr || ''))

// ---------- 5. 落盘 + schema 闸 ----------
phase('落盘校验')
const plan = {
  version: 1,
  article_id: args.article_dir.split('/').filter(Boolean).pop(),
  visual_profile: profile,
  source_article_hash: String(sourceArticleHash.stdout).trim(),
  items: finalItems,
}
const planPath = oldPlanPath
const planTmp = planPath + '.tmp'
const writePlan = await command({
  executable: 'bash',
  args: ['-c', `cat > ${JSON.stringify(planTmp)} <<'PLAN_EOF'\n${JSON.stringify(plan, null, 2)}\nPLAN_EOF\n`],
  timeoutMs: 30000,
  label: 'write-plan-tmp',
})
if (writePlan.exitCode !== 0) throw new Error('写临时计划失败: ' + (writePlan.stderr || writePlan.stdout))

const gate = await command({
  executable: 'node',
  args: [VALIDATE, planTmp],
  timeoutMs: 60000,
  label: 'validate-plan-gate',
})
if (gate.exitCode !== 0) {
  throw new Error('设计计划未过 schema 闸(exit ' + gate.exitCode + '): ' + (String(gate.stdout).trim() || gate.stderr))
}
const rename = await command({
  executable: 'bash',
  args: ['-c', `mv ${JSON.stringify(planTmp)} ${JSON.stringify(planPath)} && echo ok`],
  timeoutMs: 30000,
  label: 'promote-plan',
})
if (rename.stdout.trim() !== 'ok') throw new Error('计划生效失败: ' + (rename.stderr || rename.stdout))

console.log('[PLAN] ' + JSON.stringify({ items: finalItems.length, inherited, conflicts: conflicts.length }))
return {
  ok: true,
  article_dir: args.article_dir,
  plan_path: planPath,
  profile,
  items: finalItems,
  inherited,
  new_ids: newIds,
  conflicts,
}
