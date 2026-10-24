export const meta = {
  name: 'article_image_generate',
  description: '公众号文章批量生图: 零LLM校验计划 → 一次授权 → 顺序生成(文章锁+manifest断点续跑) → 零LLM双向核验 → 标准报告。执行器 image_gen/generate.mjs(Node 例外区,已登记CLAUDE.md)。',
}

// 输入 args:
//   article_dir      : 文章目录绝对路径(必填,含 image-prompts.json)
//   provider         : fake | pi-image-gen | pi-ai | <模块路径>(默认 pi-image-gen; 测试用 fake)
//   model            : 模型 id(可选,默认取执行器/provider 配置)
//   only_ids         : 只处理子集(逗号分隔)
//   retry_failed     : true 时重试 failed 条目
//   force_regenerate : true 时 succeeded 也重生成(走 candidate 链,原图隔离)
//   continue_on_error: true 时单图失败继续
//   max_retries      : 可恢复错误最大重试(默认 2)
//   dry_run          : true 只出计划
//   manifest         : manifest 覆盖路径
//   style_reference  : 风格参考图路径
//   promote          : 提升 ready 候选 id
//   skip_confirm     : 跳过授权 checkpoint(仅外层已获有效授权时透传,如微信网关批准链)
//   exec_timeout_ms  : 生成阶段超时(默认 30 分钟; 9 图×真实耗时上界)
// 输出: { ok, article_dir, total, succeeded, failed, pending, manifest_path,
//         generated_paths, failed_ids, pending_ids, plan, verify, locked? }

const GEN = 'dev-examples/wx-article/scripts/image_gen/generate.mjs'

const genArgs = () => {
  const a = ['--article-dir', String(args.article_dir), '--provider', String(args.provider || 'pi-image-gen')]
  if (args.model) a.push('--model', String(args.model))
  if (args.manifest) a.push('--manifest', String(args.manifest))
  if (args.only_ids) a.push('--only-ids', String(args.only_ids))
  if (args.retry_failed === true) a.push('--retry-failed')
  if (args.force_regenerate === true) a.push('--force-regenerate')
  if (args.continue_on_error === true) a.push('--continue-on-error')
  if (typeof args.max_retries === 'number') a.push('--max-retries', String(args.max_retries))
  if (args.style_reference) a.push('--style-reference', String(args.style_reference))
  if (args.promote) a.push('--promote', String(args.promote))
  return a
}

// stdout 契约解析: 取最后一个 [TAG] 行的 JSON 负载
const tagLine = (stdout, tag) => {
  const lines = String(stdout).split('\n').filter((l) => l.startsWith(tag))
  if (!lines.length) throw new Error('执行器输出缺少 ' + tag + ' 行:\n' + String(stdout).slice(0, 2000))
  return JSON.parse(lines[lines.length - 1].slice(tag.length))
}

// ---------- 1. 零 LLM 校验计划 ----------
phase('校验计划')
const planRun = await command({
  executable: 'node',
  args: [GEN, ...genArgs(), '--dry-run'],
  timeoutMs: 120000,
  label: 'image-gen-dry-run',
})
if (planRun.exitCode !== 0) {
  const fail = String(planRun.stdout).split('\n').find((l) => l.startsWith('[FAIL]')) || planRun.stderr || 'unknown'
  throw new Error('校验失败(exit ' + planRun.exitCode + '): ' + fail)
}
const plan = tagLine(planRun.stdout, '[PLAN] ')
const toRun = plan.items.filter((x) => x.action === 'run-main' || x.action === 'run-candidate')

// ---------- 2. 一次授权（微信批准链可 skip_confirm 透传；无事可做则免打扰） ----------
if (args.skip_confirm !== true && toRun.length > 0) {
  await checkpoint(
    '即将批量生成文章插图: ' + args.article_dir + '\n' +
    'Provider: ' + (args.provider || 'pi-image-gen') + (args.model ? ' / ' + args.model : '') + '\n' +
    '计划: ' + toRun.length + ' / ' + plan.items.length + ' 张需要生成(' +
      toRun.map((x) => x.id + '(' + (x.action === 'run-candidate' ? '重做·候选隔离' : '新生成') + ')').join(', ') + ')\n' +
    '说明: 会写文章目录 imgs/、cover、image-manifest.json,并持有文章锁至完成;费用按实际生成张数计。\n' +
    '允许=执行; 拒绝=终止。'
  )
}

// ---------- 3. 批量生成（dry_run 到此为止） ----------
let result = null
if (args.dry_run === true || toRun.length === 0) {
  result = {
    ok: true, article_dir: args.article_dir, total: plan.items.length, succeeded: plan.items.length - toRun.length,
    failed: 0, pending: toRun.length, manifest_path: null, generated_paths: [],
    failed_ids: [], pending_ids: toRun.map((x) => x.id), dry_run: args.dry_run === true, nothing_to_do: toRun.length === 0,
  }
} else {
  phase('批量生成')
  const gen = await command({
    executable: 'node',
    args: [GEN, ...genArgs()],
    timeoutMs: typeof args.exec_timeout_ms === 'number' ? args.exec_timeout_ms : 30 * 60 * 1000,
    label: 'image-gen',
  })
  if (gen.exitCode === 3) {
    // [LOCKED]: 别的进程在处理该文章(生图/插图/发布互斥),不是失败,交上层择机重试
    const locked = String(gen.stdout).split('\n').find((l) => l.startsWith('[LOCKED]')) || '[LOCKED]'
    console.log('image_generate locked: ' + locked)
    return { ok: false, locked: true, reason: locked, article_dir: args.article_dir }
  }
  if (gen.exitCode === 2) {
    const fail = String(gen.stdout).split('\n').find((l) => l.startsWith('[FAIL]')) || gen.stderr
    throw new Error('执行器拒绝: ' + fail)
  }
  result = tagLine(gen.stdout, '[RESULT] ')
}

// ---------- 4. 零 LLM 双向核验（最终 ok 的事实源） ----------
phase('确定性核验')
let verify = { ok: true, checked: 0, problems: [], warnings: [] }
if (result.manifest_path) {
  const ver = await command({
    executable: 'node',
    args: [GEN, '--article-dir', String(args.article_dir), '--verify-only'],
    timeoutMs: 120000,
    label: 'image-gen-verify',
  })
  verify = tagLine(ver.stdout, '[RESULT] ')
  verify.exit_code = ver.exitCode
}

const ok = result.ok === true && verify.ok === true
console.log('image_generate done: ok=' + ok + ' succeeded=' + result.succeeded + '/' + result.total +
  (verify.problems && verify.problems.length ? ' verify-problems=' + verify.problems.length : ''))

return { ...result, verify, ok }
