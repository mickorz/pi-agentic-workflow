export const meta = {
  name: 'article_image_generate',
  description: '公众号两阶段生图(P1.5): preview 试生成1张→风格确认→batch 批量(风格审批门+预算+断点续跑)→零LLM核验; regenerate 单张重做(候选隔离)。执行器 image_gen/generate.mjs(Node 例外区,已登记CLAUDE.md)。',
}

// 输入 args:
//   article_dir      : 文章目录绝对路径(必填,含 image-prompts.json)
//   mode             : preview | batch | regenerate (默认 batch)
//   provider         : fake | pi-image-gen | pi-ai | <模块路径>(默认 pi-image-gen; 测试用 fake)
//   model            : 模型 id(可选,默认取执行器/provider 配置)
//   preview_id       : preview 模式代表条目 id(可选,默认首个 body)
//   only_ids         : 只处理子集(逗号分隔; regenerate 模式必填)
//   retry_failed     : true 时重试 failed 条目
//   retry_unknown    : true 时人工确认后重试 unknown(扣费不确定)条目
//   force_regenerate : true 时 succeeded 也重生成(走 candidate 链,原图隔离)
//   continue_on_error: true 时单图失败继续(扣费不确定例外:一律暂停)
//   max_retries      : (废弃)可恢复错误最大重试
//   max_attempts_per_image : 单张最多请求次数含首次(默认 3)
//   max_images_per_run     : 单次运行张数硬上限(超出留 pending 分批再跑)
//   price_cny        : 单张单价(默认环境变量 IMAGE_GEN_PRICE_PER_IMAGE)
//   budget_cny       : 预算硬门,最坏估算超预算拒绝执行
//   dry_run          : true 只出计划
//   manifest         : manifest 覆盖路径
//   style_reference  : 风格参考图路径
//   promote          : 提升 ready 候选 id
//   skip_confirm     : 跳过付费执行授权 checkpoint(仅外层已获有效授权时透传,如微信网关批准链;
//                      不豁免风格确认——两种确认必须分离,需求第四节)
//   style_approved   : 预批准风格(仅供自动化/测试;正式链路应经风格确认 checkpoint)
//   exec_timeout_ms  : 生成阶段超时(默认 30 分钟; 9 图×真实耗时上界)
// 输出: { ok, mode, article_dir, total, succeeded, failed, pending, unknown?, manifest_path,
//         generated_paths, failed_ids, pending_ids, plan, verify, style_approval?, locked? }

const GEN = 'dev-examples/wx-article/scripts/image_gen/generate.mjs'

const genArgs = () => {
  const a = ['--article-dir', String(args.article_dir), '--provider', String(args.provider || 'pi-image-gen')]
  a.push('--mode', String(args.mode || 'batch'))
  if (args.model) a.push('--model', String(args.model))
  if (args.manifest) a.push('--manifest', String(args.manifest))
  if (args.only_ids) a.push('--only-ids', String(args.only_ids))
  if (args.retry_failed === true) a.push('--retry-failed')
  if (args.retry_unknown === true) a.push('--retry-unknown')
  if (args.force_regenerate === true) a.push('--force-regenerate')
  if (args.continue_on_error === true) a.push('--continue-on-error')
  if (typeof args.max_attempts_per_image === 'number') a.push('--max-attempts-per-image', String(args.max_attempts_per_image))
  else if (typeof args.max_retries === 'number') a.push('--max-retries', String(args.max_retries))
  if (typeof args.max_images_per_run === 'number') a.push('--max-images-per-run', String(args.max_images_per_run))
  if (typeof args.price_cny === 'number') a.push('--price-cny', String(args.price_cny))
  if (typeof args.budget_cny === 'number') a.push('--budget-cny', String(args.budget_cny))
  if (args.style_reference) a.push('--style-reference', String(args.style_reference))
  if (args.promote) a.push('--promote', String(args.promote))
  if (args.preview_id) a.push('--preview-id', String(args.preview_id))
  return a
}

// stdout 契约解析: 取最后一个 [TAG] 行的 JSON 负载
const tagLine = (stdout, tag) => {
  const lines = String(stdout).split('\n').filter((l) => l.startsWith(tag))
  if (!lines.length) throw new Error('执行器输出缺少 ' + tag + ' 行:\n' + String(stdout).slice(0, 2000))
  return JSON.parse(lines[lines.length - 1].slice(tag.length))
}

