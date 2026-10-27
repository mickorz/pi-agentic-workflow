export const meta = {
  name: "mock_slow",
  description: "WX-MOCK fixture：慢任务（X1 中断恢复：marker 追加一次 + 长眠 + 终态文件）",
}
// args: { markerFile: string, finalFile: string }
// X1 断言：finalFile 存在；markerFile 行数 == 1（journal 回放不重执行已完成节点）
phase("marker")
await command({
  executable: "node",
  args: ["-e", "require('fs').appendFileSync(process.argv[1], 'm1\\n')", String(args.markerFile)],
})
phase("sleep")
await command({
  executable: "ping",
  args: ["-n", "12", "127.0.0.1"],
  timeoutMs: 30000,
})
phase("final")
await command({
  executable: "node",
  args: ["-e", "require('fs').writeFileSync(process.argv[1], 'done')", String(args.finalFile)],
})
log("mock-slow 完成")
return { ok: true }
