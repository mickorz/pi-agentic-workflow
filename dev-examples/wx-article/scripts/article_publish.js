export const meta = {
  name: 'article_publish',
  description: '文章公开发表(基于已有草稿): 状态检查确认 drafted 且内容未变 -> 独立授权 checkpoint(不复用 prepare 批准) -> freepublish/submit 提交 -> freepublish/get 轮询确认后才记 published。不重新上传整篇;群发推送(message/mass)不在本流程。对应需求文档 V1.2 publish 模式。',
}

// 输入 args:
//   article_dir    : 文章目录绝对路径(定位通道之一)
//   vault_ref      : Obsidian 逻辑引用(定位通道之二): 文章名或 vault 相对路径(如 AI提问技巧 或 公众号/AI入门/AI提问技巧),
//                    服务端 vault_resolver 确定性解析(want=article);歧义列候选不猜(VR S3.2)
//   vault_scope    : 限定搜索范围(vault 相对目录或配置别名,可选,硬约束)
//   vault_ref_pinned_rel : 审批锚点(vault 相对路径;服务端审批链注入,外部传入仅作一致性比对)
//   article_name   : 按名称在工作区定位(定位通道之三,唯一命中才继续)
//   workspace_dir  : 工作区根(可选)
//   account_slot   : 账号槽位(默认 1)
//   skip_confirm   : 跳过授权 checkpoint(仅在外层已获有效授权时透传,如微信网关批准链;
//                    公开发表是高风险动作,没有外层授权链时必须人工确认)
//   mock / mock_store / inject : 测试透传(生产不传)
// 输出: { ok, article_dir, publish_id, status(published|publishing|unknown|failed|rejected), report, issues }

const CHECK_SCRIPT = 'dev-examples/wx-article/scripts/draft_manager/check_state.py'
const PUBLISH_SCRIPT = 'dev-examples/wx-article/scripts/draft_manager/publish.py'

// Python 解释器真探测(Store 占位符问题,见 experience/windows-python-subprocess-gbk-and-python3-alias.md)
const PY_PROBE = 'PY=""; for c in python3 python py; do if "$c" -c "import sys" 2>/dev/null; then PY="$c"; break; fi; done; [ -n "$PY" ] || { echo "[FAIL] no usable python on PATH"; exit 49; }'

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

const checkArgs = (articleDir
  ? '--article-dir "' + articleDir + '"'
  : '--locate "' + (args.article_name || '') + '"' + (args.workspace_dir ? ' --workspace "' + args.workspace_dir + '"' : ''))
  + (args.account_slot ? ' --account-slot ' + args.account_slot : '')

phase('状态检查')
const inspectResult = await agent(
  '你是只读检查执行器。用 bash 工具执行恰好一条命令, 把 stdout 原样解析为 JSON 返回, 不做任何其他操作:\n\n' +
  PY_PROBE + '; "$PY" "' + CHECK_SCRIPT + '" ' + checkArgs + '\n\n' +
  '禁止: 写/改/删任何文件, 调任何网络接口, 执行上述命令之外的任何命令。\n' +
  '返回 JSON: { raw(脚本 stdout 原文), ok, article_dir, cover_path(cover.path,相对文章目录), issues[](issues 数组), state_accounts(state.accounts 对象原样) }。',
  { label: '检查', agentType: 'general', schema: {
    type: 'object',
    properties: {
      raw: { type: 'string' },
      ok: { type: 'boolean' },
      article_dir: { type: 'string' },
      cover_path: { type: 'string' },
      issues: { type: 'array', items: { type: 'string' } },
      state_accounts: { type: 'object' },
    },
    required: ['raw', 'ok', 'article_dir'],
  } }
)

if (!inspectResult.ok) {
  return {
    ok: false, article_dir: '', publish_id: '', status: 'rejected',
    report: '定位失败: ' + (inspectResult.issues || []).join('; '), issues: inspectResult.issues || [],
  }
}

articleDir = inspectResult.article_dir || articleDir
const accs = inspectResult.state_accounts || {}
const slotKey = 'slot' + (args.account_slot || 1)
// check_state 的 accounts 键是真实 appid,无法在此预知;任一账号 pending 都阻断
const pendingAccs = Object.keys(accs).filter(k => accs[k].hasPending)
const draftedAccs = Object.keys(accs).filter(k => accs[k].status === 'drafted')
const publishedAccs = Object.keys(accs).filter(k => accs[k].status === 'published')

