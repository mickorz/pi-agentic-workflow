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

const ADAPTER_CLI = 'dev-examples/videodigest/adapter/dist/cli.js'
const ARCHIVE_PY = 'dev-examples/videodigest/scripts/archive_inspire.py'
const WORK_ROOT = 'dev-examples/videodigest/work'

// Python 解释器真探测: command -v 在 Windows 会命中 Store 占位符(存在但必败),
// 必须试运行验证(见 experience/windows-python-subprocess-gbk-and-python3-alias.md)
const PY_PROBE = 'PY=""; for c in python3 python py; do if "$c" -c "import sys" 2>/dev/null; then PY="$c"; break; fi; done; [ -n "$PY" ] || { echo "[FAIL] no usable python on PATH"; exit 49; }'

// 受控 agent 指令模板: 唯一动作是执行恰好一条命令, stdout 原样解析为 JSON
function executorPrompt(cmd, jsonFields) {
  return (
    '你是命令执行器。用 bash 工具执行恰好一条命令, 把 stdout 原样解析为 JSON 返回, 不做任何其他操作:\n\n' +
    cmd +
    '\n\n禁止: 写/改/删任何文件(命令本身的产物除外), 调任何网络接口(命令本身访问的除外), 执行上述命令之外的任何命令。\n' +
    '返回 JSON: ' +
    jsonFields +
    '。若命令退出码非 0, 如实返回 raw(完整 stdout/stderr)与 ok=false, 不要重试、不要自行修复。'
  )
}

