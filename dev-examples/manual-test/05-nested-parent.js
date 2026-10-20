export const meta = {
  name: "mt_nested_parent",
  description: "手动测试 D1：父流程并行调用两个子流程（共享并发/配额，args 透传）",
  phases: [{ title: "fan-out" }],
}

phase("fan-out")
const results = await parallel([
  () => workflow("./05-nested-child.js", { topic: args?.a ?? "redis" }),
  () => workflow({ scriptPath: "./05-nested-child.js", label: "child-b" }, { topic: args?.b ?? "sqlite" }),
])
return { results }