const failLine = (stdout) => String(stdout).split('\n').find((l) => l.startsWith('[FAIL]')) || ''

const runGen = (genArgsList, timeoutMs, label) =>
  command({
    executable: 'node',
    args: [GEN, ...genArgsList],
    timeoutMs,
    label,
  })

const costText = (cost) =>
  cost ? '\n费用估算: ' + cost.images + ' 张 × ¥' + cost.price_cny + ' (单张) → 一次成功 ¥' + cost.est_min_cny + ' ~ 最坏(含重试) ¥' + cost.est_max_cny : ''

const MODE = String(args.mode || 'batch')
if (MODE !== 'preview' && MODE !== 'batch' && MODE !== 'regenerate') {
  throw new Error('mode 必须是 preview|batch|regenerate, 收到: ' + MODE)
}
if (MODE === 'regenerate' && !args.only_ids) {
  throw new Error('regenerate 模式需指定 only_ids(挑出不满意的单张/几张重做)')
}

// ---------- 1. 零 LLM 校验计划 ----------
phase('校验计划')
const planRaw = await command({
  executable: 'node',
  args: [GEN, ...genArgs(), '--dry-run'],
  timeoutMs: 120000,
  label: 'image-gen-dry-run',
})
if (planRaw.exitCode !== 0) {
  // batch 未过风格审批门时在此拒绝(验收 3): 提示先 preview
  const fail = failLine(planRaw.stdout) || planRaw.stderr || 'unknown'
  throw new Error('校验失败(exit ' + planRaw.exitCode + '): ' + fail)
}
const plan = tagLine(planRaw.stdout, '[PLAN] ')
const toRun = plan.items.filter((x) => x.action === 'run-main' || x.action === 'run-candidate')

// ---------- 2. 付费执行授权（第一道门; 微信批准链可 skip_confirm 透传; 风格审批通过不豁免此门） ----------
if (args.skip_confirm !== true && toRun.length > 0) {
  const modeText =
    MODE === 'preview'
      ? '试生成 1 张代表图: ' + (plan.items[0] ? plan.items[0].id : '?') + ' (固定单次请求,不重试)'
      : MODE === 'regenerate'
        ? '单独重做 ' + toRun.length + ' 张(候选链隔离,原图保留至成功)'
        : '批量生成文章插图'
  await checkpoint(
    '即将' + modeText + ': ' + args.article_dir + '\n' +
    'Provider: ' + (args.provider || 'pi-image-gen') + (args.model ? ' / ' + args.model : '') + '\n' +
    '计划: ' + toRun.length + ' / ' + plan.items.length + ' 张需要生成(' +
      toRun.map((x) => x.id + '(' + (x.action === 'run-candidate' ? '重做·候选隔离' : '新生成') + ')').join(', ') + ')' +
    costText(plan.cost) + '\n' +
    '说明: 会写文章目录 imgs/、cover、image-manifest.json,并持有文章锁至完成;费用按实际请求张数计。\n' +
    '允许=执行; 拒绝=终止。'
  )
}

// ---------- 3. dry_run 到此为止 ----------
if (args.dry_run === true) {
  return {
    ok: true, mode: MODE, article_dir: args.article_dir, total: plan.items.length,
    succeeded: plan.items.length - toRun.length, failed: 0, pending: toRun.length,
    manifest_path: null, generated_paths: [], failed_ids: [], pending_ids: toRun.map((x) => x.id),
    dry_run: true, plan,
  }
}

