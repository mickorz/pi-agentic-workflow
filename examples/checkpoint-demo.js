export const meta = {
  name: "checkpoint_demo",
  description: "P2 人工审批：改文件前等待确认；拒绝即停（副作用窗口示例）",
  phases: [{ title: "plan" }, { title: "approve" }, { title: "act" }],
}

phase("plan")
const plan = await agent(
  "Propose a one-line summary for a file named note.txt that we are about to create. Reply with the line only.",
  { label: "draft-plan" },
)

phase("approve")
// 人工审批：交互终端询问 y/n；--non-interactive 时进入等待态（resume 后重新询问）
const approved = await checkpoint(`即将把以下内容写入 note.txt 并继续："${plan}"。批准？`)

phase("act")
const written = await agent(`Create a file named note.txt in the current directory with exactly this content: ${plan}`, {
  label: "write-file",
  agentType: "general",
})
const exists = await check(() => fileExists("note.txt"), "note.txt 应已创建")
return { plan, approved, written, exists }
