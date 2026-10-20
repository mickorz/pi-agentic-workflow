export const meta = {
  name: "mt_checkpoint",
  description: "手动测试 F 组：人工审批——批准继续 / 拒绝硬停；批准后 general agent 写文件 + check 验证",
  phases: [{ title: "plan" }, { title: "approve" }, { title: "act" }],
}

phase("plan")
const content = await agent(
  "Propose a one-line note (max 12 words) to write into manual-test-note.txt. Reply with the line only.",
  { label: "draft" },
)

phase("approve")
// 交互模式：终端 y/N 询问；--non-interactive：进入等待态（exit 3），resume 后重问
const approved = await checkpoint(`即将把以下内容写入 manual-test-note.txt 并继续："${content}"。批准？`)

phase("act")
await agent(`Create a file named manual-test-note.txt in the current directory with exactly this content: ${content}`, {
  label: "write-note",
  agentType: "general",
})
const exists = await check(() => fileExists("manual-test-note.txt"), "manual-test-note.txt 应已创建")
log(`result = ${JSON.stringify({ content, approved, exists }, null, 2)}`)
return { content, approved, exists }
