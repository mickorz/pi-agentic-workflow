/**
 * P2-05 sync-driver —— 用真实 Server 驱动 RunEventSync（框架无关状态机）做 E2E 冒烟。
 *
 * 环境变量：BASE_URL / TOKEN / PROJECT / SCRIPT / PHASE
 * 阶段：
 *   phase1 rebuild —— 创建 run 等终态后，全新 sync：全量补拉重建模型+不开流+done
 *   phase2 watch  —— 创建 long run 实时收帧；stdout 打 WATCH-READY 后由外部 kill/restart
 *                    Server；sync：断连报错→退避重连→补漏→interrupted+done，序列连续无缺口无重复。
 */
import { RunEventSync, type StreamObserver } from "/Users/michaelchang/Desktop/WorkProjects/pi-agentic-workflow/web/src/lib/run-event-sync.ts";
import type { RunEventLike } from "/Users/michaelchang/Desktop/WorkProjects/pi-agentic-workflow/web/src/lib/runModel.ts";

const BASE = process.env.BASE_URL!;
const TOKEN = process.env.TOKEN!;
const PROJECT = process.env.PROJECT!;
const SCRIPT = process.env.SCRIPT!;
const PHASE = process.env.PHASE!;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? `（${detail}）` : ""}`);
  if (!ok) failures += 1;
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

async function createRun(script: string): Promise<string> {
  const res = await fetch(`${BASE}/api/runs`, {
    method: "POST",
    headers: { ...headers(), "Idempotency-Key": `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    body: JSON.stringify({ projectId: PROJECT, path: script }),
  });
  if (res.status !== 202) throw new Error(`createRun HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { runId: string };
  return body.runId;
}

async function getRun(runId: string): Promise<{ status?: string; effectiveStatus?: string } | null> {
  const res = await fetch(`${BASE}/api/runs/${runId}`, { headers: headers() });
  if (res.status === 404) return null;
  const body = (await res.json()) as { snapshot?: { status?: string; effectiveStatus?: string } };
  return body.snapshot ?? null;
}

async function waitForTerminal(runId: string): Promise<string> {
  for (let i = 0; i < 120; i++) {
    const s = await getRun(runId);
    const eff = s?.effectiveStatus ?? s?.status ?? "";
    if (["completed", "failed", "cancelled", "interrupted"].includes(eff)) return eff;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("waitForTerminal 超时");
}

interface LiveStatus {
  lastSequence: number;
  connected: boolean;
  done: boolean;
  errorSeen: boolean;
  connDropped: boolean;
  streamCalls: number;
  snapshot: { status?: string; effectiveStatus?: string } | null;
  runStatus?: string;
  sequences: number[];
}

function log(msg: string): void {
  console.error(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}

function drive(runId: string): { promise: Promise<LiveStatus>; status: LiveStatus } {
  const st: LiveStatus = {
    lastSequence: 0,
    connected: false,
    done: false,
    errorSeen: false,
    connDropped: false,
    streamCalls: 0,
    snapshot: null,
    sequences: [],
  };
  const sync = new RunEventSync(
    {
      fetchEvents: async (after: number) => {
        const res = await fetch(`${BASE}/api/runs/${runId}/events?after=${after}`, { headers: headers() });
        if (res.status === 404) return [];
        if (!res.ok) throw new Error(`events HTTP ${res.status}`);
        const body = (await res.json()) as { events: RunEventLike[] };
        return body.events;
      },
      fetchSnapshot: async () => (await getRun(runId)) as unknown as Record<string, unknown> | null,
      openStream: (lastEventId: string | null, observer: StreamObserver, signal: AbortSignal) => {
        st.streamCalls += 1;
        log(`openStream #${st.streamCalls} lastEventId=${lastEventId ?? "-"}`);
        return (async () => {
          const h: Record<string, string> = { ...headers() };
          if (lastEventId) h["Last-Event-ID"] = lastEventId;
          const res = await fetch(`${BASE}/api/runs/${runId}/stream`, { headers: h, signal });
          if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            buf += decoder.decode(value, { stream: true });
            let sep: number;
            while ((sep = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              let event = "message";
              const dataLines: string[] = [];
              for (const line of frame.split("\n")) {
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
              }
              if (event === "done") {
                observer.onDone();
                return;
              }
              // event 字段= WorkflowEvent.type（run.completed 等）；仅忽略 heartbeat/无 data 帧
              if (event === "heartbeat" || dataLines.length === 0) continue;
              try {
                observer.onFrame(JSON.parse(dataLines.join("\n")) as RunEventLike);
              } catch {
                /* 非 JSON 帧忽略 */
              }
            }
          }
        })();
      },
      sleep: (ms: number) => new Promise<void>((res) => setTimeout(res, ms)),
    },
    {
      onModel: (m) => {
        st.lastSequence = m.lastSequence;
        st.runStatus = m.runStatus;
        st.sequences = m.timeline.map((t) => t.sequence);
        log(`onModel lastSeq=${m.lastSequence} runStatus=${m.runStatus ?? "-"} timeline=${m.timeline.length}`);
      },
      onSnapshot: (s) => {
        st.snapshot = s as unknown as LiveStatus["snapshot"];
      },
      onConnectionChange: (c) => {
        log(`conn=${c}`);
        if (c) st.connected = true;
        else st.connDropped = true;
      },
      onDone: () => {
        log("onDone");
        st.done = true;
      },
      onError: (msg) => {
        log(`onError: ${msg ?? "-"}`);
        if (msg) st.errorSeen = true; // loop 起始的 onError(null) 不算错误
      },
    },
  );
  sync.start();
  const promise = new Promise<LiveStatus>((resolve) => {
    const t = setInterval(() => {
      if (st.done) {
        clearInterval(t);
        setTimeout(() => resolve(st), 50); // 留一个 tick 给最终快照
      }
    }, 100);
    setTimeout(() => {
      clearInterval(t);
      resolve(st); // 兜底超时
    }, 120_000);
  });
  return { promise, status: st };
}

