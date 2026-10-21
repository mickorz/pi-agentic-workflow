/**
 * V2-P1-05 SSE 测试：先补传后订阅、Last-Event-ID 重连（E08：不丢事件、seq 去重、顺序保证）
 * 真实 HTTP listener（app.inject 不支持流式增量读取）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWebApp } from "../../src/server/app.js";
import { ProjectRegistry } from "../../src/server/projects.js";
import { createRunApplicationService } from "../../src/application/run-service.js";
import type { AgentSessionRunner } from "../../src/agent/session-runner.js";
import { resolveWebConfig } from "../../src/server/config.js";

interface SseEvent {
  id: number;
  event: string;
  data: unknown;
}

/** SSE 消费者：fetch + 增量解析；collect(n) 等到 n 条或超时；waitDone() 等流结束 */
class SseClient {
  private buffer = "";
  private waiters: Array<{ n: number; resolve: () => void }> = [];
  private doneWaiters: Array<() => void> = [];
  done = false;
  events: SseEvent[] = [];
  readonly controller = new AbortController();

  private feed(text: string): void {
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) >= 0) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      let id = -1;
      let eventName = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("id:")) id = Number.parseInt(line.slice(3).trim(), 10);
        else if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (eventName === "done") {
        this.done = true;
        for (const w of this.doneWaiters.splice(0)) w();
        continue;
      }
      if (id >= 0) {
        this.events.push({ id, event: eventName, data: data ? JSON.parse(data) : undefined });
        this.waiters = this.waiters.filter((w) => {
          if (this.events.length >= w.n) {
            w.resolve();
            return false;
          }
          return true;
        });
      }
    }
  }

  static async connect(url: string, init?: { lastEventId?: number; signal?: AbortSignal }): Promise<SseClient> {
    const client = new SseClient();
    const response = await fetch(url, {
      headers: {
        accept: "text/event-stream",
        ...(init?.lastEventId !== undefined ? { "last-event-id": String(init.lastEventId) } : {}),
      },
      signal: init?.signal ?? client.controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = response.body!;
    void (async () => {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          client.feed(Buffer.from(value).toString("utf8"));
        }
      } catch {
        /* abort */
      }
    })();
    return client;
  }

  async collect(n: number, timeoutMs = 4000): Promise<SseEvent[]> {
    if (this.events.length < n) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`collect(${n}) 超时，现有 ${this.events.length}`)), timeoutMs);
        this.waiters.push({ n, resolve: () => { clearTimeout(timer); resolve(); } });
      });
    }
    return this.events;
  }

  async waitDone(timeoutMs = 4000): Promise<void> {
    if (this.done) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待 done 超时")), timeoutMs);
      this.doneWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }
}

function makeApp(base: string, runner: AgentSessionRunner) {
  const registry = new ProjectRegistry([path.join(base, "proj")]);
  const service = createRunApplicationService({ baseDir: base, runner });
  const config = resolveWebConfig({ configDir: base });
  return createWebApp({ config, service, registry, version: "test" });
}

function setup(name: string, script: string): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `v2-sse-${name}-`));
  fs.mkdirSync(path.join(base, "proj"));
  fs.writeFileSync(path.join(base, "proj", "wf.js"), script);
  return base;
}

const OK_SCRIPT = `export const meta = { name: "ok" }\nconst a = await agent("hi")\nreturn { a }`;

test("已完成 run：连接即全量补传 + 顺序 + done 关流（刷新重建历史）", async () => {
  const base = setup("history", OK_SCRIPT);
  const app = makeApp(base, { async run(p) { return { type: "text", value: `v:${p}`, sessionId: "s" }; } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const port = (app.server.address() as { port: number }).port;
    const created = await app.inject({ method: "POST", url: "/api/runs", payload: { projectId: "proj", path: "wf.js" } });
    const { runId } = created.json() as { runId: string };
    await new Promise((r) => setTimeout(r, 400)); // 跑完

    const client = await SseClient.connect(`http://127.0.0.1:${port}/api/runs/${runId}/stream`);
    await client.waitDone();
    const seqs = client.events.map((e) => e.id);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "序列单调递增");
    assert.ok(seqs.length >= 2, "事件非空");
    assert.ok(client.events.some((e) => e.event === "run.completed"), "含终态事件");
    assert.equal(new Set(seqs).size, seqs.length, "无重复");
    // id/event/data 帧格式已由解析器隐式验证
  } finally {
    await app.close();
  }
});

