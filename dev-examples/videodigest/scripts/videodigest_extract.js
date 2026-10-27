export const meta = {
  name: 'videodigest_extract',
  description: '提取短视频工作流: 抖音链接 → 音频下载 → 百炼转写 → 逐字稿排版整理(零内容修改) → 幂等归档 Obsidian 灵感区 0-raw.md → 回执。无 AI 评论/提炼(用户流程调整 2026-10-24)。',
  phases: [
    { title: '链接解析' },
    { title: '幂等查重' },
    { title: '音频提取' },
    { title: '灵感归档' },
    { title: '回执' },
  ],
}

// 输入 args:
//   url : 抖音视频链接(裸链接经 URL 前置路由直达; 或 LLM 兜底路由提取)
// 输出: { ok, title, file_rel, rel_dir, idempotent, timings, receipt }
//
// 用户流程调整 2026-10-24:
//   1) 文章 = 整理排版后的逐字稿(reflow 只插入换行, 零内容修改), 固定文件名 0-raw.md
//   2) 无 AI 评论/提炼 —— 标题取视频页面原标题(adapter metadata.title), 不经 LLM 生成
//
// 执行器演进 2026-10-26: 全部确定性命令改 command() 直跑(不经 LLM)。
// 教训: 之前用 LLM executor 转述命令输出, 真机出现过「模型回复为空」(run-mvp0d2sr)与
// 「编造成功输出」(run-mvp8vfx4: vault_root 指向不存在的 work/vault, 输出格式与脚本实现
// 完全不符, 磁盘上无对应文件)——确定性命令交给 LLM 转述, 就要承担 LLM 的一切毛病。

const ADAPTER_CLI = 'dev-examples/videodigest/adapter/dist/cli.js'
const ARCHIVE_PY = 'dev-examples/videodigest/scripts/archive_inspire.py'
const WORK_ROOT = 'dev-examples/videodigest/work'

// Python 解释器真探测: Windows 上 python3 是 Store 占位符(存在但必败), 必须试运行验证
// (见 experience/windows-python-subprocess-gbk-and-python3-alias.md)
let PY = ''
for (const cand of ['python3', 'python', 'py']) {
  const probe = await command({ executable: cand, args: ['-c', 'import sys'], label: '探测 python(' + cand + ')' })
  if (probe.exitCode === 0) { PY = cand; break }
}
if (!PY) throw new Error('PATH 上无可用 Python 解释器(python3/python/py 均试运行失败)')

// 确定性子进程执行 + stdout JSON 契约解析; 失败抛带原始输出的错误(通知直达用户)
// 错误可见性契约(2026-10-27): adapter 失败时 stdout 是结构化 {ok:false,error:{step,message,details}},
// 真实错误在 stderr 末尾(失败 [step] ...行)——只取头部 300 字符会把原因全部截掉,
// 微信失败回执只剩过程日志。优先解 stdout JSON, 兜底 stderr 首尾拼接。
function briefTail(s, head, tail) {
  const one = String(s || '').replace(/\s+/g, ' ').trim()
  if (!one) return ''
  return one.length <= head + tail ? one : one.slice(0, head) + ' … ' + one.slice(-tail)
}
async function runJson(label, executable, argv, timeoutMs) {
  const r = await command({ executable, args: argv, label, ...(timeoutMs ? { timeoutMs } : {}) })
  if (r.exitCode !== 0) {
    let reason = ''
    try {
      const j = JSON.parse(r.stdout)
      if (j && j.ok === false && j.error) {
        reason = (j.error.step ? '[' + j.error.step + '] ' : '') + String(j.error.message || '')
          + (j.error.details ? ' | ' + String(j.error.details).replace(/\s+/g, ' ').slice(0, 200) : '')
      }
    } catch { /* stdout 非 JSON(如超时被杀只有 stderr), 走兜底 */ }
    if (!reason) reason = briefTail(r.stderr || r.stdout, 150, 250)
    throw new Error(label + '失败(退出码 ' + r.exitCode + '): ' + reason)
  }
  try {
    return JSON.parse(r.stdout)
  } catch {
    throw new Error(label + ' stdout 非合法 JSON: ' + r.stdout.slice(0, 300))
  }
}

