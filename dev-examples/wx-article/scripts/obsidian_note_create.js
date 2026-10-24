export const meta = {
  name: 'obsidian_note_create',
  description: '在 Obsidian vault 创建新笔记(O_EXCL 语义:目标已存在即拒绝,绝不覆盖;内容经审批链授权写入)',
  capabilities: ['obsidian-write'],
  phases: [{ title: '写入前校验' }, { title: '创建笔记' }, { title: '结果播报' }],
}

// P1a ObsidianService 写面（方案 §2/§3）
// 输入 args:
//   rel         : vault 相对 .md 路径（如 灵感/AI 自动化测试.md；不允许绝对路径/../段/隐藏段/shell 元字符）
//   content     : 笔记全文（UTF-8 ≤1MB；经 stdin 传后端，不进 argv/日志）
//   operationId : 幂等键（服务端审批链派生注入；同键同内容重试 → 幂等成功不重复写）
// 输出: { ok, rel, operationId, status, message }
// 安全（§2.3）：journal/log/返回值只记 rel/status/digest 派生信息，不落全文。

phase('写入前校验')
const rel = String(args.rel || '').trim()
const content = typeof args.content === 'string' ? args.content : ''
const operationId = String(args.operationId || '').trim()
await check(() => rel !== '' && rel.endsWith('.md'), '缺少 rel（vault 相对 .md 路径）')
await check(() => content.trim() !== '', '缺少 content（笔记全文）')
await check(() => operationId !== '', '缺少 operationId（服务端审批链注入的幂等键）')

phase('创建笔记')
const r = await obsidianWrite.createNote({ rel, content, operationId })
await check(
  () => r.ok === true,
  '创建笔记失败: ' + JSON.stringify(r.ok ? {} : { code: r.code, issues: r.issues }),
)
log('obsidian 创建: ' + rel + ' status=' + (r.ok ? r.status : r.code) + ' op=' + operationId)

phase('结果播报')
const report = await agent(
  '请为一次 Obsidian 笔记创建操作生成一句给用户的确认文案（微信回复用，简洁友好）。\n\n' +
  '创建结果: ' + JSON.stringify({ rel, status: r.ok ? r.status : 'failed' }) + '\n\n' +
  '要求: 告知笔记已创建及其位置（vault 相对路径 rel）；不要复述笔记内容。\n' +
  '返回 JSON: { message: string }。',
  {
    label: '创建结果播报',
    agentType: 'general',
    schema: {
      type: 'object',
      properties: { message: { type: 'string', description: '给用户的确认文案' } },
      required: ['message'],
    },
  },
)

return {
  ok: r.ok === true,
  rel,
  operationId,
  status: r.ok ? r.status : r.code,
  bytes: r.ok ? r.bytes : null,
  message: report.message,
}
