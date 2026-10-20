export const meta = {
  name: "long-demo",
  description: "WX-P2 真机验收：长任务（供取消/进度查询用例）",
}

// 三段 agent，拉长执行窗口，便于在运行中查询进度与取消
const a = await agent("Count slowly from 1 to 3 then reply: 步骤 1 完成。", { label: "step-1" })
const b = await agent("Count slowly from 1 to 3 then reply: 步骤 2 完成。", { label: "step-2" })
const c = await agent("Count slowly from 1 to 3 then reply: 步骤 3 完成。", { label: "step-3" })
return { a, b, c }
