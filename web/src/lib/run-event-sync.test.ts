/**
 * RunEventSync 状态机测试（P2-05/E16）：
 * 刷新重建 / SSE 增量 / 断流退避重连+补洞 / done 收敛 / stop 幂等。
 */
import { describe, expect, it, vi } from "vitest";
import { RunEventSync, type RunEventSyncDeps, type SnapshotLike } from "./run-event-sync";
import type { RunEventLike } from "./runModel";

function ev(sequence: number, type: string, payload?: Record<string, unknown>): RunEventLike {
  return { sequence, timestamp: new Date().toISOString(), type, payload };
}

interface StreamCtl {
  frame: (e: RunEventLike) => void;
  done: () => void;
  error: (e: Error) => void;
}

interface Harness {
  diskEvents: RunEventLike[];
  openStreamCalls: Array<string | null>;
  sleepCalls: number[];
  snapshots: Array<SnapshotLike | null>;
  deps: RunEventSyncDeps;
  seqs: number[];
  doneCalls: number;
  connChanges: boolean[];
  errors: Array<string | null>;
}

function makeHarness(): Harness {
  const h: Harness = {
    diskEvents: [],
    openStreamCalls: [],
    sleepCalls: [],
    snapshots: [],
    deps: null as unknown as RunEventSyncDeps,
    seqs: [],
    doneCalls: 0,
    connChanges: [],
    errors: [],
  };
  h.deps = {
    fetchEvents: vi.fn(async (after: number) => h.diskEvents.filter((e) => e.sequence > after)),
    fetchSnapshot: vi.fn(async () => h.snapshots[h.snapshots.length - 1] ?? null),
    openStream: vi.fn(async (lastEventId: string | null) => {
      h.openStreamCalls.push(lastEventId);
      return await new Promise<void>(() => {});
    }),
    // 记录退避时长，但真实让出事件循环（瞬时 resolve 会把循环变成纯微任务热循环饿死事件循环）
    sleep: async (ms: number) => {
      h.sleepCalls.push(ms);
      await new Promise((r) => setTimeout(r, 0));
    },
  };
  return h;
}

function makeSync(h: Harness): RunEventSync {
  return new RunEventSync(h.deps, {
    onModel: (m) => {
      h.seqs = m.timeline.map((t) => t.sequence);
    },
    onConnectionChange: (c) => h.connChanges.push(c),
    onDone: () => {
      h.doneCalls += 1;
    },
    onError: (msg) => h.errors.push(msg),
  });
}

/** 脚本化流：每次 openStream 消费一条脚本；帧同时落"磁盘"并经 observer 直通模型（生产语义：Worker 单写落盘，断连重连靠 fetchEvents 补漏） */
function scriptedStreams(h: Harness, scripts: Array<(ctl: StreamCtl) => void>) {
  let scriptIdx = 0;
  h.deps.openStream = (lastEventId: string | null, observer) => {
    h.openStreamCalls.push(lastEventId);
    const script = scripts[Math.min(scriptIdx, scripts.length - 1)];
    scriptIdx += 1;
    return new Promise<void>((resolve, reject) => {
      script({
        frame: (e) => {
          h.diskEvents.push(e); // 帧也落"磁盘"（真实语义：Worker 单写落盘，断连重连靠 fetchEvents 补漏）
          observer.onFrame(e); // 帧直通模型
        },
        done: () => {
          observer.onDone();
          resolve();
        },
        error: (err: Error) => reject(err),
      });
    });
  };
}

/** 真实时钟 flush：驱动微任务链跑完一轮循环（sleep 为注入立即 resolve，无需假时钟） */
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("RunEventSync", () => {

  it("刷新重建：终态 run 全量补拉后不开流直接收敛", async () => {
    const h = makeHarness();
    h.diskEvents = [ev(1, "run.started"), ev(2, "phase.started"), ev(3, "run.completed", { agentCount: 1 })];
    h.snapshots.push({ status: "completed", effectiveStatus: "completed" });
    scriptedStreams(h, [() => {}]);
    const sync = makeSync(h);
    sync.start();
    await flush();

    expect(h.seqs).toEqual([1, 2, 3]);
    expect(h.openStreamCalls).toEqual([]); // 终态+runStatus 已定 → 不开流
    expect(h.doneCalls).toBe(1);
    expect(sync.getModel().runStatus).toBe("completed");
  });

  it("运行中：SSE 增量帧入模型，done 后最终快照并停止", async () => {
    const h = makeHarness();
    h.diskEvents = [ev(1, "run.started")];
    h.snapshots.push({ status: "running", effectiveStatus: "running" });
    scriptedStreams(h, [
      (ctl) =>
        queueMicrotask(() => {
          ctl.frame(ev(2, "node.started", { label: "a1" }));
          ctl.frame(ev(3, "node.completed", { label: "a1" }));
          ctl.frame(ev(4, "run.completed", { agentCount: 1 }));
          ctl.done();
        }),
    ]);
    const sync = makeSync(h);
    sync.start();
    await flush();

    expect(h.openStreamCalls).toEqual(["1"]);
    expect(h.seqs).toEqual([1, 2, 3, 4]);
    expect(sync.getModel().runStatus).toBe("completed");
    expect(h.doneCalls).toBe(1);
    // done 后不再重连
    await flush();
    expect(h.openStreamCalls).toHaveLength(1);
  });

  it("断流重连：无 done 断开 → 退避 → 补漏帧 → 以新游标续开", async () => {
    const h = makeHarness();
    h.diskEvents = [ev(1, "run.started")];
    h.snapshots.push({ status: "running", effectiveStatus: "running" });
    scriptedStreams(h, [
      // 第一次流：发帧 2 后异常断开（无 done）
      (ctl) =>
        queueMicrotask(() => {
          ctl.frame(ev(2, "node.started", { label: "a1" }));
          // 断连窗口内磁盘仍进了帧 3（Worker 单写），前端漏收
          h.diskEvents.push(ev(3, "node.completed", { label: "a1" }));
          ctl.error(new Error("aborted"));
        }),
      // 第二次流：帧 4 + done
      (ctl) =>
        queueMicrotask(() => {
          ctl.frame(ev(4, "run.completed", { agentCount: 1 }));
          ctl.done();
        }),
    ]);
    const sync = makeSync(h);
    sync.start();
    await flush();

    expect(h.openStreamCalls[0]).toBe("1");
    expect(h.sleepCalls).toEqual([500]); // 退避被调
    await flush();

    // 重连补漏：fetchEvents(2) 拿回帧 3 → 第二次开流游标=3
    expect(h.openStreamCalls[1]).toBe("3");
    expect(h.seqs).toEqual([1, 2, 3, 4]);
    expect(sync.getModel().runStatus).toBe("completed");
    expect(h.doneCalls).toBe(1);
  });

  it("stop()：abort 循环且不再重连", async () => {
    const h = makeHarness();
    h.diskEvents = [ev(1, "run.started")];
    h.snapshots.push({ status: "running", effectiveStatus: "running" });
    scriptedStreams(h, [
      (ctl) => queueMicrotask(() => ctl.error(new Error("net down"))),
    ]);
    const sync = makeSync(h);
    sync.start();
    await flush();
    sync.stop();
    const opensBefore = h.openStreamCalls.length;
    await flush();
    expect(h.openStreamCalls).toHaveLength(opensBefore);
    expect(h.doneCalls).toBe(0);
  });
});
