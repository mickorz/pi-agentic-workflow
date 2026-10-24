export const meta = {
  name: 'obsidian_note_append',
  description: '向已有 Obsidian 笔记追加内容(O_APPEND 语义:目标不存在即拒绝,不创建新文件;内容经审批链授权写入)',
  capabilities: ['obsidian-write'],
  phases: [{ title: '写入前校验' }, { title: '追加内容' }, { title: '结果播报' }],
}

// P1a ObsidianService 写面（方案 §2/§3）
// 输入 args:
//   rel         : vault 相对 .md 路径（目标必须已存在）
//   content     : 追加内容（UTF-8 ≤1MB；经 stdin 传后端，不进 argv/日志）
//   operationId : 幂等键（服务端审批链派生注入；同键同内容重试 → 幂等成功不重复写）
// 输出: { ok, rel, operationId, status, message }

phase('写入前校验')
const rel = String(args.rel || '').trim()
const content = typeof args.content === 'string' ? args.content : ''
const operationId = String(args.operationId || '').trim()
await check(() => rel !== '' && rel.endsWith('.md'), '缺少 rel（vault 相对 .md 路径）')
await check(() => content.trim() !== '', '缺少 content（追加内容）')
await check(() => operationId !== '', '缺少 operationId（服务端审批链注入的幂等键）')

phase('追加内容')
const r = await obsidianWrite.appendNote({ rel, content, operationId })
await check(
  () => r.ok === true,
  '追加笔记失败: ' + JSON.stringify(r.ok ? {} : { code: r.code, issues: r.issues }),
)
log('obsidian 追加: ' + rel + ' status=' + (r.ok ? r.status : r.code) + ' op=' + operationId)

phase('结果播报')
const report = await agent(
  '请为一次 Obsidian 笔记追加操作生成一句给用户的确认文案（微信回复用，简洁友好）。\n\n' +
  '追加结果: ' + JSON.stringify({ rel, status: r.ok ? r.status : 'failed' }) + '\n\n' +
  '要求: 告知内容已追加到哪篇笔记（vault 相对路径 rel）；不要复述追加内容。\n' +
  '返回 JSON: { message: string }。',
  {
    label: '追加结果播报',
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
