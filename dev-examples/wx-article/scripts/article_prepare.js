export const meta = {
  name: 'article_prepare',
  description: '文章自动补齐入草稿箱: 定位目录 -> 确定性状态检查 -> 一次授权 -> 按需插图(语义匹配,默认不改写正文) -> 显式参数调 draft_manager/publish.py 建或更新草稿(同内容复用/变更更新)。对应需求文档 V1.2 prepare 模式。',
}

// 输入 args:
//   article_dir    : 文章目录绝对路径(与 article_name 二选一)
//   article_name   : 按名称在工作区定位(唯一命中才继续)
//   workspace_dir  : 工作区根(缺省读 config.json 的 article_workspace)
//   account_slot   : 账号槽位(默认 1)
//   skip_confirm   : 跳过授权 checkpoint(仅在外层已获有效授权时透传,如微信网关批准链)
//   mock / mock_store / inject : 测试透传(生产不传)
// 输出: { ok, article_dir, inserted, media_id, draft_mode(add|update|reuse), reused, report, issues }

const CHECK_SCRIPT = 'dev-examples/wx-article/scripts/draft_manager/check_state.py'
const PUBLISH_SCRIPT = 'dev-examples/wx-article/scripts/draft_manager/publish.py'

// Python 解释器真探测(Store 占位符问题,见 experience/windows-python-subprocess-gbk-and-python3-alias.md)
const PY_PROBE = 'PY=""; for c in python3 python py; do if "$c" -c "import sys" 2>/dev/null; then PY="$c"; break; fi; done; [ -n "$PY" ] || { echo "[FAIL] no usable python on PATH"; exit 49; }'