async function waitSeq(status: LiveStatus, min: number): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (status.lastSequence >= min && status.connected) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main(): Promise<void> {
  if (PHASE === "phase1") {
    const runId = await createRun(SCRIPT);
    const eff = await waitForTerminal(runId);
    check("phase1 前置：ok.js run 到终态 completed", eff === "completed", `effectiveStatus=${eff}`);
    const { promise } = drive(runId);
    const r = await promise;
    check("刷新重建：模型从磁盘全量恢复", r.lastSequence >= 2, `lastSequence=${r.lastSequence}`);
    check("刷新重建：runStatus=completed", r.runStatus === "completed", `runStatus=${r.runStatus}`);
    check("刷新重建：终态不开 SSE 流", r.streamCalls === 0, `streamCalls=${r.streamCalls}`);
    check("刷新重建：done 收敛", r.done);
    check("刷新重建：序列严格递增", r.sequences.every((s, i) => i === 0 || s > r.sequences[i - 1]), r.sequences.join(","));
  } else if (PHASE === "phase2") {
    const runId = await createRun(SCRIPT);
    console.log(`RUN_ID=${runId}`);
    const { promise, status } = drive(runId);
    await waitSeq(status, 3);
    console.log("WATCH-READY"); // 外部此刻 kill Server
    const r = await promise;
    check("断流：期间出现连接错误/断开", r.errorSeen && r.connDropped, `errorSeen=${r.errorSeen} connDropped=${r.connDropped}`);
    check("重连：至少开过 2 次流", r.streamCalls >= 2, `streamCalls=${r.streamCalls}`);
    // Server 被 SIGKILL 后：孤儿 Worker 收 stdin EOF → gracefulShutdown 主动 cancel → cancelled；
  // Worker 也死透才是 interrupted。两者均为合法收敛（E16 要求的是终态收敛+序列无缺口）。
  check("重连：快照终态收敛（cancelled 或 interrupted）",
    r.snapshot?.effectiveStatus === "cancelled" || r.snapshot?.effectiveStatus === "interrupted",
    `eff=${r.snapshot?.effectiveStatus} lastSeq=${r.lastSequence} runStatus=${r.runStatus ?? "-"}`);
    check("重连：done 收敛", r.done);
    const uniq = new Set(r.sequences);
    check("重连：序列无重复", uniq.size === r.sequences.length, `total=${r.sequences.length} uniq=${uniq.size}`);
    check("重连：序列连续 1..N 无缺口", r.sequences.every((s, i) => s === i + 1), r.sequences.join(","));
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("DRIVER-ERROR:", e);
  process.exit(1);
});
