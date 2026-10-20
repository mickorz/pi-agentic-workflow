export const meta = {
  name: "mt_check_verify",
  description: "手动测试 E1：确定性门禁（fileExists/commandSuccess）+ AI 对抗审查（verify）",
  phases: [{ title: "produce" }, { title: "verify" }],
}

phase("produce")
const fact = await agent("State one easily checkable fact: the capital of France. Reply with just the city name.", {
  label: "produce-fact",
})

phase("verify")
// 客观事实：命令退出码 + 文件存在性（相对运行 cwd）
const nodeOk = await check(() => commandSuccess("node -v"), "node -v 应成功")
const pkgOk = await check(() => fileExists("../../package.json"), "仓库 package.json 应存在")

// AI 质量判断：独立 reviewer 会话投票
const verdict = await verify(fact, { reviewers: 2, threshold: 0.5 })

return { fact, nodeOk, pkgOk, verdict }
