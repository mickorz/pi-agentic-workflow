export const meta = {
  name: 'article_prepare',
  description: '文章自动补齐入草稿箱: 定位目录 -> 确定性状态检查(含配图序号预检,缺号/越界直接中断;手动插图(Obsidian ![[图]] 内嵌)识别为免自动插图) -> 一次授权 -> 按需插图(序号优先/语义匹配,默认不改写正文)或手动插图链接规范化(零 LLM,不改图片位置) -> 显式参数调 draft_manager/publish.py 建或更新草稿(同内容复用/变更更新)。默认必须走到草稿箱。对应需求文档 V1.2 prepare 模式。',
}

// 输入 args:
//   article_dir    : 文章目录绝对路径(定位通道之一)
//   vault_ref      : Obsidian 逻辑引用(定位通道之二): 文章名或 vault 相对路径(如 AI提问技巧 或 公众号/AI入门/AI提问技巧),
//                    服务端 vault_resolver 确定性解析(want=article);歧义列候选不猜(VR S3.2)
//   vault_scope    : 限定搜索范围(vault 相对目录或配置别名,可选,硬约束)
//   vault_ref_pinned_rel : 审批锚点(vault 相对路径;服务端审批链注入,外部传入仅作一致性比对)
//   article_name   : 按名称在工作区定位(定位通道之三,唯一命中才继续)
//   workspace_dir  : 工作区根(缺省读 config.json 的 article_workspace)
//   account_slot   : 账号槽位(默认 1)
//   skip_confirm   : 跳过授权 checkpoint(仅在外层已获有效授权时透传,如微信网关批准链)
//   mock / mock_store / inject : 测试透传(生产不传)
// 输出: { ok, article_dir, inserted, media_id, draft_mode(add|update|reuse), reused, report, issues }

const CHECK_SCRIPT = 'dev-examples/wx-article/scripts/draft_manager/check_state.py'
const PUBLISH_SCRIPT = 'dev-examples/wx-article/scripts/draft_manager/publish.py'
const NORMALIZE_SCRIPT = 'dev-examples/wx-article/scripts/draft_manager/normalize_manual_images.py'

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