// shell 安全化: 双引号包裹 + 去掉反引号与 $( 防 LLM 字段内容破坏命令结构
function shQuote(value) {
  const safe = String(value == null ? '' : value)
    .replace(/`/g, "'")
    .replace(/\$\{/g, '(')
    .replace(/"/g, "'")
    .replace(/[\r\n]+/g, ' ')
  return '"' + safe + '"'
}

// ①链接解析: 确定性 resolve(短链 302 跟随 → videoId → sourceKey), 零 LLM
phase('链接解析')
const rawUrl = String(args.url || '').trim()
await check(() => /^https?:\/\//.test(rawUrl), 'args.url 不是 http(s) 链接: ' + rawUrl)

// stderr 重定向到文件: agent 只看 stdout 纯 JSON, 防日志行混入 raw 导致 JSON.parse 失败。
// 包一层 bash -c: 先 mkdir -p 确保重定向目标目录存在(全新环境 work/ 可能不存在)
function stdioRedirect(cmd, stderrPath, mkdirDir) {
  return 'bash -c ' + shQuote('mkdir -p ' + mkdirDir + ' && ' + cmd + ' 2>' + stderrPath)
}

const resolveCmd = stdioRedirect(
  'node ' + shQuote(ADAPTER_CLI) + ' resolve --url ' + shQuote(rawUrl),
  WORK_ROOT + '/resolve.stderr.log',
  WORK_ROOT,
)
const resolveResult = await agent(executorPrompt(resolveCmd, '{ raw(命令 stdout 原文), ok, sourceKey, videoId, canonicalUrl, platform }'), {
  label: '链接解析',
  agentType: 'general',
  schema: {
    type: 'object',
    properties: {
      raw: { type: 'string' },
      ok: { type: 'boolean' },
      sourceKey: { type: 'string' },
      videoId: { type: 'string' },
      canonicalUrl: { type: 'string' },
      platform: { type: 'string' },
    },
    required: ['raw', 'ok'],
  },
})

// agent 重试耗尽返回 null：提前退出，让阶段失败闸门以真实原因标记失败（防 null.raw TypeError 遮蔽真因）
if (!resolveResult) return
let resolveJson = {}
try {
  resolveJson = JSON.parse(resolveResult.raw)
} catch {
  /* 空, 下方 check 兜底 */
}
await check(
  () => resolveResult.ok === true && resolveJson.ok === true && typeof resolveJson.sourceKey === 'string',
  '链接解析失败: ' + (resolveResult.raw || '').slice(0, 300)
)
const sourceKey = resolveJson.sourceKey
const platform = resolveJson.platform || sourceKey.split(':', 1)[0]
const videoId = resolveJson.videoId || sourceKey.split(':', 2)[1] || ''
const canonicalUrl = resolveJson.canonicalUrl || rawUrl
log('sourceKey=' + sourceKey + ' canonicalUrl=' + canonicalUrl)

const runArchive = (sub) => PY_PROBE + '; "$PY" ' + shQuote(ARCHIVE_PY) + ' ' + sub

// ②幂等查重: frontmatter 扫查(已归档→直接回执) + 原子占锁(占用→「处理中」回执)
phase('幂等查重')
const checkCmd =
  runArchive('check') +
  ' --source-key ' + shQuote(sourceKey) +
  ' --source-platform ' + shQuote(platform) +
  ' --source-id ' + shQuote(videoId)
const checkResult = await agent(executorPrompt(checkCmd, '{ raw, ok, archived, title?, rel_dir?, file_rel?, locked, lock_stale }'), {
  label: '幂等查重',
  agentType: 'general',
  schema: {
    type: 'object',
    properties: {
      raw: { type: 'string' },
      ok: { type: 'boolean' },
      archived: { type: 'boolean' },
      title: { type: 'string' },
      rel_dir: { type: 'string' },
      file_rel: { type: 'string' },
      locked: { type: 'boolean' },
      lock_stale: { type: 'boolean' },
    },
    required: ['raw', 'ok', 'archived'],
  },
})
if (!checkResult) return // 同上：闸门报真因
let idempotentState = {}
try {
  idempotentState = JSON.parse(checkResult.raw)
} catch {
  /* 空 */
}
await check(() => checkResult.ok === true, '幂等查重脚本失败: ' + (checkResult.raw || '').slice(0, 300))

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

const lockCmd = runArchive('lock') + ' --source-key ' + shQuote(sourceKey) + ' --claimer workflow'
const lockResult = await agent(executorPrompt(lockCmd, '{ raw, ok, locked, busy?, took_over? }'), {
  label: '占锁',
  agentType: 'general',
  schema: {
    type: 'object',
    properties: { raw: { type: 'string' }, ok: { type: 'boolean' }, locked: { type: 'boolean' }, busy: { type: 'boolean' }, took_over: { type: 'boolean' } },
    required: ['raw', 'ok', 'locked'],
  },
})
if (!lockResult) return // 同上：闸门报真因
let lockJson = {}
try {
  lockJson = JSON.parse(lockResult.raw)
} catch {
  /* 空 */
}
await check(() => lockResult.ok === true && lockJson.locked === true, '未获得处理锁（可能正被并发处理）: ' + (lockResult.raw || '').slice(0, 200))

// 失败路径统一: 释放锁再让失败浮出(崩溃残留由 30min 陈锁接管兜底)
try {
  // ③音频提取: 短链→cookie→音频下载(16kHz wav)→百炼 fun-asr 转写(2~5 分钟, 轮询上限 30 分钟)
  phase('音频提取')
  const workDir = WORK_ROOT + '/' + sourceKey.replace(/[^a-zA-Z0-9_-]/g, '_')
  const extractCmd = stdioRedirect(
    'node ' + shQuote(ADAPTER_CLI) + ' extract --url ' + shQuote(canonicalUrl) + ' --workdir ' + shQuote(workDir),
    workDir + '/extract.stderr.log',
    workDir,
  )
  const extractResult = await agent(
    executorPrompt(extractCmd, '{ raw(命令 stdout 原文, 含 extract JSON), ok, sourceKey, transcriptText, metadata }') +
      '\n注意: 该命令耗时可能 2~5 分钟(下载+转写轮询), 请耐心等待完成, 不要中途打断或超时放弃。',
    {
      label: '音频提取',
      agentType: 'general',
      schema: {
        type: 'object',
        properties: {
          raw: { type: 'string' },
          ok: { type: 'boolean' },
          sourceKey: { type: 'string' },
          transcriptText: { type: 'string' },
          metadata: { type: 'object' },
        },
        required: ['raw', 'ok'],
      },
    }
  )
  if (!extractResult) return // 同上：闸门报真因
  await check(
    () => extractResult.ok === true,
    '音频提取/转写失败(原始输出): ' + (extractResult.raw || '').slice(0, 400)
  )
  let extractJson = {}
  try {
    extractJson = JSON.parse(extractResult.raw)
  } catch {
    /* 空 */
  }
  await check(
    () => typeof extractJson.transcriptText === 'string' && extractJson.transcriptText.trim().length > 0,
    '转写结果为空(疑似无音轨或图文笔记): ' + (extractResult.raw || '').slice(0, 200)
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
  const archiveCmd =
    runArchive('archive') +
    ' --title ' + shQuote(metadata.title) +
    ' --transcript-json ' + shQuote(workDir + '/transcript.json') +
    ' --source-platform ' + shQuote(platform) +
    ' --source-id ' + shQuote(videoId) +
    ' --source-url ' + shQuote(canonicalUrl) +
    ' --uploader ' + shQuote(metadata.uploader || '') +
    (metadata.durationSeconds != null ? ' --duration ' + Number(metadata.durationSeconds) : '')
  const archiveResult = await agent(
    executorPrompt(archiveCmd, '{ raw, ok, duplicate?, title, rel_dir, file_rel, vault_root }'),
    { label: '灵感归档', agentType: 'general', schema: {
      type: 'object',
      properties: {
        raw: { type: 'string' },
        ok: { type: 'boolean' },
        duplicate: { type: 'boolean' },
        title: { type: 'string' },
        rel_dir: { type: 'string' },
        file_rel: { type: 'string' },
        vault_root: { type: 'string' },
      },
      required: ['raw', 'ok'],
    } }
  )
  if (!archiveResult) return // 同上：闸门报真因
  let archiveJson = {}
  try {
    archiveJson = JSON.parse(archiveResult.raw)
  } catch {
    /* 空 */
  }
  await check(
    () => archiveResult.ok === true && archiveJson.ok === true,
    '灵感归档失败: ' + (archiveResult.raw || '').slice(0, 300)
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
} catch (err) {
  // 锁释放在 finally 统一做; 这里只让失败原因浮出(网关/监控发失败回执)
  throw err
} finally {
  // 归档完成或最终失败都释放锁(§4.2); 释放失败容忍(30min 陈锁接管兜底);
  // 成功后幂等由 frontmatter 扫查接管
  try {
    await agent(executorPrompt(runArchive('unlock') + ' --source-key ' + shQuote(sourceKey), '{ raw, ok }'), {
      label: '释放锁',
      agentType: 'general',
      schema: { type: 'object', properties: { raw: { type: 'string' }, ok: { type: 'boolean' } }, required: ['raw', 'ok'] },
    })
  } catch {
    /* 释放失败容忍 */
  }
}
