// P0 T0.6：agent 单命令桥接 × 长任务（40s）验证
// 复用 article_prepare.js 的桥接模式：general profile + schema 强制 raw 字段
export const meta = {
  name: "agent_bridge_long_task",
  description: "验证 agent 单命令桥接对 40s 长任务的承载/回传能力（P0 T0.6）",
};
const SANDBOX = args.sandbox; // 绝对路径

phase("bridge");
const cmd = `python3 ${SANDBOX}/scripts/slow_task.py --secs 40 --marker ${SANDBOX}/out/t06_marker.json`;
const r = await agent(
  `执行恰好一条 bash 命令并把 stdout 原样放入 raw 字段返回，不要增删改任何字符，不要执行其他命令：\n${cmd}`,
  {
    agentType: "general",
    schema: {
      type: "object",
      properties: { raw: { type: "string" } },
      required: ["raw"],
    },
  }
);
log("agent returned raw bytes:", r.raw?.length ?? "undefined");
let parsed = null;
try {
  parsed = JSON.parse(r.raw);
} catch {
  parsed = { parse_error: true, head: String(r.raw).slice(0, 120) };
}
log("parsed:", JSON.stringify(parsed));
check(() => parsed && parsed.ok === true && parsed.secs === 40, "stdout JSON 可回传解析");
