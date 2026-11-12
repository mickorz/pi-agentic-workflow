export const meta = {
  name: 'market_analysis',
  description: '微信触发市场分析：「市场分析: <主题>」→ 三渠道采集(小红书/公众号/抖音 chrome-use) → 报告落 Obsidian 市场分析/ → MA 编号回执。研究 READY 不代表方向确认，回复「确认 MA-xxx 方向N」生效。',
  phases: [
    { title: '参数与幂等' },
    { title: '三渠道采集' },
    { title: '报告落盘' },
    { title: '回执' },
  ],
}

// market_analysis.js —— 微信触发市场分析工作流（T1 最小真实链路，2026-11-12）
// 设计：dev-docs/design/2026-11-12-微信触发市场分析流程可行性方案.md（V2 评审修订版）
// 触发：确定性前缀「市场分析: <主题>」/「选题分析: <主题>」（prefix-router，不经 LLM）
// VM 沙箱零 import：全部 fs 操作走 market_analysis_store.py（archive_inspire 同款模式）
// 输入 args: topic(必填，前缀路由注入) / limit(3-10，缺省 5)
// 输出: { ok, analysisId, topic, coverage, report_rel, receipt, samples }

const PY = 'python3'
const STORE = 'dev-examples/wx-article/scripts/market_analysis_store.py'
const COLLECTORS = 'dev-examples/content-intelligence/collectors'

async function runJson(label, executable, argv, timeoutMs) {
  const r = await command({ executable, args: argv, label, ...(timeoutMs ? { timeoutMs } : {}) })
  const outText = (r.stdout || '').splitlines ? r.stdout : String(r.stdout || '')
  const lines = outText.split('\n').filter(l => l.trim().startsWith('{'))
  if (r.exitCode !== 0 || lines.length === 0) {
    throw new Error(label + '失败(退出码 ' + r.exitCode + '): ' + String(r.stderr || r.stdout || '').slice(0, 300))
  }
  try {
    return JSON.parse(lines[lines.length - 1])
  } catch (e) {
    throw new Error(label + '输出非 JSON: ' + lines[lines.length - 1].slice(0, 200))
  }
}

// ── ① 参数与幂等 ──
phase('参数与幂等')
const topic = String(args.topic || '').trim().slice(0, 60)
if (!topic) throw new Error('args.topic 为空（前缀路由应保证非空）')
const limit = Math.min(Math.max(Number(args.limit) || 5, 3), 10)
const topicKey = topic.replace(/\s+/g, '')

const probe = await runJson('环境探测 ', PY, [STORE, 'probe'], 30_000)
const today = probe.today

const idem = await runJson('幂等检查 ', PY, [STORE, 'idem-check', '--topic-key', topicKey, '--today', today], 30_000)
if (idem.exists) {
  phase('回执')
  return {
    ok: true, idempotent: true, topic, analysisId: idem.analysisId,
    report_rel: idem.report_rel,
    receipt: '已分析过: ' + topic + '（' + idem.analysisId + '，重发不重复处理；重跑请回复「重跑 ' + idem.analysisId + '」）',
  }
}

const begin = await runJson('登记研究 ', PY, [STORE, 'begin', '--topic', topic, '--topic-key', topicKey, '--today', today], 30_000)
const analysisId = begin.analysisId
log('研究编号：' + analysisId)

// ── ② 三渠道采集（单渠道失败跳过并标注，V2 降级矩阵）──
phase('三渠道采集')
const coverage = {}
const samplesAll = []
async function collect(name, script, argv) {
  try {
    const j = await runJson(name + '采集 ', PY, [COLLECTORS + '/' + script, ...argv], 5 * 60 * 1000)
    const arr = j.samples || (j.note ? [j.note] : j.video ? [j.video] : [])
    coverage[name] = { ok: true, count: arr.length }
    for (const s of arr) samplesAll.push({ ...s, channel: name })
    log(name + '：' + arr.length + ' 条')
  } catch (e) {
    coverage[name] = { ok: false, error: String(e.message || e).slice(0, 120) }
    log(name + ' 失败（跳过）：' + coverage[name].error)
  }
}
await collect('小红书', 'xhs_collect.py', ['search', topic, '--limit', String(limit)])
await collect('公众号', 'mp_collect.py', ['search', topic, '--limit', String(limit)])
await collect('抖音', 'dy_collect.py', ['search', topic, '--limit', String(limit)])

const okChannels = Object.values(coverage).filter(v => v.ok).length
if (okChannels === 0 || samplesAll.length < 3) {
  await runJson('置失败态 ', PY, [STORE, 'fail', '--analysis-id', analysisId, '--coverage', JSON.stringify(coverage)], 30_000)
  throw new Error('三渠道采集全部失败或样本不足（' + samplesAll.length + ' 条）：' + JSON.stringify(coverage).slice(0, 200))
}
const partial = okChannels < 3

// ── ③ 报告落盘（骨架：样本真实；分析段 T3 填充）──
phase('报告落盘')
const rep = await runJson('报告落盘 ', PY, [
  STORE, 'report', '--analysis-id', analysisId, '--topic', topic, '--topic-key', topicKey, '--today', today,
  '--coverage', JSON.stringify(coverage), '--partial', partial ? '1' : '0',
  '--samples-json', JSON.stringify(samplesAll),
], 60_000)

// ── ④ 回执（V2 模板：编号+覆盖+状态+确认指令）──
phase('回执')
const covLine = Object.entries(coverage).map(([k, v]) => k + ' ' + (v.ok ? v.count : '未采')).join(' / ')
return {
  ok: true, analysisId, topic, coverage,
  report_rel: rep.report_rel,
  receipt:
    '市场分析报告已生成\n' +
    '主题: ' + topic + '\n' +
    '研究编号: ' + analysisId + '\n' +
    '样本: ' + samplesAll.length + ' 条｜' + covLine + (partial ? '（部分覆盖）' : '') + '\n' +
    '状态: 研究待确认（分析段完善中，方向候选见报告）\n' +
    '报告: ' + rep.report_rel,
  samples: samplesAll.length,
}
