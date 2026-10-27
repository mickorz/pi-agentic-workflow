export const meta = {
  name: "mock_effect",
  description: "WX-MOCK fixture：外部副作用流程（A1/A2 授权门：批准落盘产物 / 拒绝不执行）",
}
// args: { outFile: string, anchor: string }
// external-side-effect：未经批准 NOT_AUTHORIZED 拦截（A2）；批准后写产物（A1）
phase("effect")
await command({
  executable: "node",
  args: ["-e", "require('fs').writeFileSync(process.argv[1], process.argv[2])", String(args.outFile), "effect:" + String(args.anchor)],
})
log("mock-effect 已落盘产物")
return { wrote: String(args.outFile), anchor: String(args.anchor) }