// 前置拦截(不发外部请求):无草稿/已发表/有未决操作,均属 rejected,直接返回
if (draftedAccs.length === 0 || pendingAccs.length > 0) {
  const why = pendingAccs.length
    ? '账号 ' + pendingAccs.join(',') + ' 有未决操作,需先人工核对恢复(--resolve-media-id/--resolve-publish-id/--clear-pending)'
    : (publishedAccs.length && !draftedAccs.length
      ? '该文章已公开发表,重复发表被拒绝'
      : '无可发表草稿(status 非 drafted),请先运行 article-prepare 创建/更新草稿')
  return {
    ok: false, article_dir: articleDir, publish_id: '', status: 'rejected',
    report: '无法发表: ' + why, issues: [why],
  }
}

// ---------- 独立授权(公开发表不复用 prepare 批准,V1.2 审批原则) ----------
if (args.skip_confirm !== true) {
  await checkpoint(
    '即将公开发表文章(发表后粉丝可见,且草稿将从草稿箱移除,动作不可自动撤销):\n' +
    '文章: ' + articleDir + '\n' +
    '账号槽位: ' + (args.account_slot || 1) + '\n' +
    (publishedAccs.length ? '注意: 账号 ' + publishedAccs.join(',') + ' 此前已发表过该文,本次针对 drafted 账号。\n' : '') +
    '方式: 基于已有草稿 media_id 提交 freepublish(公开发表,不主动推送粉丝);提交后经 freepublish/get 确认成功才记 published。\n' +
    '允许=执行; 拒绝=终止。'
  )
}

// ---------- 提交与确认 ----------
const mockArgs = (args.mock ? ' --mock' : '') +
  (args.mock_store ? ' --mock-store "' + args.mock_store + '"' : '') +
  (args.inject ? ' --inject "' + args.inject + '"' : '')

const cmd = PY_PROBE + '; "$PY" "' + PUBLISH_SCRIPT + '"' +
  ' --article-dir "' + articleDir + '"' +
  ' --cover "' + (inspectResult.cover_path || 'cover.png') + '"' +
  ' --account-slot ' + (args.account_slot || 1) +
  ' --freepublish' + mockArgs

phase('提交发表')
const pub = await agent(
  '你是发表执行者。用 bash 工具执行恰好一条命令(发表脚本,Python 标准库实现):\n\n' +
  cmd + '\n\n' +
  '脚本行为: 校验状态为 drafted 且内容 Hash 未变(否则拒绝,提示先 prepare) -> draft/get 远端核对 -> ' +
  'freepublish/submit -> 轮询 freepublish/get,确认成功才写 published。\n' +
  'stdout 契约: "[PUBLISHED] publish_id=xxx" + "=== ALL DONE publish_id=xxx ===" 表示发表成功; ' +
  '"[PUBLISHING] publish_id=xxx ..." 表示已受理微信侧仍在发表中(退出码 0,稍后重跑 --publish-status 确认); ' +
  '"[FAIL] ..." 退出码 1 明确失败; "[UNKNOWN] ..." 退出码 2 需人工核对; "[LOCKED] ..." 退出码 3 文章被其他任务占用。\n' +
  '按退出码与原文返回,不重试,不额外操作。\n' +
  '返回 JSON: { exit_code, stdout_tail(最后 15 行原文), publish_id, published(bool,PUBLISHED 行), publishing(bool,PUBLISHING 行), unknown(bool), locked(bool), fail_line(首个 [FAIL] 行,无则空) }。',
  { label: '发表', agentType: 'general', schema: {
    type: 'object',
    properties: {
      exit_code: { type: 'number' },
      stdout_tail: { type: 'string' },
      publish_id: { type: 'string' },
      published: { type: 'boolean' },
      publishing: { type: 'boolean' },
      unknown: { type: 'boolean' },
      locked: { type: 'boolean' },
      fail_line: { type: 'string' },
    },
    required: ['exit_code', 'publish_id', 'published', 'publishing', 'unknown', 'locked'],
  } }
)

let status = 'failed'
let report = ''
if (pub.published) {
  status = 'published'
  report = '已公开发表: publish_id=' + pub.publish_id + '(草稿已从草稿箱移除,可公众号后台查看群发/发表记录)'
} else if (pub.publishing) {
  status = 'publishing'
  report = '已受理,微信侧发表中: publish_id=' + pub.publish_id + ';稍后重跑本流程(或 --publish-status)确认终态'
} else if (pub.unknown) {
  status = 'unknown'
  report = '结果不确定: 请人工在公众号后台核对后,按 [UNKNOWN] 提示用 --resolve-publish-id/--clear-pending 恢复'
} else if (pub.locked) {
  status = 'rejected'
  report = '文章正被其他任务处理,稍后重试'
} else {
  report = '发表失败: ' + (pub.fail_line || '未知(草稿保留,修复后可重试)')
}
log(report)

return {
  ok: status === 'published' || status === 'publishing',
  article_dir: articleDir,
  publish_id: pub.publish_id || '',
  status,
  report,
  issues: status === 'published' ? [] : [report],
}
