export const meta = {
  name: 'article_image_prompts_convert',
  description: '提示词清单转换: image-prompts.md|配图建议.md → image-prompts.json。确定性解析优先(零LLM);自由格式 agent+schema 兜底;产物必过 D6 校验闸。',
}

// 输入 args:
//   article_dir : 文章目录绝对路径(必填,含 image-prompts.md 或 配图建议.md)
//   force       : true 时覆盖已存在的 image-prompts.json
// 输出: { ok, mode: 'deterministic'|'agent', prompts_path, items? }

const CVT = 'dev-examples/wx-article/scripts/image_gen/convert.mjs'

// ---------- 1. 确定性解析（零 LLM；已存在则幂等退出） ----------
phase('确定性解析')
const step1 = await command({
  executable: 'node',
  args: [CVT, '--article-dir', String(args.article_dir), ...(args.force === true ? ['--force'] : [])],
  timeoutMs: 30_000,
  label: 'prompts-convert-deterministic',
})
if (step1.exitCode === 0) {
  const line = String(step1.stdout).split('\n').find((l) => l.startsWith('[RESULT]')) || ''
  console.log('确定性转换完成: ' + line.trim())
  return { ok: true, mode: 'deterministic', prompts_path: String(args.article_dir) + '/image-prompts.json' }
}
if (step1.exitCode === 2) {
  const fail = String(step1.stdout).split('\n').find((l) => l.startsWith('[FAIL]')) || step1.stderr
  throw new Error('转换器拒绝: ' + fail)
}
// exitCode 3 → 自由格式，走 agent 兜底
const need = String(step1.stdout).split('\n').find((l) => l.startsWith('[NEED-LLM]')) || '[NEED-LLM]'
console.log('确定性解析覆盖不全，转 agent 兜底: ' + need.trim())

// ---------- 2. agent + schema 兜底（general 有 read/write；直接写盘） ----------
phase('agent 提取')
const reply = await agent(
  [
    '阅读提示词 Markdown 文件并生成标准化清单。',
    '1. 用 read 工具读取 ' + args.article_dir + ' 下的 image-prompts.md（若无则读 配图建议.md）。',
    '2. 提取每张图的提示词：封面 kind="cover"（至多一张）；正文图 kind="body"。',
    '   heading 字段必须是文章正文里将出现的小节标题（含 "## " 前缀）；纯中文小节的 id 用 term-01/term-02 序号。',
    '   id 匹配 ^[a-z0-9][a-z0-9-]*$；filename 形如 01-xxx.png（正文）/ cover.png（封面），不得含路径分隔符。',
    '   style_prefix 提取全局风格描述（无则空串）；prompt 保留原文不要改写。',
    '3. 用 write 工具把 JSON 写到 ' + args.article_dir + '/image-prompts.json，结构：',
    '{"version":1,"article_id":"<目录名 ascii slug>","style_prefix":"...","items":[{"id":"...","kind":"cover|body","heading":"## ...","prompt":"...","filename":"..."}]}',
    '4. 只回复 written 与 items 数量，不要贴 JSON 全文。',
  ].join('\n'),
  { label: '提示词提取', agentType: 'general', schema: {
    type: 'object',
    required: ['written', 'items'],
    properties: { written: { type: 'boolean' }, items: { type: 'number' } },
    additionalProperties: false,
  } },
)
console.log('agent 兜底提取: ' + JSON.stringify(reply))

// ---------- 3. D6 校验闸（agent 产物不合法即整体失败） ----------
phase('校验')
const step3 = await command({
  executable: 'node',
  args: [CVT, '--validate-only', String(args.article_dir) + '/image-prompts.json'],
  timeoutMs: 15_000,
  label: 'prompts-convert-validate',
})
if (step3.exitCode !== 0) throw new Error('清单未过 D6 校验: ' + String(step3.stdout).slice(0, 300))
if (!fileExists(String(args.article_dir) + '/image-prompts.json')) throw new Error('image-prompts.json 未生成')

return { ok: true, mode: 'agent', prompts_path: String(args.article_dir) + '/image-prompts.json', items: reply.items }
