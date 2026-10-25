/**
 * URL 确定性前置路由单测（设计V2 §3，gateway-url-route 任务）
 *
 * 覆盖（§3.2/§3.3 边界表）：
 *  - extractUrls：裸链接 / 链接+文字 / 中文引号包裹 / 多链接 / 非链接 / 尾标点剥离
 *  - hostMatchesDomain：精确 / 子域 / evildouyin.com 误命中防护 / 大小写
 *  - routeByUrlDirect：含链即触发（其它域名链接不拦截）/ 同 workflow 多链接不猜 / 无 scheme 裸域名归一 /
 *    未声明域名回落 / 多 workflow 命中歧义 / enabled=false 排除
 *  - Registry：urlDomains/urlArg 声明合法性校验
 *  - Dispatcher.plan（legacy 链路）：前置路由直连且不触发 LLM；schema 不过回落 LLM
 *  - WechatApp agent 链路：裸抖音链接 → write 级 PendingAction 审批卡（不走 Agent 会话）；
 *    批准 → RunApplicationService 启动（args.url 保留）；多 URL/非 URL → 走 Agent 通道；
 *    read-only URL workflow → 免审批直启。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractUrls, hostMatchesDomain, hostOf, routeByUrlDirect } from "../../src/dispatch/url-router.js";
import { WorkflowRegistry } from "../../src/dispatch/registry.js";
import { Dispatcher } from "../../src/dispatch/dispatcher.js";
import { IntentRouter } from "../../src/dispatch/intent-router.js";
import { TaskStore } from "../../src/dispatch/task-store.js";
import { WechatApp } from "../../src/gateway/wechat-app.js";
import type { BotInboundMessage, WorkflowRegistration } from "../../src/contracts/wx.js";
import { FileBackedSessionRegistry, ScriptedHostedSession } from "../../src/agent-host/fakes.js";

// ── extractUrls ──

test("extractUrls：裸链接一条", () => {
  assert.deepEqual(extractUrls("https://v.douyin.com/iRNBosU/"), ["https://v.douyin.com/iRNBosU/"]);
});

test("extractUrls：链接+说明文字（URL 周围文字不影响抽取）", () => {
  assert.deepEqual(extractUrls("提取这个 https://v.douyin.com/iRNBosU/ 谢谢"), ["https://v.douyin.com/iRNBosU/"]);
});

test("extractUrls：中文引号包裹（尾部」剥离）", () => {
  assert.deepEqual(extractUrls("看这个「https://www.douyin.com/video/7381234567890123456」"), [
    "https://www.douyin.com/video/7381234567890123456",
  ]);
});

test("extractUrls：尾随逗号/句号剥离", () => {
  assert.deepEqual(extractUrls("https://v.douyin.com/abc/，还有这个。"), ["https://v.douyin.com/abc/"]);
});

test("extractUrls：多条链接全部抽出", () => {
  const out = extractUrls("https://v.douyin.com/a/ 和 https://v.douyin.com/b/");
  assert.equal(out.length, 2);
});

test("extractUrls：非链接消息为空", () => {
  assert.deepEqual(extractUrls("帮我总结一下这篇文章"), []);
  assert.deepEqual(extractUrls(""), []);
});

test("extractUrls：非 http(s) scheme 不抽（如 ftp）", () => {
  assert.deepEqual(extractUrls("ftp://v.douyin.com/x"), []);
});

// ── hostMatchesDomain / hostOf ──

test("hostMatchesDomain：精确与子域命中", () => {
  assert.equal(hostMatchesDomain("douyin.com", "douyin.com"), true);
  assert.equal(hostMatchesDomain("v.douyin.com", "douyin.com"), true);
  assert.equal(hostMatchesDomain("abc.v.douyin.com", "v.douyin.com"), true); // 子域的子域
  assert.equal(hostMatchesDomain("WWW.DOUYIN.COM", "douyin.com"), true); // 大小写归一
});

test("hostMatchesDomain：endsWith 误命中防护（evildouyin.com ≠ douyin.com）", () => {
  assert.equal(hostMatchesDomain("evildouyin.com", "douyin.com"), false);
  assert.equal(hostMatchesDomain("douyin.com.evil.com", "douyin.com"), false);
  assert.equal(hostMatchesDomain("xdouyin.com", "douyin.com"), false);
});

test("hostOf：非法 URL 返回 null，host 小写", () => {
  assert.equal(hostOf("not a url"), null);
  assert.equal(hostOf("https://V.Douyin.Com/x"), "v.douyin.com");
});

// ── routeByUrlDirect ──

const VIDEODIGEST: WorkflowRegistration = {
  workflowId: "videodigest-extract",
  scriptPath: "videodigest/extract.js",
  name: "提取短视频",
  description: "抖音视频下载音频转写归档",
  argsSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  riskLevel: "write",
  enabled: true,
  keywords: ["抖音", "短视频"],
  urlDomains: ["v.douyin.com", "www.douyin.com", "douyin.com", "iesdouyin.com", "www.iesdouyin.com"],
};

function reg(list: WorkflowRegistration[]): WorkflowRegistry {
  return new WorkflowRegistry(list);
}

test("routeByUrlDirect：裸抖音链接唯一命中 → 直连候选", () => {
  const hit = routeByUrlDirect("https://v.douyin.com/iRNBosU/", reg([VIDEODIGEST]));
  assert.ok(hit);
  assert.equal(hit.workflowId, "videodigest-extract");
  assert.equal(hit.argName, "url");
  assert.equal(hit.url, "https://v.douyin.com/iRNBosU/");
});

test("routeByUrlDirect：链接+文字仍直连", () => {
  const hit = routeByUrlDirect("提取这个 https://www.douyin.com/video/7381234567890123456 谢谢", reg([VIDEODIGEST]));
  assert.ok(hit);
  assert.equal(hit.workflowId, "videodigest-extract");
});

test("routeByUrlDirect：同 workflow 多条链接 → null（选哪条歧义，回落 LLM）", () => {
  assert.equal(routeByUrlDirect("https://v.douyin.com/a/ 和 https://v.douyin.com/b/", reg([VIDEODIGEST])), null);
});

test("routeByUrlDirect（含链即触发）：douyin 链接 + 其它域名链接 → 仍直连（其它域名不拦截）", () => {
  const hit = routeByUrlDirect(
    "看下这个 https://v.douyin.com/iRNBosU/ 和参考 https://github.com/foo/bar",
    reg([VIDEODIGEST]),
  );
  assert.ok(hit);
  assert.equal(hit.workflowId, "videodigest-extract");
  assert.equal(hit.url, "https://v.douyin.com/iRNBosU/");
});

test("routeByUrlDirect（含链即触发）：无 scheme 裸域名链接 → 归一 https:// 后直连", () => {
  const hit = routeByUrlDirect("v.douyin.com/iRNBosU/ 帮我提取", reg([VIDEODIGEST]));
  assert.ok(hit);
  assert.equal(hit.url, "https://v.douyin.com/iRNBosU/");
  const hit2 = routeByUrlDirect("看看 www.douyin.com/video/7381234567890123456 谢谢", reg([VIDEODIGEST]));
  assert.ok(hit2);
  assert.equal(hit2.url, "https://www.douyin.com/video/7381234567890123456");
});

test("routeByUrlDirect：真实抖音分享文案（前缀乱码+文案+#话题+尾随空格）→ 精确抽出链接直连", () => {
  const text =
    "0.76 tre:/ o@Q.xS :8pm 09/09 复制打开抖音极速版，看看【董俊豪企业AI化的作品】花100多亿token做ai落地的方法 # ai落... https://v.douyin.com/SKccO74-xAk/ ";
  const hit = routeByUrlDirect(text, reg([VIDEODIGEST]));
  assert.ok(hit);
  assert.equal(hit.workflowId, "videodigest-extract");
  assert.equal(hit.url, "https://v.douyin.com/SKccO74-xAk/");
});

test("routeByUrlDirect：裸域名提及无路径 / evildouyin 无 scheme / 子串域名 → null", () => {
  assert.equal(routeByUrlDirect("去 douyin.com 看看", reg([VIDEODIGEST])), null);
  assert.equal(routeByUrlDirect("evildouyin.com/x", reg([VIDEODIGEST])), null);
  assert.equal(routeByUrlDirect("v.douyin.com/a/ 和 v.douyin.com/b/", reg([VIDEODIGEST])), null);
});

test("routeByUrlDirect：非 URL 消息 → null", () => {
  assert.equal(routeByUrlDirect("总结这篇文章", reg([VIDEODIGEST])), null);
});

test("routeByUrlDirect：URL 域名无 workflow 声明 → null（回落）", () => {
  assert.equal(routeByUrlDirect("https://example.com/x", reg([VIDEODIGEST])), null);
});

test("routeByUrlDirect：子域命中（abc.v.douyin.com）", () => {
  const hit = routeByUrlDirect("https://abc.v.douyin.com/x/", reg([VIDEODIGEST]));
  assert.ok(hit);
});

test("routeByUrlDirect：多 workflow 同时声明该域名 → null（歧义不猜）", () => {
  const other: WorkflowRegistration = {
    ...VIDEODIGEST,
    workflowId: "another-extract",
    urlDomains: ["douyin.com"],
  };
  assert.equal(routeByUrlDirect("https://www.douyin.com/video/1", reg([VIDEODIGEST, other])), null);
});

test("routeByUrlDirect：enabled=false 的 workflow 不参与", () => {
  const r = reg([{ ...VIDEODIGEST, enabled: false }]);
  assert.equal(routeByUrlDirect("https://v.douyin.com/x/", r), null);
});

test("routeByUrlDirect：自定义 urlArg 注入参数名", () => {
  const custom: WorkflowRegistration = {
    ...VIDEODIGEST,
    urlArg: "videoUrl",
    argsSchema: { type: "object", properties: { videoUrl: { type: "string" } }, required: ["videoUrl"] },
  };
  const hit = routeByUrlDirect("https://v.douyin.com/x/", reg([custom]));
  assert.ok(hit);
  assert.equal(hit.argName, "videoUrl");
});

// ── Registry 声明合法性 ──

test("Registry：urlDomains 非法声明被拒绝（空数组/非域名/含 path/argsSchema 缺 url 属性）", () => {
  const mk = (over: Partial<WorkflowRegistration>): WorkflowRegistration => ({ ...VIDEODIGEST, ...over });
  const cases: Array<[WorkflowRegistration, RegExp]> = [
    [mk({ urlDomains: [] }), /urlDomains 需为非空字符串数组/],
    [mk({ urlDomains: ["not a domain"] }), /urlDomains 条目非法/],
    [mk({ urlDomains: ["https://douyin.com/x"] }), /urlDomains 条目非法/],
    [
      mk({ argsSchema: { type: "object", properties: { other: { type: "string" } }, required: [] } }),
      /urlArg（默认 url）必须存在于 argsSchema\.properties/,
    ],
    [
      mk({ urlArg: "missing", argsSchema: { type: "object", properties: { url: { type: "string" } }, required: [] } }),
      /urlArg（默认 url）必须存在于 argsSchema\.properties/,
    ],
  ];
  for (const [bad, re] of cases) {
    const out = new WorkflowRegistry([bad]).register(bad);
    assert.match(out.ok === false ? out.error : "", re);
  }
});

test("Registry：合法 urlDomains+urlArg 声明通过", () => {
  const ok = reg([VIDEODIGEST]);
  assert.equal(ok.get("videodigest-extract") !== undefined, true);
});

// ── Dispatcher.plan（legacy 链路前置路由） ──

function makeDispatcher(registry: WorkflowRegistry, llmCalls: { n: number }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "urlroute-"));
  const llm = {
    route: async () => {
      llmCalls.n += 1;
      return {
        text: JSON.stringify({ intent: "unsupported", reason: "LLM 兜底应答", confidence: 1 }),
        latencyMs: 1,
      };
    },
  };
  const router = new IntentRouter({ llm: llm as never, registry });
  const service = {
    start: async () => ({ runId: "run-x" }),
  };
  const dispatcher = new Dispatcher({
    registry,
    router,
    tasks: new TaskStore(path.join(base, "tasks")),
    service: service as never,
    scriptsRoot: base,
  });
  return { dispatcher, base };
}

test("Dispatcher.plan：裸抖音链接直连（LLM 零调用）", async () => {
  const llmCalls = { n: 0 };
  const { dispatcher } = makeDispatcher(reg([VIDEODIGEST]), llmCalls);
  const plan = await dispatcher.plan({ text: "https://v.douyin.com/iRNBosU/" });
  assert.equal(plan.intent, "execute_workflow");
  assert.equal(plan.action, "start_execution");
  assert.equal(plan.workflowId, "videodigest-extract");
  assert.equal(plan.args?.url, "https://v.douyin.com/iRNBosU/");
  assert.equal(plan.confidence, 1);
  assert.equal(llmCalls.n, 0, "前置路由命中时不得触发 LLM");
});

test("Dispatcher.plan：非 URL 消息回落 IntentRouter", async () => {
  const llmCalls = { n: 0 };
  const { dispatcher } = makeDispatcher(reg([VIDEODIGEST]), llmCalls);
  const plan = await dispatcher.plan({ text: "你好" });
  assert.equal(llmCalls.n, 1);
  assert.equal(plan.intent, "unsupported");
});

test("Dispatcher.plan：schema 校验不过（必填参数不止 url）→ 回落 LLM 澄清", async () => {
  const llmCalls = { n: 0 };
  const needMore: WorkflowRegistration = {
    ...VIDEODIGEST,
    argsSchema: {
      type: "object",
      properties: { url: { type: "string" }, extra: { type: "string" } },
      required: ["url", "extra"],
    },
  };
  const { dispatcher } = makeDispatcher(reg([needMore]), llmCalls);
  const plan = await dispatcher.plan({ text: "https://v.douyin.com/x/" });
  assert.equal(llmCalls.n, 1, "url 之外还有必填参数时回落 LLM（澄清补参）");
  assert.notEqual(plan.action, "start_execution");
});

// ── WechatApp agent 链路（确定性通道 1.5） ──

class FakeBot {
  sent: Array<{ userId: string; text: string }> = [];
  handler?: (message: BotInboundMessage) => Promise<void>;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onMessage(handler: (message: BotInboundMessage) => Promise<void>): void {
    this.handler = handler;
  }
  async send(userId: string, text: string): Promise<void> {
    this.sent.push({ userId, text });
  }
}

class FakeService {
  started: Array<{ scriptPath: string; args?: unknown }> = [];
  async start(input: { scriptPath: string; args?: unknown }) {
    this.started.push({ scriptPath: input.scriptPath, args: input.args });
    return { runId: `run-${this.started.length}` };
  }
  async get() {
    return { snapshot: { status: "completed", effectiveStatus: "completed", result: { ok: true } }, checkpoints: [] };
  }
  async cancel(): Promise<void> {}
  async resume(runId: string) {
    return { runId };
  }
}

function msg(id: string, text: string, userId = "u1"): BotInboundMessage {
  return { channel: "wechat", userId, messageId: id, text, receivedAt: new Date().toISOString() };
}

interface AgentEnv {
  app: WechatApp;
  bot: FakeBot;
  service: FakeService;
  openedSessions: { n: number; prompts: string[] };
}

/** agent 模式装配：记录会话开启次数（URL 直连时 Agent 会话不得被触发） */
function makeAgentEnv(registrations: WorkflowRegistration[]): AgentEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "urlroute-ag-"));
  const dataDir = path.join(base, ".pi-wechat");
  const bot = new FakeBot();
  const service = new FakeService();
  const openedSessions = { n: 0, prompts: [] as string[] };
  const factory = (id: string) => {
    openedSessions.n += 1;
    const s = new ScriptedHostedSession(id, ["（Agent 兜底应答）"]);
    const inner = s.prompt.bind(s);
    // 包装记录 prompt（不动行为）
    (s as unknown as { prompt: (t: string) => Promise<{ replyText: string }> }).prompt = async (t: string) => {
      openedSessions.prompts.push(t);
      return inner(t);
    };
    return s;
  };
  const sessions = new FileBackedSessionRegistry(path.join(base, ".pi-agent-host", "sessions"), factory);
  const app = new WechatApp({
    bot: bot as never,
    registry: new WorkflowRegistry(registrations),
    llm: {
      route: async () => {
        throw new Error("legacy IntentRouter 不应被触发（agent 模式）");
      },
    } as never,
    service: service as never,
    scriptsRoot: base,
    dataDir,
    routingMode: "agent",
    agentOpenSession: sessions.opener,
    agentSessionDir: path.join(base, ".pi-agent-host", "sessions"),
  });
  return { app, bot, service, openedSessions };
}

