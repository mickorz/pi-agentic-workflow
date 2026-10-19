export const meta = {
  name: "feature_development",
  description: "V1 验收案例：分析项目 → 修改代码 → 运行测试 → AI 独立审查 → 人工确认 → 保存结果",
  phases: [
    { title: "analyze" },
    { title: "implement" },
    { title: "verify" },
    { title: "approve" },
  ],
}

// 用法（针对隔离的测试项目目录）：
//   pi-workflow run feature-development.js --cwd <project> --args '{"task":"修复 add 函数"}'
// 故障恢复演练：--non-interactive 首跑到 checkpoint 进入等待态 → resume 交互批准

const task = args?.task ?? "Find and fix why the unit tests fail."

phase("analyze")
const analysis = await agent(
  `Analyze this project to ${task}\nRead package.json, then the source and test files. Identify the exact file, function, and what is wrong. Be concise.`,
  { label: "analyze", agentType: "explore" },
)

phase("implement")
const change = await agent(
  `Task: ${task}\n\nPrior analysis:\n${analysis}\n\nApply the minimal correct fix using your edit tools. Then summarize exactly what you changed (file, before, after).`,
  { label: "implement", agentType: "general" },
)

phase("verify")
const testsPass = await check(() => commandSuccess(args?.testCmd ?? "npm test", 120_000), "单元测试必须通过")
const review = await verify(change, { reviewers: 2, threshold: 0.5, lens: "code correctness and completeness of the fix" })

phase("approve")
const approved = await checkpoint("修复已实施、测试通过、AI 审查完成。保存结果并结束？")

return { task, analysis, change, testsPass, review, approved }
