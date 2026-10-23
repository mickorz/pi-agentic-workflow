export const meta = {
  name: 'article_inspect',
  description: '文章只读巡检: 定位文章目录(显式路径或按名称唯一命中) -> 执行确定性只读检查脚本 check_state.py -> 输出状态报告(正文/yaml/配图/封面/草稿状态/缺失清单)。零写文件、零微信 API。对应需求文档 V1.2 第 4.1 节 inspect 模式。',
}

// 输入 args:
//   article_dir    : 文章目录绝对路径(三通道至少一,优先)
//   vault_ref      : Obsidian 逻辑引用(文章名或 vault 相对路径; runtime 原生 vaultResolve 确定性解析,
//                    零 LLM 零 shell 拼接; want=article 语义见 vault_resolver.py)
//   vault_scope    : 限定搜索范围(vault 相对目录或别名,可选,硬约束)
//   vault_ref_pinned_rel : 服务端审批锚点(facade 预检注入; 执行时新鲜解析与锚点比对,
//                    不一致即失败——防「批准 A 执行 B」; 外部传入会被服务端覆盖,不信任)
//   article_name   : 按名称在工作区定位(唯一命中才检查,多候选返回列表)
//   workspace_dir  : 工作区根(缺省读 config.json 的 article_workspace)
//   account_slot   : 账号槽位(默认 1,仅影响状态摘要)
// 输出: { ok, article_dir, report, issues[], raw }

const SCRIPT = 'dev-examples/wx-article/scripts/draft_manager/check_state.py'

// Python 解释器真探测:command -v 在 Windows 会命中 Store 占位符(存在但必败,见
// experience/windows-python-subprocess-gbk-and-python3-alias.md),必须试运行验证
const PY_PROBE = 'PY=""; for c in python3 python py; do if "$c" -c "import sys" 2>/dev/null; then PY="$c"; break; fi; done; [ -n "$PY" ] || { echo "[FAIL] no usable python on PATH"; exit 49; }'

phase('文章定位')
let articleDir = args.article_dir || ''
if (!articleDir && args.vault_ref) {
  // VR S3.2 接线模式: 原生确定性解析 -> await check(失败即 FAILURE,绝不带病执行)
  const r = await vaultResolve(args.vault_ref, { scope: args.vault_scope, want: 'article' })
  await check(
    () => r.ok === true,
    '文章定位失败: ' + JSON.stringify({ issues: r.issues, candidates: r.candidates })
  )
  // 审批锚点比对: 批准时定位的目标与执行时不同 -> 中止要求重新授权(批准 A 绝不执行 B)
  if (args.vault_ref_pinned_rel) {
    await check(
      () => r.resolved_rel === args.vault_ref_pinned_rel,
      '定位结果与批准目标不一致，请重新授权'
    )
  }
  articleDir = r.resolved_path
  log('vault 定位: ' + args.vault_ref + ' -> ' + r.resolved_rel)
}

phase('确定性检查')
const locateArgs = articleDir
  ? '--article-dir "' + articleDir + '"'
  : '--locate "' + (args.article_name || '') + '"' + (args.workspace_dir ? ' --workspace "' + args.workspace_dir + '"' : '')
const cmd = PY_PROBE + '; "$PY" "' + SCRIPT + '" ' + locateArgs +
  (args.account_slot ? ' --account-slot ' + args.account_slot : '')

// 受控检查: 唯一动作是执行只读脚本并透传 stdout JSON(脚本本身零写零网络,
// 只读性由 check_state.py 实现保证; Agent 不做任何其他文件操作)
// 注意: 局部变量命名避开 DSL 内建 check()（同名 const 会 TDZ 遮蔽内建函数,定位阶段 await check() 会抛
// ReferenceError: Cannot access 'check' before initialization —— 见 tests/unit/vr-approval.test.ts 接线测试）
const inspectResult = await agent(
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
try { parsed = JSON.parse(inspectResult.raw) } catch { /* 保持空, 下游用 issues 兜底 */ }

const lines = []
lines.push('文章: ' + (parsed.article_dir || args.article_dir || args.article_name || '?'))
lines.push('正文: ' + (parsed.md && parsed.md.name ? parsed.md.name : '(未定位)'))
lines.push('元数据: yaml ' + (parsed.yaml && parsed.yaml.exists ? '存在' : '缺失') +
  (parsed.yaml && parsed.yaml.missing && parsed.yaml.missing.length ? '，缺 ' + parsed.yaml.missing.join('/') : '，title/digest 齐全'))
lines.push('配图: imgs 文件 ' + (parsed.imgs ? parsed.imgs.files : '?') + ' 张，正文引用 ' + (parsed.imgs ? parsed.imgs.referenced : '?') + ' 张' +
  (inspectResult.needs_insert ? '（有未插图，需插图流程）' : ''))
lines.push('封面: ' + (inspectResult.cover_state === 'root' ? '目录根 cover.*' : inspectResult.cover_state === 'imgs' ? 'imgs/ 下 cover 前缀图' : '缺失'))
const accs = inspectResult.state_accounts || {}
const accKeys = Object.keys(accs)
lines.push('草稿状态: ' + (accKeys.length ? accKeys.map(k => k + '=' + accs[k].status + (accs[k].hasPending ? '(有未决操作,需人工核对)' : '')).join('; ') : '尚无发布记录'))
const issues = inspectResult.issues || []
lines.push('问题清单: ' + (issues.length ? issues.join('; ') : '无'))
lines.push('prepare 就绪: ' + (inspectResult.prepare_ready ? '是' : '否'))

const report = lines.join('\n')
log(report)

return {
  ok: inspectResult.ok === true,
  article_dir: inspectResult.article_dir || parsed.article_dir || '',
  report,
  issues,
  raw: inspectResult.raw,
}