test("agent 链路：裸抖音链接 → write 级审批卡（不经 Agent 会话），批准后启动且 args.url 保留", async () => {
  const env = makeAgentEnv([VIDEODIGEST]);
  const out = await env.app.handleInbound(msg("m1", "https://v.douyin.com/iRNBosU/"));
  assert.equal(out.duplicate, false);
  assert.equal(env.openedSessions.n, 0, "URL 直连不得打开 Agent 会话（不走 LLM 猜测）");
  const card = env.bot.sent.find((s) => s.text.includes("待审批流程"));
  assert.ok(card, "应入队 AM-P0 审批卡");
  assert.match(card.text, /videodigest-extract/);
  assert.equal(env.service.started.length, 0, "write 级未批准不得启动");

  // 批准（确定性通道）→ RunApplicationService 启动，参数完整
  await env.app.handleInbound(msg("m2", "批准"));
  assert.equal(env.service.started.length, 1);
  assert.equal(env.service.started[0]!.scriptPath.includes("videodigest/extract.js"), true);
  assert.deepEqual(env.service.started[0]!.args, { url: "https://v.douyin.com/iRNBosU/" });
  assert.equal(env.openedSessions.n, 0, "审批决策走确定性通道，也不开 Agent 会话");
});

test("agent 链路：链接+文字仍直连；同链接重发 → 复用既有 pending（不叠加）", async () => {
  const env = makeAgentEnv([VIDEODIGEST]);
  await env.app.handleInbound(msg("m1", "提取这个 https://v.douyin.com/iRNBosU/ 谢谢"));
  await env.app.handleInbound(msg("m2", "再处理一次 https://v.douyin.com/iRNBosU/"));
  const cards = env.bot.sent.filter((s) => s.text.includes("待审批流程"));
  assert.equal(cards.length, 1, "同 argsDigest 的 pending 去重复用，只发一张卡");
});

