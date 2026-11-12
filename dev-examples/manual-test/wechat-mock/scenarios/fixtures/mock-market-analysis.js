export const meta = {
  name: 'mock_market_analysis',
  description: 'WX-MOCK fixture：市场分析 store 链路（probe/idem/begin/report/fail/state/confirm）确定性回归，fixture vault 隔离，零 LLM 零浏览器',
  phases: [{ title: '准备' }, { title: '执行' }],
}
// args: { topic: string }  模式由 topic 关键词驱动：
//   含"部分"→partial / 含"不足"→starve / 含"越界"→escape / 含"确认"→confirm / 其余→ok（幂等用同 topic 重发）
// 产物：outFile = 每步 store stdout 摘要，供场景断言
const STORE = 'dev-examples/wx-article/scripts/market_analysis_store.py'
const root = String(args.root)
const outFile = String(args.outFile)
const topic = String(args.topic || 'mock主题')

phase('准备')
await command({
  executable: 'node',
  args: ['-e', `
const fs = require('fs'), path = require('path');
const root = process.argv[1];
fs.mkdirSync(path.join(root, 'vault', '60_Workspace/写作/市场分析'), { recursive: true });
fs.mkdirSync(path.join(root, '.aws-article'), { recursive: true });
fs.writeFileSync(path.join(root, '.aws-article', 'config.json'), JSON.stringify({ vault_root: path.join(root, 'vault') }));
console.log('fixture vault ready');
`, root],
})

phase('执行')
const REPO_R = await command({ executable: 'node', args: ['-e', 'process.stdout.write(process.cwd())'] })
const STORE_ABS = String((REPO_R.stdout || '').trim()) + '/' + STORE
const py = (sub, extra) => command({ executable: 'python3', args: [STORE_ABS, sub, ...extra], cwd: root, timeoutMs: 30_000 })
const results = []
const lastJson = (r) => { const line = ((r.stdout || '') + '\n' + (r.stderr || '')).split('\n').filter(l => l.trim().startsWith('{')).pop(); return line ? line : 'NO_JSON:' + JSON.stringify({ exit: r.exitCode, out: (r.stdout || '').slice(0, 80), err: (r.stderr || '').slice(0, 600) }) }
const safeParse = async (label, r) => { const line = lastJson(r); try { return JSON.parse(line) } catch (e) {
  try { await command({ executable: 'node', args: ['-e', "require('fs').writeFileSync(process.argv[1], process.argv[2])", outFile, label + ' :: ' + line.slice(0, 800)] }) } catch (e2) {}
  throw new Error(label + ' 解析失败(详见 outFile)') } }
const push = (label, r) => results.push(label + ' :: ' + ((r.stdout || r.stderr || '')).split('\n').filter(l => l.trim().startsWith('{')).pop() || 'exit=' + r.exitCode)
const mode = topic.includes('部分') ? 'partial' : topic.includes('不足') ? 'starve' : topic.includes('越界') ? 'escape' : topic.includes('确认') ? 'confirm' : 'ok'

const probe = await py('probe', [])
results.push('probe raw: ' + lastJson(probe).slice(0, 100))
const today = (await safeParse('probe', probe)).today
const topicKey = topic.replace(/\s+/g, '')

const idem = await py('idem-check', ['--topic-key', topicKey, '--today', today])
results.push('idem raw: ' + lastJson(idem).slice(0, 100))
const idemJ = await safeParse('idem', idem)
if (idemJ.exists) {
  await command({ executable: 'node', args: ['-e', "require('fs').writeFileSync(process.argv[1], '已分析过 ' + process.argv[2] + ' ' + process.argv[3])", outFile, topicKey, idemJ.analysisId] })
  return { ok: true, idempotent: true }
}

const begin = await py('begin', ['--topic', topic, '--topic-key', topicKey, '--today', today])
results.push('begin raw: ' + lastJson(begin).slice(0, 100))
const aid = (await safeParse('begin', begin)).analysisId

const samples = [{ channel: '小红书', title: '样本A', author: 'a', metrics: { likes: '1' }, url: 'https://x/1' }, { channel: '公众号', title: '样本B', author: 'b', metrics: {}, url: 'https://x/2' }, { channel: '小红书', title: '样本C', author: 'c', metrics: {}, url: 'https://x/3' }]
const coverageOk = { 小红书: { ok: true, count: 2 }, 公众号: { ok: true, count: 1 } }
const coveragePartial = { 小红书: { ok: false, error: '浏览器不可用' }, 公众号: { ok: true, count: 3 } }

if (mode === 'starve') {
  const f = await py('fail', ['--analysis-id', aid, '--coverage', JSON.stringify({ 小红书: { ok: false, error: 'x' } })])
  push('fail', f)
  const st = await py('state', ['--analysis-id', aid])
  push('state', st)
  await command({ executable: 'node', args: ['-e', "require('fs').writeFileSync(process.argv[1], process.argv[2] + ' ' + (process.argv[3]||'').includes('RESEARCH_FAILED'))", outFile, 'starve', (st.stdout || '')] })
  return { ok: true, mode: 'starve' }
}

const useKey = mode === 'escape' ? '../' + topicKey : topicKey
const rep = await py('report', ['--analysis-id', aid, '--topic', topic, '--topic-key', useKey, '--today', today,
  '--coverage', JSON.stringify(mode === 'partial' ? coveragePartial : coverageOk), '--partial', mode === 'partial' ? '1' : '0',
  '--samples-json', JSON.stringify(samples), '--analysis-json', JSON.stringify({ classification: [], type_stats: {}, dims: {}, gaps: '', directions: [{ n: 1, 类型: 't', 切入角度: 'a', 差异化理由: 'r', 标题策略: 's', 可执行性: '高' }], caveats: 'c' })])
push('report', rep)

let confirmLine = ''
if (mode === 'confirm') {
  const c = await py('confirm', ['--analysis-id', aid, '--direction', '2'])
  push('confirm', c)
  confirmLine = ' ' + (c.stdout || '').includes('RESEARCH') + ' ' + (c.stdout || '')
}

const repOut = (rep.stdout || '') + (rep.stderr || '')
const summary = mode === 'escape'
  ? (repOut.includes('越界') ? '越界拦截 OK' : '越界未拦截 FAIL exit=' + rep.exitCode)
  : (repOut.includes('"ok": true') ? 'report OK' : 'report FAIL') + (mode === 'partial' ? ' partial' : '') + (mode === 'confirm' ? (confirmLine.includes('"ok": true') ? ' confirm OK' : ' confirm FAIL') : '')
await command({ executable: 'node', args: ['-e', "require('fs').writeFileSync(process.argv[1], process.argv[2] + ' ' + JSON.stringify(process.argv.slice(3)))", outFile, summary, ...results.map(r => r.slice(0, 120))] })
return { ok: summary.includes('OK') || summary.includes('report OK'), mode, analysisId: aid }