// 微信 Bot 步骤通知:向 .pi-wechat/outbox.jsonl 追加 pending,常驻服务 5s flush 投递。
// 尽力而为:commandSuccess 直接执行(零 LLM),失败静默,绝不阻塞发布流程。
const NOTIFY_SCRIPT = 'dev-examples/wx-article/scripts/draft_manager/notify_bot.py'
const notify = (kind, text) => {
  const clean = String(text).replace(/["%&|<>^]/g, ' ').replace(/\r?\n/g, ' ').slice(0, 1200)
  return commandSuccess('python "' + NOTIFY_SCRIPT + '" --kind ' + kind + ' --text "' + clean + '"' +
    ' || python3 "' + NOTIFY_SCRIPT + '" --kind ' + kind + ' --text "' + clean + '"', 20000).catch(() => false)
}

const checkArgs = (args.article_dir
  ? '--article-dir "' + args.article_dir + '"'
  : '--locate "' + (args.article_name || '') + '"' + (args.workspace_dir ? ' --workspace "' + args.workspace_dir + '"' : ''))
  + (args.account_slot ? ' --account-slot ' + args.account_slot : '')

const runCheckCmd = PY_PROBE + '; "$PY" "' + CHECK_SCRIPT + '" ' + checkArgs

// 中断兑底:任何未捕获异常(agent 失败/网络错误等)先推微信通知再重抛,保证"中断告知原因"
try {
phase('状态检查')
const check = await agent(
  '你是只读检查执行器。用 bash 工具执行恰好一条命令, 把 stdout 原样解析为 JSON 返回, 不做任何其他操作:\n\n' +
  runCheckCmd + '\n\n' +
  '禁止: 写/改/删任何文件, 调任何网络接口, 执行上述命令之外的任何命令。\n' +
  '返回 JSON: { raw(脚本 stdout 原文), ok, article_dir, needs_insert, prepare_ready, ' +
  'yaml(all: yaml 对象原样,含 title/digest/author/content_source/missing), cover_path(cover.path), ' +
  'md(all: md 对象原样), issues[](issues 数组), state_accounts(state.accounts 对象原样) }。',
  { label: '检查', agentType: 'general', schema: {
    type: 'object',
    properties: {
      raw: { type: 'string' },
      ok: { type: 'boolean' },
      article_dir: { type: 'string' },
      needs_insert: { type: 'boolean' },
      prepare_ready: { type: 'boolean' },
      yaml: { type: 'object' },
      cover_path: { type: 'string' },
      md: { type: 'object' },
      issues: { type: 'array', items: { type: 'string' } },
      state_accounts: { type: 'object' },
    },
    required: ['raw', 'ok', 'article_dir'],
  } }
)

if (!check.ok) {
  await notify('failed', '文章处理失败(定位阶段):' + (check.issues || []).join(';'))
  const cand = (() => { try { return JSON.parse(check.raw).candidates || [] } catch { return [] } })()
  return {
    ok: false, article_dir: '', inserted: 0, media_id: '', draft_mode: '', reused: false,
    report: '定位失败: ' + (check.issues || []).join('; '),
    issues: check.issues || [], candidates: cand,
  }
}

const articleDir = check.article_dir
const accs = check.state_accounts || {}
await notify('info', '检查完成:《' + (check.md && check.md.name ? check.md.name : articleDir) + '》' +
  (check.needs_insert ? '有未引用配图待插入' : '配图已就绪') + '，即将' + (check.needs_insert ? '插图并' : '') + '入草稿箱')
const pendingAcc = Object.keys(accs).filter(k => accs[k].hasPending)

// ---------- 一次授权（网关批准链生效时可 skip_confirm 透传） ----------
if (args.skip_confirm !== true) {
  await checkpoint(
    '即将处理文章: ' + articleDir + '\n' +
    '账号槽位: ' + (args.account_slot || 1) + '\n' +
    '计划步骤:\n' +
    (check.needs_insert ? '  1. 插图: imgs 有未引用配图,按章节语义匹配插入(不改写正文)\n' : '  1. 插图: 跳过(无未引用配图)\n') +
    '  2. 草稿: 调 publish.py 建/更新草稿' +
      (pendingAcc.length ? '(注意: 账号 ' + pendingAcc.join(',') + ' 有未决操作,将先人工核对再继续)\n' : '\n') +
    '说明: 会修改文章目录内文件(插图标记/article.yaml/publish-state.json),并调用微信 API。\n' +
    '允许=执行; 拒绝=终止。'
  )
}

// ---------- 按需插图（复用既有插图流程: 语义匹配必须靠 AI; 默认不改写正文） ----------
let inserted = 0
if (check.needs_insert) {
  phase('按需插图')
  const ins = await workflow('article_insert_images_meta.js', {
    article_dir: articleDir,
    skip_humanize: true,   // prepare 链路绝不隐含改写正文（V1.2 5.2/评审第 9 项）
    skip_confirm: true,    // 授权作用域:prepare 的 checkpoint(或外层批准链)已覆盖插图,不再二次确认
  })
  if (ins && ins.ok) {
    inserted = ins.inserted || 0
    log('插图完成: ' + inserted + ' 张, cover=' + (ins.cover || '(无)'))
    await notify('info', '插图完成:' + inserted + ' 张已按章节语义匹配插入,封面已定位')
  } else {
    log('插图未成功: ' + ((ins && ins.error) || '未知原因') + '；继续尝试草稿(若封面/元数据已就绪)')
  }
}

// ---------- 插图后重查状态（yaml/cover 已更新; 快照式两段检查） ----------
phase('草稿准备')
const check2 = await agent(
  '你是只读检查执行器。用 bash 工具执行恰好一条命令, 把 stdout 原样解析为 JSON 返回, 不做任何其他操作:\n\n' +
  runCheckCmd + '\n\n' +
  '禁止: 写/改/删任何文件, 调任何网络接口。\n' +
  '返回 JSON: { raw, ok, article_dir, prepare_ready, cover_path(cover.path), ' +
  'yaml(all: yaml 对象原样), md(all: md 对象原样), issues[](issues 数组), state_accounts(state.accounts 原样) }。',
  { label: '复查', agentType: 'general', schema: {
    type: 'object',
    properties: {
      raw: { type: 'string' },
      ok: { type: 'boolean' },
      article_dir: { type: 'string' },
      prepare_ready: { type: 'boolean' },
      cover_path: { type: 'string' },
      yaml: { type: 'object' },
      md: { type: 'object' },
      issues: { type: 'array', items: { type: 'string' } },
      state_accounts: { type: 'object' },
    },
    required: ['raw', 'ok', 'article_dir'],
  } }
)

if (!check2.prepare_ready) {
  await notify('failed', '文章处理失败(就绪检查):' + (check2.issues || []).join(';'))
  return {
    ok: false, article_dir: articleDir, inserted,
    media_id: '', draft_mode: '', reused: false,
    report: 'prepare 就绪检查未通过: ' + (check2.issues || []).join('; '),
    issues: check2.issues || [],
  }
}

// ---------- 建或更新草稿（显式参数,发布脚本不猜——V1.2 5.2） ----------
const yamlTitle = (check2.yaml && check2.yaml.title) || ''
const yamlDigest = (check2.yaml && check2.yaml.digest) || ''
const yamlAuthor = (check2.yaml && check2.yaml.author) || ''
const mdPath = (check2.md && check2.md.path) || ''
const coverPath = check2.cover_path || ''

const mockArgs = (args.mock ? ' --mock' : '') +
  (args.mock_store ? ' --mock-store "' + args.mock_store + '"' : '') +
  (args.inject ? ' --inject "' + args.inject + '"' : '')

const publishCmd = PY_PROBE + '; "$PY" "' + PUBLISH_SCRIPT + '"' +
  ' --article-dir "' + articleDir + '"' +
  ' --cover "' + coverPath + '"' +
  ' --account-slot ' + (args.account_slot || 1) +
  (yamlTitle ? ' --title "' + yamlTitle + '"' : '') +
  (yamlDigest ? ' --digest "' + yamlDigest + '"' : '') +
  (yamlAuthor ? ' --author "' + yamlAuthor + '"' : '') +
  (mdPath ? ' --md-file "' + mdPath + '"' : '') +
  mockArgs

const pub = await agent(
  '你是发布执行者。用 bash 工具执行恰好一条命令(发布脚本,Python 标准库实现):\n\n' +
  publishCmd + '\n\n' +
  '脚本 stdout 契约: "[5] DRAFT OK media_id=xxx" 为成功行(可能带 "(reuse,...)" 或 "(updated)" 后缀); ' +
  '末尾 "=== ALL DONE draft_media_id=xxx ===" 表示全流程成功; "[FAIL] ..." 退出码 1 为明确失败; ' +
  '"[UNKNOWN] ..." 退出码 2 表示结果不确定(需人工核对草稿箱,禁止重试); "[LOCKED] ..." 退出码 3 表示文章正被其他任务处理。\n' +
  '按退出码与 stdout 原文返回,不重试,不额外操作。\n' +
  '返回 JSON: { exit_code, stdout_tail(最后 15 行原文), media_id, mode(reuse|updated|add|未知则空), unknown(bool), locked(bool), fail_line(首个 [FAIL] 行,无则空) }。',
  { label: '发布', agentType: 'general', schema: {
    type: 'object',
    properties: {
      exit_code: { type: 'number' },
      stdout_tail: { type: 'string' },
      media_id: { type: 'string' },
      mode: { type: 'string' },
      unknown: { type: 'boolean' },
      locked: { type: 'boolean' },
      fail_line: { type: 'string' },
    },
    required: ['exit_code', 'media_id', 'unknown', 'locked'],
  } }
)

const draftMode = pub.mode === 'reuse' ? 'reuse' : pub.mode === 'updated' ? 'update' : pub.mode === 'add' ? 'add' : ''
const okResult = pub.exit_code === 0 && !!pub.media_id
const shortName = String(articleDir).replace(/\\/g, '/').split('/').pop()
if (okResult) {
  await notify('completed', '完成了！《' + shortName + '》草稿已入草稿箱(' +
    (draftMode === 'reuse' ? '同内容复用' : draftMode === 'update' ? '内容变更已更新' : '新建') +
    ',插图 ' + inserted + ' 张,media_id=' + String(pub.media_id).slice(-12) + '),可到公众号后台预览')
} else if (pub.unknown) {
  await notify('interrupted', '文章处理中断(结果不确定): 需人工核对草稿箱后用 --resolve-media-id 恢复。文章: ' + shortName)
} else if (pub.locked) {
  await notify('interrupted', '文章处理中断: 正被其他任务处理,稍后重试。文章: ' + shortName)
} else {
  await notify('failed', '文章处理失败: ' + (pub.fail_line || '未知') + '(草稿保留)。文章: ' + shortName)
}
const report =
  (okResult
    ? '草稿就绪: media_id=' + pub.media_id + ' (' + (draftMode === 'reuse' ? '同内容复用' : draftMode === 'update' ? '内容变更已更新' : '新建') + ')'
    : pub.unknown
      ? '结果不确定: 需人工核对草稿箱后用 --resolve-media-id 恢复'
      : pub.locked
        ? '文章正被其他任务处理,稍后重试'
        : '发布失败: ' + (pub.fail_line || '未知')) +
  '\n文章: ' + articleDir + '\n插图: ' + inserted + ' 张'

return {
  ok: okResult,
  article_dir: articleDir,
  inserted,
  media_id: pub.media_id || '',
  draft_mode: draftMode,
  reused: draftMode === 'reuse',
  unknown: pub.unknown === true,
  locked: pub.locked === true,
  report,
  issues: okResult ? [] : [pub.fail_line || (pub.unknown ? '[UNKNOWN] 人工核对' : '[LOCKED] 稍后重试')],
}
} catch (e) {
  await notify('interrupted', '文章处理中断: ' + (e && e.message ? e.message : String(e)).slice(0, 600))
  throw e
}
