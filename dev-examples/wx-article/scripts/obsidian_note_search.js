export const meta = {
  name: 'obsidian_note_search',
  description: '在 Obsidian vault 检索笔记(按名称/内容/两者,大小写不敏感,确定性排序;只读,不修改 vault)',
  phases: [{ title: '检索' }, { title: '结果播报' }],
}

// P1a ObsidianService 读面（方案 §4；§7.2 微信搜笔记场景）
// 输入 args:
//   query      : 检索词（名称或内容子串，大小写不敏感）
//   scope      : 限定范围（vault 相对目录或配置别名，可选硬约束）
//   mode       : name|content|both（缺省 both）
//   limit      : 返回条数上限（缺省 20，最大 200）
// 输出: { ok, total, truncated, items: [{path,title,snippet}], message }

phase('检索')
const query = String(args.query || '').trim()
await check(() => query !== '', '缺少 query（检索词）')
const searchArgs = { query }
if (args.scope) searchArgs.scope = String(args.scope)
if (args.mode) searchArgs.mode = String(args.mode)
if (args.limit) searchArgs.limit = Number(args.limit)
const r = await obsidian.searchNotes(searchArgs)
await check(
  () => r.ok === true,
  '检索失败: ' + JSON.stringify(r.ok ? {} : { issues: r.issues }),
)
log('obsidian 检索: q=' + query + ' total=' + r.total + ' truncated=' + r.truncated)

phase('结果播报')
const report = await agent(
  '请为一次 Obsidian 笔记检索生成给用户的回复文案（微信用）。\n\n' +
  '检索结果: ' + JSON.stringify({ query, total: r.total, truncated: r.truncated, items: r.items.slice(0, 10) }) + '\n\n' +
  '要求: 列出命中的笔记（路径+一句话摘要），超过 10 条说明还有更多；帮助用户定位到想找的笔记。\n' +
  '返回 JSON: { message: string }。',
  {
    label: '检索结果播报',
    agentType: 'general',
    schema: {
      type: 'object',
      properties: { message: { type: 'string', description: '给用户的检索结果文案' } },
      required: ['message'],
    },
  },
)

return {
  ok: true,
  query,
  total: r.total,
  truncated: r.truncated,
  items: r.items,
  message: report.message,
}