// 中断兑底:任何未捕获异常(agent 失败/网络错误等)先推微信通知再重抛,保证"中断告知原因"
try {
phase('文章定位')
// 定位通道三选一: article_dir / vault_ref / article_name(VR S3.2)。
// vaultResolve 为服务端确定性解析(零 LLM);失败/歧义走 check() 中止,不空转。
let articleDir = args.article_dir || ''
if (!articleDir && args.vault_ref) {
  const r = await vaultResolve(args.vault_ref, { scope: args.vault_scope, want: 'article' })
  await check(
    () => r.ok === true,
    '文章定位失败: ' + JSON.stringify({ issues: r.issues, candidates: r.candidates }),
  )
  if (args.vault_ref_pinned_rel) {
    await check(
      () => r.resolved_rel === args.vault_ref_pinned_rel,
      '定位结果与批准目标不一致，请重新授权',
    )
  }
  articleDir = r.resolved_path
  log('vault 定位: ' + args.vault_ref + ' -> ' + r.resolved_rel)
}
// article_name 通道优先尝试 vault 确定性解析(2026-10-26): 免后缀话术「准备/处理文章 <标题>」
// 路由常提取为 article_name,而文章实际在 Obsidian vault 且未配 article_workspace(裸 --locate 必败)。
// vault 命中即用; 未命中回落原 --locate(workspace 模式),不影响纯工作区部署。
if (!articleDir && !args.vault_ref && args.article_name) {
  const vr = await vaultResolve(args.article_name, { scope: args.vault_scope, want: 'article' })
  if (vr.ok === true) {
    if (args.vault_ref_pinned_rel) {
      await check(
        () => vr.resolved_rel === args.vault_ref_pinned_rel,
        '定位结果与批准目标不一致，请重新授权',
      )
    }
    articleDir = vr.resolved_path
    log('vault 定位(article_name 回落): ' + args.article_name + ' -> ' + vr.resolved_rel)
  }
}

const checkArgs = (articleDir
  ? '--article-dir "' + articleDir + '"'
  : '--locate "' + (args.article_name || '') + '"' + (args.workspace_dir ? ' --workspace "' + args.workspace_dir + '"' : ''))
  + (args.account_slot ? ' --account-slot ' + args.account_slot : '')

const runCheckCmd = PY_PROBE + '; "$PY" "' + CHECK_SCRIPT + '" ' + checkArgs

phase('状态检查')
const inspectResult = await agent(
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

if (!inspectResult.ok) {
  await notify('failed', '文章处理失败(定位阶段):' + (inspectResult.issues || []).join(';'))
  const cand = (() => { try { return JSON.parse(inspectResult.raw).candidates || [] } catch { return [] } })()
  return {
    ok: false, article_dir: '', inserted: 0, media_id: '', draft_mode: '', reused: false,
    report: '定位失败: ' + (inspectResult.issues || []).join('; '),
    issues: inspectResult.issues || [], candidates: cand,
  }
}

articleDir = inspectResult.article_dir || articleDir
const accs = inspectResult.state_accounts || {}
const pendingAcc = Object.keys(accs).filter(k => accs[k].hasPending)

// ---------- 配图序号预检（IMG-L 2026-10-28：序号=章节号，跳号=无图章节合法不中断；越界仍中断） ----------
const numbering = (() => { try { return (JSON.parse(inspectResult.raw) || {}).imgs_numbering || null } catch { return null } })()
const numOor = (numbering && numbering.out_of_range) || []
if (inspectResult.needs_insert && numbering && numbering.applicable && numOor.length) {
  const why = ['序号越界: ' + numOor.join('、') + ' 超出章节数 ' + numbering.sections]
  const msg = '配图序号检查未通过（' + why.join('；') + '）。已中断，请在 Obsidian 补齐缺失配图或重命名序号后重试'
  await notify('failed', '文章处理失败(序号预检):' + msg)
  return {
    ok: false, article_dir: articleDir, inserted: 0, media_id: '', draft_mode: '', reused: false,
    report: msg, issues: ['配图序号缺失: ' + numMissing.join(','), '配图序号越界: ' + numOor.join(',')],
  }
}

// ---------- 手动插图检测（Obsidian wiki 内嵌, 2026-10-26） ----------
// check_state 已把 wiki 内嵌计入 referenced(needs_insert=false)：手动插图文章不走自动插图，
// 只需把 ![[图]] 链接确定性规范化为公众号格式(零 LLM,不改图片位置)。标准引用格式的手动插图
// 由原「配图已就绪」路径天然覆盖，无需本分支。
const imgsInfo = (() => { try { return (JSON.parse(inspectResult.raw) || {}).imgs || {} } catch { return {} } })()
const manualWiki = imgsInfo.wiki_embeds || 0
const manualMode = manualWiki > 0

// 手动插图封面预检（2026-10-26）：封面只能由文件名约定告知（根 cover.* 或 imgs/ cover 前缀），
// 手动插图无法其它方式声明；公众号草稿必须带封面。缺封面在授权前中断并指引重命名，
// 不浪费一次授权+规范化周期（与序号预检同理）。
if (manualMode && !inspectResult.cover_path) {
  const msg = '手动插图缺少封面：imgs/ 下没有 cover 开头的图片文件，而公众号草稿必须带封面。' +
    '请在 Obsidian 中把选定的封面图重命名为 cover-开头（如 cover-主题.png，放 imgs/ 下）后重试。' +
    '本次未做任何修改（链接规范化尚未执行）'
  await notify('failed', '文章处理失败(封面预检):' + msg)
  return {
    ok: false, article_dir: articleDir, inserted: 0, manual_normalized: false,
    media_id: '', draft_mode: '', reused: false,
    report: msg, issues: ['封面缺失: imgs/ 无 cover 前缀图（手动插图模式）'],
  }
}

await notify('info', '检查完成:《' + (inspectResult.md && inspectResult.md.name ? inspectResult.md.name : articleDir) + '》' +
  (manualMode
    ? '检测到手动插图(' + manualWiki + ' 处 Obsidian 链接),将规范化图片链接后入草稿箱(不自动插图)'
    : (inspectResult.needs_insert ? '有未引用配图待插入' : '配图已就绪') + '，即将' + (inspectResult.needs_insert ? '插图并' : '') + '入草稿箱'))

// ---------- 一次授权（网关批准链生效时可 skip_confirm 透传） ----------
if (args.skip_confirm !== true) {
  await checkpoint(
    '即将处理文章: ' + articleDir + '\n' +
    '账号槽位: ' + (args.account_slot || 1) + '\n' +
    '计划步骤:\n' +
    (manualMode
      ? '  1. 图片: 手动插图模式——跳过自动插图,仅把 Obsidian ![[图]] 链接规范化为公众号格式(不改图片位置;补缺失元数据)\n'
      : inspectResult.needs_insert ? '  1. 插图: imgs 有未引用配图,按图片序号/语义匹配插入(不改写正文;已存在相同图跳过,错图替换)\n' : '  1. 插图: 跳过(无未引用配图)\n') +
    '  2. 草稿: 调 publish.py 建/更新草稿' +
      (pendingAcc.length ? '(注意: 账号 ' + pendingAcc.join(',') + ' 有未决操作,将先人工核对再继续)\n' : '\n') +
    '说明: 会修改文章目录内文件(插图标记/article.yaml/publish-state.json),并调用微信 API。\n' +
    '允许=执行; 拒绝=终止。'
  )
}

// ---------- 按需插图（复用既有插图流程: 语义匹配必须靠 AI; 默认不改写正文） ----------
let inserted = 0
let manualNormalized = false
if (manualMode) {
  // 手动插图模式: 确定性规范化链接(command 直跑,零 LLM; 参照 videodigest 执行器演进 2026-10-26)
  phase('手动插图规范化')
  let pyExec = ''
  for (const cand of ['python3', 'python', 'py']) {
    const probe = await command({ executable: cand, args: ['-c', 'import sys'], label: '探测 python(' + cand + ')' })
    if (probe.exitCode === 0) { pyExec = cand; break }
  }
  if (!pyExec) throw new Error('PATH 上无可用 Python 解释器(python3/python/py 均试运行失败)')
  const nr = await command({ executable: pyExec, args: [NORMALIZE_SCRIPT, '--article-dir', articleDir], label: '手动插图规范化' })
  log('规范化 stdout:\n' + nr.stdout)
  if (nr.exitCode !== 0) {
    const why = ((nr.stderr || '') + ' ' + (nr.stdout || '')).slice(0, 400)
    await notify('failed', '文章处理失败(手动插图规范化):' + why)
    return {
      ok: false, article_dir: articleDir, inserted: 0, media_id: '', draft_mode: '', reused: false,
      manual_normalized: false,
      report: '手动插图链接规范化失败: ' + why, issues: ['normalize_failed: ' + why],
    }
  }
  manualNormalized = true
  await notify('info', '手动插图:图片链接已规范化为公众号格式(未自动插图,图片位置不变)')
} else if (inspectResult.needs_insert) {
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
const inspectResult2 = await agent(
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

if (!inspectResult2.prepare_ready) {
  await notify('failed', '文章处理失败(就绪检查):' + (inspectResult2.issues || []).join(';'))
  return {
    ok: false, article_dir: articleDir, inserted,
    media_id: '', draft_mode: '', reused: false,
    report: 'prepare 就绪检查未通过: ' + (inspectResult2.issues || []).join('; '),
    issues: inspectResult2.issues || [],
  }
}

// ---------- 建或更新草稿（显式参数,发布脚本不猜——V1.2 5.2） ----------
const yamlTitle = (inspectResult2.yaml && inspectResult2.yaml.title) || ''
const yamlDigest = (inspectResult2.yaml && inspectResult2.yaml.digest) || ''
const yamlAuthor = (inspectResult2.yaml && inspectResult2.yaml.author) || ''
const mdPath = (inspectResult2.md && inspectResult2.md.path) || ''
const coverPath = inspectResult2.cover_path || ''

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
    (manualMode ? ',手动插图链接已规范化' : ',插图 ' + inserted + ' 张') +
    ',media_id=' + String(pub.media_id).slice(-12) + '),可到公众号后台预览')
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
  '\n文章: ' + articleDir + '\n插图: ' + inserted + ' 张' + (manualMode ? '（手动插图模式,链接已规范化）' : '')

return {
  ok: okResult,
  article_dir: articleDir,
  inserted,
  manual_normalized: manualNormalized,
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