test("E08：运行中断连 → Last-Event-ID 重连补传（不丢/不重/顺序）", async () => {
  const base = setup("reconnect", OK_SCRIPT);
  // 800ms 延迟制造宽的断连窗口
  const app = makeApp(base, {
    async run(p) {
      await new Promise((r) => setTimeout(r, 800));
      return { type: "text", value: `v:${p}`, sessionId: "s" };
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const port = (app.server.address() as { port: number }).port;
    const created = await app.inject({ method: "POST", url: "/api/runs", payload: { projectId: "proj", path: "wf.js" } });
    const { runId } = created.json() as { runId: string };
    await new Promise((r) => setTimeout(r, 200)); // 等早期事件落盘，run 仍在跑

    // 第一段连接：收若干事件后主动断开
    const first = await SseClient.connect(`http://127.0.0.1:${port}/api/runs/${runId}/stream`);
    const early = await first.collect(1);
    await new Promise((r) => setTimeout(r, 100));
    first.controller.abort(); // 模拟断网/关页

    // 第二段：Last-Event-ID 重连，收齐到 done
    const lastId = first.events.at(-1)!.id;
    const second = await SseClient.connect(`http://127.0.0.1:${port}/api/runs/${runId}/stream`, { lastEventId: lastId });
    await second.waitDone();

    // 合并校验：无重复、无缺口（1..max 连续）、含终态
    const merged = [...early.map((e) => e.id), ...second.events.map((e) => e.id)];
    assert.equal(new Set(merged).size, merged.length, "两段合并不重复");
    const max = Math.max(...merged);
    assert.deepEqual([...new Set(merged)].sort((a, b) => a - b), Array.from({ length: max }, (_, i) => i + 1), "1..max 无缺口");
    assert.ok(second.events.some((e) => e.event === "run.completed"), "重连段收到终态");
    assert.ok(second.events.every((e) => e.id > lastId), "重连段全部在游标之后（去重）");
  } finally {
    await app.close();
  }
});

test("游标 query.lastEventId 兜底 + 未知 run 404", async () => {
  const base = setup("cursor", OK_SCRIPT);
  const app = makeApp(base, { async run(p) { return { type: "text", value: `v:${p}`, sessionId: "s" }; } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const port = (app.server.address() as { port: number }).port;
    const created = await app.inject({ method: "POST", url: "/api/runs", payload: { projectId: "proj", path: "wf.js" } });
    const { runId } = created.json() as { runId: string };
    await new Promise((r) => setTimeout(r, 400));

    const all = await SseClient.connect(`http://127.0.0.1:${port}/api/runs/${runId}/stream`);
    await all.waitDone();
    const lastId = all.events.at(-1)!.id;

    // query 游标：只应收到 done（游标已到末尾）
    const tail = await SseClient.connect(`http://127.0.0.1:${port}/api/runs/${runId}/stream?lastEventId=${lastId}`);
    await tail.waitDone();
    assert.equal(tail.events.length, 0, "游标在末尾 → 无补传事件");

    // 中间游标：只补传后半
    const mid = Math.floor(lastId / 2);
    const half = await SseClient.connect(`http://127.0.0.1:${port}/api/runs/${runId}/stream?lastEventId=${mid}`);
    await half.waitDone();
    assert.ok(half.events.every((e) => e.id > mid));
    assert.equal(half.events.length, all.events.length - mid);

    const nf = await app.inject({ method: "GET", url: "/api/runs/run-nope/stream" });
    assert.equal(nf.statusCode, 404);
    assert.equal((nf.json() as { code: string }).code, "RUN_NOT_FOUND");
  } finally {
    await app.close();
  }
});