// ---------- 4. 执行生成 ----------
phase(MODE === 'preview' ? '试生成' : MODE === 'regenerate' ? '单独重做' : '批量生成')
let result = null
if (toRun.length === 0) {
  result = {
    ok: true, mode: MODE, article_dir: args.article_dir, total: plan.items.length,
    succeeded: plan.items.length, failed: 0, pending: 0, manifest_path: null, generated_paths: [],
    failed_ids: [], pending_ids: [], nothing_to_do: true,
  }
} else {
  const gen = await runGen(genArgs(), typeof args.exec_timeout_ms === 'number' ? args.exec_timeout_ms : 30 * 60 * 1000, 'image-gen')
  if (gen.exitCode === 3) {
    // [LOCKED]: 别的进程在处理该文章(生图/插图/发布互斥),不是失败,交上层择机重试
    const locked = String(gen.stdout).split('\n').find((l) => l.startsWith('[LOCKED]')) || '[LOCKED]'
    console.log('image_generate locked: ' + locked)
    return { ok: false, locked: true, reason: locked, article_dir: args.article_dir, mode: MODE }
  }
  if (gen.exitCode === 2) {
    throw new Error('执行器拒绝: ' + (failLine(gen.stdout) || gen.stderr))
  }
  result = tagLine(gen.stdout, '[RESULT] ')
}

// ---------- 5. preview 专属: 风格确认（第二道门,内容审批; 不因 skip_confirm 豁免——两种确认必须分离） ----------
if (MODE === 'preview') {
  if (!result.ok) {
    return { ...result, style_approved: false, hint: '预览图生成失败: ' + (result.failed_ids || []).join(',') + '。排查后重试 preview。' }
  }
  const sa = result.style_approval || {}
  const previewPath = sa.preview_path ? args.article_dir + '/' + sa.preview_path : '(见 manifest)'
  if (args.style_approved === true) {
    // 自动化/测试预批准通道(正式链路勿用)
  } else {
    await checkpoint(
      '风格确认(内容审批,与执行授权相互独立):\n' +
      '预览图已生成: ' + previewPath + '\n' +
      '代表条目: ' + (sa.preview_image_id || '?') + ' | 绑定指纹: ' + String(sa.fingerprint || '').slice(0, 12) + '\n' +
      '请查看预览图,确认画风/构图/质量/尺寸。\n' +
      '满意=批准(锁定风格,随后可批量生成剩余图); 不满意=拒绝(请修改 image-prompts.json 的 style_prefix 或条目 prompt 后重新 preview)。\n' +
      '注意: 批准后修改提示词/模型/参考图,审批自动失效,需重新预览确认。'
    )
  }
  phase('锁定风格')
  const ap = await runGen(['--article-dir', String(args.article_dir), '--provider', String(args.provider || 'pi-image-gen'), '--approve-style']
    .concat(args.model ? ['--model', String(args.model)] : [])
    .concat(args.style_reference ? ['--style-reference', String(args.style_reference)] : []), 120000, 'image-gen-approve-style')
  if (ap.exitCode !== 0) {
    throw new Error('风格锁定失败: ' + (failLine(ap.stdout) || ap.stderr))
  }
  const approved = tagLine(ap.stdout, '[RESULT] ')
  console.log('style approved: ' + approved.preview_image_id + ' fingerprint=' + String(approved.fingerprint || '').slice(0, 12))
  return { ...result, style_approved: true, approval: approved, next: 'batch(可直接批量生成剩余图片)' }
}

// ---------- 6. 零 LLM 双向核验（最终 ok 的事实源; regenerate/batch 共用） ----------
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
console.log('image_generate done: mode=' + MODE + ' ok=' + ok + ' succeeded=' + result.succeeded + '/' + result.total +
  (result.unknown_ids && result.unknown_ids.length ? ' unknown=' + result.unknown_ids.length : '') +
  (result.capped_remaining ? ' capped_remaining=' + result.capped_remaining : '') +
  (verify.problems && verify.problems.length ? ' verify-problems=' + verify.problems.length : ''))

const out = { ...result, verify, ok }
if (result.paused_unknown) {
  out.hint = '已暂停: 存在扣费不确定(超时/连接中断)条目 ' + (result.unknown_ids || []).join(',') +
    '。人工核对账单后: 确认未计费→重新运行并传 retry_unknown=true 补跑该张。'
}
if (result.budget_stopped) {
  out.hint = (out.hint ? out.hint + ' ' : '') + '累计估算消耗（请求数×单价）已达预算 ¥' + (args.budget_cny ?? '?') + '，剩余条目留 pending；上调 budget_cny 后重跑即可续。'
}
if (result.capped_remaining > 0) {
  out.hint = (out.hint ? out.hint + ' ' : '') + '已达单次运行张数上限, ' + result.capped_remaining + ' 张留待下次运行继续。'
}
return out
