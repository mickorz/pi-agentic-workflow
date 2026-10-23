export const meta = {
  name: 'article_inspect',
  description: '文章只读巡检: 定位文章目录(显式路径或按名称唯一命中) -> 执行确定性只读检查脚本 check_state.py -> 输出状态报告(正文/yaml/配图/封面/草稿状态/缺失清单)。零写文件、零微信 API。对应需求文档 V1.2 第 4.1 节 inspect 模式。',
}

// 输入 args:
//   article_dir    : 文章目录绝对路径(与 article_name 二选一,优先)
//   article_name   : 按名称在工作区定位(唯一命中才检查,多候选返回列表)
//   workspace_dir  : 工作区根(缺省读 config.json 的 article_workspace)
//   account_slot   : 账号槽位(默认 1,仅影响状态摘要)
// 输出: { ok, article_dir, report, issues[], raw }

const SCRIPT = 'dev-examples/wx-article/scripts/draft_manager/check_state.py'

// Python 解释器真探测:command -v 在 Windows 会命中 Store 占位符(存在但必败,见
// experience/windows-python-subprocess-gbk-and-python3-alias.md),必须试运行验证
const PY_PROBE = 'PY=""; for c in python3 python py; do if "$c" -c "import sys" 2>/dev/null; then PY="$c"; break; fi; done; [ -n "$PY" ] || { echo "[FAIL] no usable python on PATH"; exit 49; }'

phase('确定性检查')
const locateArgs = args.article_dir
  ? '--article-dir "' + args.article_dir + '"'
  : '--locate "' + (args.article_name || '') + '"' + (args.workspace_dir ? ' --workspace "' + args.workspace_dir + '"' : '')
const cmd = PY_PROBE + '; "$PY" "' + SCRIPT + '" ' + locateArgs +
  (args.account_slot ? ' --account-slot ' + args.account_slot : '')

// 受控检查: 唯一动作是执行只读脚本并透传 stdout JSON(脚本本身零写零网络,
// 只读性由 check_state.py 实现保证; Agent 不做任何其他文件操作)
const check = await agent(
  '你是只读检查执行器。用 bash 工具执行恰好一条命令, 把 stdout 原样解析为 JSON 返回, 不做任何其他操作:\n\n' +
  cmd + '\n\n' +
  '禁止: 写/改/删任何文件, 调任何网络接口, 执行上述命令之外的任何命令。\n' +
  '返回 JSON: { raw(脚本 stdout 原文), ok, article_dir, needs_insert, prepare_ready, ' +
  'yaml_missing[](yaml.missing), cover_state(cover.state), issues[](issues 数组), ' +
  'state_accounts(state.accounts 对象原样), md_name }。',
  { label: '检查', agentType: 'general', schema: {
    type: 'object',
    properties: {
      raw: { type: 'string' },
      ok: { type: 'boolean' },
      article_dir: { type: 'string' },
      needs_insert: { type: 'boolean' },
      prepare_ready: { type: 'boolean' },
      yaml_missing: { type: 'array', items: { type: 'string' } },
      cover_state: { type: 'string' },
      issues: { type: 'array', items: { type: 'string' } },
      state_accounts: { type: 'object' },
      md_name: { type: 'string' },
    },
    required: ['raw', 'ok'],
  } }
)

phase('状态报告')
let parsed = {}
try { parsed = JSON.parse(check.raw) } catch { /* 保持空, 下游用 issues 兜底 */ }

const lines = []
lines.push('文章: ' + (parsed.article_dir || args.article_dir || args.article_name || '?'))
lines.push('正文: ' + (parsed.md && parsed.md.name ? parsed.md.name : '(未定位)'))
lines.push('元数据: yaml ' + (parsed.yaml && parsed.yaml.exists ? '存在' : '缺失') +
  (parsed.yaml && parsed.yaml.missing && parsed.yaml.missing.length ? '，缺 ' + parsed.yaml.missing.join('/') : '，title/digest 齐全'))
lines.push('配图: imgs 文件 ' + (parsed.imgs ? parsed.imgs.files : '?') + ' 张，正文引用 ' + (parsed.imgs ? parsed.imgs.referenced : '?') + ' 张' +
  (check.needs_insert ? '（有未插图，需插图流程）' : ''))
lines.push('封面: ' + (check.cover_state === 'root' ? '目录根 cover.*' : check.cover_state === 'imgs' ? 'imgs/ 下 cover 前缀图' : '缺失'))
const accs = check.state_accounts || {}
const accKeys = Object.keys(accs)
lines.push('草稿状态: ' + (accKeys.length ? accKeys.map(k => k + '=' + accs[k].status + (accs[k].hasPending ? '(有未决操作,需人工核对)' : '')).join('; ') : '尚无发布记录'))
const issues = check.issues || []
lines.push('问题清单: ' + (issues.length ? issues.join('; ') : '无'))
lines.push('prepare 就绪: ' + (check.prepare_ready ? '是' : '否'))

const report = lines.join('\n')
log(report)

return {
  ok: check.ok === true,
  article_dir: check.article_dir || parsed.article_dir || '',
  report,
  issues,
  raw: check.raw,
}
