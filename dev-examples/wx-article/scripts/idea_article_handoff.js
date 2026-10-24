export const meta = {
  name: 'idea_article_handoff',
  description: '交接(draft_ready→单篇/<标题>/): 前置校验(状态/无blocking/无stale)→三件套落盘(正文+article.yaml+配图建议)→handoffId 幂等→回写 handed_off→播报「准备文章 <标题>」进入配图/草稿箱。不自动嵌套 article-prepare, 发布仍走独立审批。话术:「交接文章 <标题>」「准备发布 <标题>」「文章写完了 交接」。',
  phases: [{ title: '前置检查' }, { title: '交接落盘' }, { title: '播报' }],
}

// idea_to_article V1.0 Phase D（执行方案 §2 D7 handoff 适配层）
// 输入 args:
//   title : 任务标题（仅标题字符串，locate 锚定；绝不含路径）
// 全部交接逻辑在 idea_files.py handoff 子命令内（确定性、O_EXCL、handoffId 幂等、unknown 禁自动重试）。

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
  const r = await command({ executable: py, args: [IDEA_FILES, action, ...flagArgs], timeoutMs: 120_000, label: 'idea_files ' + action })
  if (r.exitCode !== 0) {
    return { ok: false, code: 'crash', issues: ['exit=' + r.exitCode, (r.stderr || r.stdout).slice(0, 300)] }
  }
  try { return JSON.parse(r.stdout) } catch (e) { return { ok: false, code: 'bad_output', issues: [String(r.stdout).slice(0, 300)] } }
}

function b64u(s) {
  const T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c < 0x80) bytes.push(c)
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1)
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
        bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
        i++
      } else bytes.push(0xef, 0xbf, 0xbd)
    } else if (c >= 0xd800 && c <= 0xdfff) bytes.push(0xef, 0xbf, 0xbd)
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1
    out += T[b0 >> 2] + T[((b0 & 3) << 4) | (b1 >= 0 ? b1 >> 4 : 0)]
    out += b1 >= 0 ? T[((b1 & 15) << 2) | (b2 >= 0 ? b2 >> 6 : 0)] : '='
    out += b2 >= 0 ? T[b2 & 63] : '='
  }
  return out
}

phase('前置检查')
const title = String(args.title || '').trim()
await check(() => title !== '', '缺少 title（任务标题）')

const loc = await runIdea('locate', ['--title', title])
if (loc.ok !== true) {
  if (loc.code === 'ambiguous') {
    const list = (loc.candidates || []).map((c, i) => String(i + 1) + '. ' + c.title + '（' + c.status + '）').join('\n')
    return { ok: false, code: 'ambiguous', candidates: loc.candidates, message: '有多个任务匹配「' + title + '」：\n' + list + '\n请用完整标题重发。' }
  }
  return { ok: false, code: 'not_found', message: '没有找到「' + title + '」的任务。' }
}
log('任务定位: ' + loc.title + ' 状态 ' + loc.status)

phase('交接落盘')
const h = await runIdea('handoff', ['--dir', loc.dir])
if (h.ok !== true) {
  // unknown（交接后正文变更）禁自动重试转人工；invalid/not_found 给确定性引导
  const hint = h.code === 'unknown'
    ? '⚠ 交接状态异常（正文在交接后已变更）：已停止自动处理，请人工核对 ' + loc.dir + ' 与交接目录。'
    : (h.issues || []).join('；')
  return { ok: false, code: h.code || 'invalid', issues: h.issues, message: '《' + loc.title + '》交接未完成：' + hint }
}
log('交接完成: ' + h.articleDir + (h.idempotent ? '（幂等重试）' : ''))

phase('播报')
const rep = await agent(
  '生成微信回复（交接完成播报）。要素: ✅ 已交接、正式标题、交接目录（相对 vault 写作区的位置，如 单篇/<标题>）、幂等重试时注明「本次为重复交接，未重写文件」、下一步指引「回复 准备文章 ' + loc.title + ' 进入配图与草稿箱（将走独立审批）」。\n' +
  '交接数据: ' + JSON.stringify({ title: h.title, dirName: h.dirName, handoffId: h.handoffId, idempotent: h.idempotent }) + '\n返回 JSON: { message: string }。',
  { label: '播报', agentType: 'general', schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } })
await runIdea('append', ['--dir', loc.dir, '--file', 'messages.jsonl', '--role', 'user', '--turn', '0', '--content-b64', b64u(String(args.message || '交接文章 ' + title))])
await runIdea('append', ['--dir', loc.dir, '--file', 'messages.jsonl', '--role', 'assistant', '--turn', '0', '--content-b64', b64u(rep.message)])

return {
  ok: true,
  articleId: loc.articleId,
  title: h.title,
  articleDir: h.articleDir,
  dirName: h.dirName,
  handoffId: h.handoffId,
  idempotent: h.idempotent,
  status: 'handed_off',
  message: rep.message,
}