test("agent 链路：同 workflow 多链接 / 非 URL 消息 → 走 Agent 通道（未拦截）；其它域名链接不再拦截 douyin 直连", async () => {
  const env = makeAgentEnv([VIDEODIGEST]);
  await env.app.handleInbound(msg("m0", "https://v.douyin.com/a/ 加 https://github.com/x/y"));
  assert.equal(env.openedSessions.n, 0, "douyin+其它域名：含链即触发，不开 Agent 会话");
  await env.app.handleInbound(msg("m1", "https://v.douyin.com/a/ 和 https://v.douyin.com/b/"));
  assert.equal(env.openedSessions.n, 1, "两条 douyin 链接歧义回落 Agent");
  await env.app.handleInbound(msg("m2", "帮我写个总结"));
  assert.equal(env.openedSessions.prompts.length >= 2, true, "非 URL 消息走 Agent");
});

test("agent 链路：read-only URL workflow → 免审批直启", async () => {
  const ro: WorkflowRegistration = { ...VIDEODIGEST, riskLevel: "read-only" };
  const env = makeAgentEnv([ro]);
  const out = await env.app.handleInbound(msg("m1", "https://v.douyin.com/iRNBosU/"));
  assert.equal(out.duplicate, false);
  assert.equal(env.service.started.length, 1, "read-only 直启");
  assert.equal(env.openedSessions.n, 0);
  assert.equal(env.bot.sent.some((s) => s.text.includes("已启动")), true);
});
