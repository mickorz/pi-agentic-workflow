export const meta = {
  name: "write_demo",
  description: "AM-P0 真机验收：无害 write 流程（唯一副作用=general agent 写一个本地演示文件）",
}

// 无害写操作：general agent（read/bash/edit/write 白名单）把指定文本追加写入固定演示文件。
// 目标文件固定、不碰外部系统；write 风险等级由此获得真实意义（执行前授权用例）。
const text = typeof args?.text === "string" && args.text ? args.text : "（默认演示文本）"
const out = await agent(
  "请把下面这行文本原样追加写入文件 .pi-wechat/am-write-demo.txt（文件不存在则创建，末尾保留一个换行），写完后只回复 ok：\n" + text,
  { agentType: "general", label: "write-demo" },
)
return { echoed: text, agentReply: out }