// ①链接解析: 确定性 resolve(短链 302 跟随 → videoId → sourceKey), 零 LLM
phase('链接解析')
const rawUrl = String(args.url || '').trim()
await check(() => /^https?:\/\//.test(rawUrl), 'args.url 不是 http(s) 链接: ' + rawUrl)

const resolveJson = await runJson('链接解析 ', 'node', [ADAPTER_CLI, 'resolve', '--url', rawUrl])
await check(
  () => resolveJson.ok === true && typeof resolveJson.sourceKey === 'string',
  '链接解析失败: ' + JSON.stringify(resolveJson).slice(0, 300)
)
const sourceKey = resolveJson.sourceKey
const platform = resolveJson.platform || sourceKey.split(':', 1)[0]
const videoId = resolveJson.videoId || sourceKey.split(':', 2)[1] || ''
const canonicalUrl = resolveJson.canonicalUrl || rawUrl
log('sourceKey=' + sourceKey + ' canonicalUrl=' + canonicalUrl)

const archiveArgs = (sub) => [ARCHIVE_PY, sub, '--source-key', sourceKey]

// ②幂等查重: frontmatter 扫查(已归档→直接回执) + 原子占锁(占用→「处理中」回执)
phase('幂等查重')
const idempotentState = await runJson(
  '幂等查重 ',
  PY,
  [...archiveArgs('check'), '--source-platform', platform, '--source-id', videoId]
)

if (idempotentState.archived === true) {
  // 同视频重发: 返回已有素材路径, 不重新下载不建新目录(§4.1)
  phase('回执')
  return {
    ok: true,
    idempotent: true,
    title: idempotentState.title,
    rel_dir: idempotentState.rel_dir,
    file_rel: idempotentState.file_rel,
    receipt: '已归档（幂等命中）: ' + idempotentState.title + ' → 60_Workspace/写作/灵感/' + idempotentState.rel_dir + '/',
    timings: null,
  }
}
if (idempotentState.locked === true && idempotentState.lock_stale === false) {
  phase('回执')
  return {
    ok: true,
    busy: true,
    receipt: '该视频正在处理中（同 sourceKey 处理占用），完成后请留意归档通知；sourceKey=' + sourceKey,
    timings: null,
  }
}

const lockJson = await runJson('占锁 ', PY, [...archiveArgs('lock'), '--claimer', 'workflow'])
await check(
  () => lockJson.locked === true,
  '未获得处理锁（可能正被并发处理）: ' + JSON.stringify(lockJson).slice(0, 200)
)

try {
  // ③音频提取: 短链→cookie→音频下载(16kHz wav)→百炼 fun-asr 转写(2~5 分钟, 轮询上限 30 分钟)
  // 瞬时容错(2026-10-27): CDP 打开视频页阶段偶发失败(抖音风控/页面慢载), 实测同链接 10 分钟后手动重跑成功——
  // 失败后等 10s 重试一次; 缓存(transcript.json)与锁都在本工作流内, 重试安全。
  phase('音频提取')
  const workDir = WORK_ROOT + '/' + sourceKey.replace(/[^a-zA-Z0-9_-]/g, '_')
  const extractArgv = ['extract', '--url', canonicalUrl, '--workdir', workDir]
  let extractJson
  try {
    extractJson = await runJson('音频提取 ', 'node', [ADAPTER_CLI, ...extractArgv], 40 * 60 * 1000)
  } catch (firstErr) {
    log('音频提取首次失败，暂停 10s 后重试一次（CDP/风控偶发）: ' + String(firstErr.message || firstErr).slice(0, 200))
    // 沙箱无 sleep/setTimeout，用已探测的 PY 解释器暂停（跨平台）
    await commandSuccess(PY + ' -c "import time; time.sleep(10)"', 20_000)
    extractJson = await runJson('音频提取(重试) ', 'node', [ADAPTER_CLI, ...extractArgv], 40 * 60 * 1000)
  }
  await check(
    () => typeof extractJson.transcriptText === 'string' && extractJson.transcriptText.trim().length > 0,
    '转写结果为空(疑似无音轨或图文笔记): ' + JSON.stringify(extractJson).slice(0, 300)
  )
  const metadata = extractJson.metadata || {}
  const timings = extractJson.timings || null
  log('提取完成: 时长=' + (metadata.durationSeconds || '?') + 's 作者=' + (metadata.uploader || '?') + ' 标题=' + (metadata.title || '?'))

  // ④灵感归档: 标题=视频页面原标题; 逐字稿引用 adapter 落盘的 transcript.json;
  //   reflow 整理排版(零内容修改) → 0-raw.md; 撞名序号; frontmatter 代码拼装; 原子写; 硬约束灵感目录前缀
  phase('灵感归档')
  await check(
    () => typeof metadata.title === 'string' && metadata.title.trim().length > 0,
    '视频页面标题缺失, 无法命名素材目录'
  )
  const archiveJson = await runJson('灵感归档 ', PY, [
    ARCHIVE_PY, 'archive',
    '--title', metadata.title,
    '--transcript-json', workDir + '/transcript.json',
    '--source-platform', platform,
    '--source-id', videoId,
    '--source-url', canonicalUrl,
    '--uploader', metadata.uploader || '',
    ...(metadata.durationSeconds != null ? ['--duration', String(Number(metadata.durationSeconds))] : []),
  ])
  await check(
    () => archiveJson.ok === true,
    '灵感归档失败: ' + JSON.stringify(archiveJson).slice(0, 300)
  )

  // ⑤回执: 标题 + vault 相对路径 + 各步耗时
  phase('回执')
  const timingLine = timings
    ? '各步耗时: 解析' + Math.round(timings.resolveMs / 1000) + 's/cookie' + Math.round(timings.cookieMs / 1000) +
      's/下载' + Math.round(timings.downloadMs / 1000) + 's/转写' + Math.round(timings.transcribeMs / 1000) +
      's/合计' + Math.round(timings.totalMs / 1000) + 's'
    : ''
  return {
    ok: true,
    idempotent: false,
    title: archiveJson.title,
    rel_dir: archiveJson.rel_dir,
    file_rel: archiveJson.file_rel,
    vault_root: archiveJson.vault_root,
    sourceKey: sourceKey,
    timings: timings,
    receipt:
      '✅ 已归档: ' + archiveJson.title + '\n' +
      '📁 60_Workspace/写作/灵感/' + archiveJson.file_rel + '\n' +
      (timingLine ? '⏱ ' + timingLine : ''),
  }
} finally {
  // 归档完成或最终失败都释放锁(§4.2); 释放失败容忍(30min 陈锁接管兜底);
  // 成功后幂等由 frontmatter 扫查接管
  try {
    await command({ executable: PY, args: archiveArgs('unlock'), label: '释放锁' })
  } catch {
    /* 释放失败容忍 */
  }
}
