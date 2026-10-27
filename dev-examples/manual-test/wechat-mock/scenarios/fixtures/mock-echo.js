export const meta = {
  name: "mock_echo",
  description: "WX-MOCK fixture：回显参数并落盘产物（read-only，零 LLM 零外部服务）",
}
// args: { marker: string, outFile: string }
// 产物：outFile 内容 = "echo:" + marker（E1/R3 断言事实源）
phase("echo")
const result = { echo: String(args.marker), fixture: "mock-echo" }
await command({
  executable: "node",
  args: ["-e", "require('fs').writeFileSync(process.argv[1], process.argv[2])", String(args.outFile), "echo:" + String(args.marker)],
})
log("mock-echo 已落盘产物")
return result
