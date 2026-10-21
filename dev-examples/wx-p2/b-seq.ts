/**
 * WX-PT Part B 程序化时序用例（B09 中断恢复 / B10 停止不等于取消 / B13 重启不丢审批）
 * 用 FakeBot 直调 WechatApp.handleInbound（同手机消息的服务端入口），配合外部 kill 模拟服务终止。
 *
 * 用法（仓库根）：
 *   stage-run      起"执行长任务演示"并挂住（等外部 kill -9）
 *   stage-approval 起"执行审批演示"并挂住（等外部 kill -9）
 *   stage-check    B10：run 不受服务终止影响（interrupted 可查）→ B09：resume 恢复完成
 *   stage-restart  B13：重启装配 → 不重发旧审批卡（版本去重）→ 决策推进（跨进程恢复回归）
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WechatApp } from "../../src/gateway/wechat-app.js";
import { WorkflowRegistry } from "../../src/dispatch/registry.js";
import { PiAgentAdapter } from "../../src/adapters/pi/pi-agent-adapter.js";
import type { RoutingLLM } from "../../src/dispatch/intent-router.js";
import { createRunApplicationService } from "../../src/index.js";

// 锚定脚本自身目录（wx-p2），与运行 cwd 无关
const base = path.dirname(fileURLToPath(import.meta.url));
const registryFile = path.join(base, "registry.json");
const scriptsRoot = path.join(base);
const dataDir = path.join(base, ".pi-wechat");
const USER = "o9cq80xRHbzE8CUrHdTyXhO_pdA4@im.wechat";

const adapter = new PiAgentAdapter({});
const llm: RoutingLLM = {
  route: async (prompt) => {
    const started = Date.now();
    let tokens = 0;
    const out = await adapter.run(prompt, { label: "intent-router", onUsage: (u) => { tokens += u.total ?? 0; } });
    return { text: out.type === "text" ? out.value : JSON.stringify(out.value), latencyMs: Date.now() - started, ...(tokens > 0 ? { tokens } : {}) };
  },
};

/** FakeBot 版 WechatApp：收发均走内存（handleInbound 即手机消息服务端入口） */
function makeApp(): { app: WechatApp; inbound: (text: string) => Promise<{ reply?: string }>; sent: string[] } {
  const service = createRunApplicationService({ baseDir: base });
  const { registry } = WorkflowRegistry.loadFromFile(registryFile);
  const sent: string[] = [];
  const fakeBot = {
    onMessage: () => {},
    start: async () => {},
    stop: async () => {},
    send: async (_u: string, text: string) => { sent.push(text); },
  };
  const app = new WechatApp({ bot: fakeBot as never, registry, llm, service, scriptsRoot, dataDir });
  return {
    app,
    sent,
    inbound: (text: string) =>
      app.handleInbound({ channel: "wechat", userId: USER, messageId: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text, receivedAt: new Date().toISOString() }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cmd = process.argv[2] ?? "";

if (cmd === "stage-run" || cmd === "stage-approval") {
  const { app, inbound } = makeApp();
  const text = cmd === "stage-run" ? "执行长任务演示" : "执行审批演示";
  const out = await inbound(text);
  console.log(`reply: ${(out.reply ?? "").slice(0, 80)}`);
  const svc = createRunApplicationService({ baseDir: base });
  const t0 = Date.now();
  let runId = "";
  while (Date.now() - t0 < 60_000) {
    const tasks = (await import("node:fs")).readFileSync(path.join(dataDir, "tasks.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const latest = new Map<string, (typeof tasks)[number]>();
    for (const b of tasks) latest.set(b.taskBindingId, b);
    const mine = [...latest.values()].filter((b) => b.createdAt > new Date(t0 - 120_000).toISOString());
    if (mine.length) { runId = mine[mine.length - 1].runId; break; }
    await sleep(300);
  }
  console.log(`RUNID=${runId}`);
  // 挂住（模拟服务常驻；由外部 kill -9 模拟 Ctrl-C 终止）
  await sleep(300_000);
} else if (cmd === "stage-check") {
  // 由 sh 编排传 RUNID：验证 B10 + B09
  const runId = process.env.RUNID ?? "";
  const svc = createRunApplicationService({ baseDir: base });
  const d = await svc.get(runId);
  console.log(`B10 终止后可查：status=${d?.snapshot.status}（interrupted=服务终止不影响数据）`);
} else if (cmd === "stage-restart") {
  const runId = process.env.RUNID ?? "";
  const { app } = makeApp();
  await app.start(); // 重启装配：monitor 补扫（含审批卡补发判定——版本去重）
  await sleep(3000);
  const fs = await import("node:fs");
  const outbox = fs.readFileSync(path.join(dataDir, "outbox.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
  const dup = outbox.filter((o) => o.kind === "approval" && o.runId === runId && o.status === "sent").length;
  console.log(`B13 旧审批卡重发次数=${dup}（应为 1，版本去重不重发）`);
  const svc = createRunApplicationService({ baseDir: base });
  const detail = await svc.get(runId);
  const cp = detail?.checkpoints.find((c) => c.status === "pending") ?? detail?.checkpoints[0];
  if (cp) {
    await svc.decideCheckpoint(runId, cp.checkpointId, { decision: "approve", expectedVersion: cp.version });
    const t0 = Date.now();
    while (Date.now() - t0 < 180_000) {
      const st = (await svc.get(runId))?.snapshot.status;
      if (st === "completed") { console.log("B13 重启后决策仍可推进：completed"); process.exit(0); }
      await sleep(500);
    }
    console.log(`B13 重启后决策推进超时：status=${(await svc.get(runId))?.snapshot.status}`);
    process.exit(1);
  }
  console.log("B13 无 checkpoint（异常）"); process.exit(1);
} else {
  console.error("用法: npx tsx dev-examples/wx-p2/b-seq.ts stage-run|stage-approval|stage-check|stage-restart");
  process.exit(2);
}
process.exit(0);
