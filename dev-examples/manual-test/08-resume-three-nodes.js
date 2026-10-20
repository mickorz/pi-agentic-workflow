export const meta = {
  name: "mt_resume",
  description: "手动测试 G3：三节点顺序链——配合 SIGKILL/中断做 journal 回放恢复验证",
  phases: [{ title: "chain" }],
}

phase("chain")
const a = await agent("Reply with exactly: node-1-done", { label: "n1" })
const b = await agent("Reply with exactly: node-2-done", { label: "n2" })
const c = await agent("Reply with exactly: node-3-done", { label: "n3" })
log(`answers = ${JSON.stringify([a, b, c])}`)
return [a, b, c]
