export const meta = {
  name: "nested_parent",
  description: "P1 嵌套子流程：父 workflow 调子 workflow，共享并发/配额",
  phases: [{ title: "fan-out" }],
}

phase("fan-out")
// 并行调用两个子 workflow（显式路径；自环/深度由 runtime 检查）
const results = await parallel([
  () => workflow("./nested-child.js", { topic: args?.a ?? "redis" }),
  () => workflow({ scriptPath: "./nested-child.js", label: "child-b" }, { topic: args?.b ?? "sqlite" }),
])
return { results }
