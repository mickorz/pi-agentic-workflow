import { describe, expect, it } from "vitest";
import { applyEvents, emptyRunModel, usageFromSnapshot, type RunEventLike } from "./runModel";

function ev(sequence: number, type: string, extra: Partial<RunEventLike> = {}): RunEventLike {
  return {
    sequence,
    type,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, sequence * 100)).toISOString(),
    ...extra,
  };
}

describe("runModel.applyEvents", () => {
  it("层级：phase.started → node 归属正确 phase；未分阶段节点进兜底分组", () => {
    const m = applyEvents(emptyRunModel(), [
      ev(1, "run.started"),
      ev(2, "phase.started", { payload: { title: "root>准备" } }),
      ev(3, "node.started", { nodeId: "r:1", payload: { label: "分析", phase: "root>准备" } }),
      ev(4, "node.completed", { nodeId: "r:1", attempt: 1, payload: { label: "分析" } }),
      ev(5, "node.started", { nodeId: "r:2", payload: { label: "游离节点", phase: "其他" } }),
    ]);
    expect(m.phases.map((p) => p.title)).toEqual(["root>准备", "其他"]);
    expect(m.phases[0]!.nodeIds).toEqual(["r:1"]);
    expect(m.nodes["r:1"]!.status).toBe("ok");
  });

  it("attempt：失败重试后第二次成功——attempt=2、状态 ok、时间线两次都留痕", () => {
    const m = applyEvents(emptyRunModel(), [
      ev(1, "run.started"),
      ev(2, "node.started", { nodeId: "r:1", attempt: 1, payload: { label: "a" } }),
      ev(3, "node.failed", { nodeId: "r:1", attempt: 1, payload: { label: "a", error: "boom" } }),
      ev(4, "node.started", { nodeId: "r:1", attempt: 2, payload: { label: "a" } }),
      ev(5, "node.completed", { nodeId: "r:1", attempt: 2, payload: { label: "a" } }),
    ]);
    const n = m.nodes["r:1"]!;
    expect(n.status).toBe("ok");
    expect(n.attempt).toBe(2);
    expect(n.error).toBeUndefined();
    expect(m.timeline.filter((t) => t.type === "node.failed").length).toBe(1);
    expect(m.timeline.filter((t) => t.type === "node.completed").length).toBe(1);
  });

  it("replayed：无 node.started 的 journal 回放节点也能建出（状态 replayed）", () => {
    const m = applyEvents(emptyRunModel(), [
      ev(1, "run.started"),
      ev(2, "node.replayed", { nodeId: "r:1", payload: { label: "缓存命中" } }),
    ]);
    const n = m.nodes["r:1"]!;
    expect(n.status).toBe("replayed");
    expect(n.label).toBe("缓存命中");
  });

  it("去重：sequence 重复/过期事件被忽略（SSE 重连补传幂等）", () => {
    const m = applyEvents(emptyRunModel(), [
      ev(1, "run.started"),
      ev(2, "node.started", { nodeId: "r:1", payload: { label: "a" } }),
      ev(2, "node.started", { nodeId: "r:1", payload: { label: "a" } }), // 重复
      ev(1, "run.started"), // 过期
      ev(3, "node.completed", { nodeId: "r:1", payload: { label: "a" } }),
    ]);
    expect(m.timeline.length).toBe(3);
    expect(m.lastSequence).toBe(3);
  });

  it("null 业务结果不误判失败：node.completed / run.completed 与结果值无关", () => {
    const m = applyEvents(emptyRunModel(), [
      ev(1, "run.started"),
      ev(2, "phase.started", { payload: { title: "p" } }),
      ev(3, "node.started", { nodeId: "r:1", payload: { label: "a", phase: "p" } }),
      ev(4, "node.completed", { nodeId: "r:1", payload: { label: "a" } }),
      ev(5, "run.completed", { payload: { agentCount: 1 } }),
    ]);
    expect(m.nodes["r:1"]!.status).toBe("ok");
    expect(m.runStatus).toBe("completed");
    expect(m.agentCount).toBe(1);
  });

  it("耗时：started→completed 时间戳差", () => {
    const m = applyEvents(emptyRunModel(), [
      ev(1, "node.started", { nodeId: "r:1", payload: { label: "a" } }),
      ev(6, "node.completed", { nodeId: "r:1", payload: { label: "a" } }), // 500ms 后
    ]);
    expect(m.nodes["r:1"]!.durationMs).toBe(500);
  });
});

describe("runModel.usageFromSnapshot", () => {
  it("终态 result：汇总 tokens/cost + perNode 明细；无 tokens（fake runner）不误显", () => {
    const usage = usageFromSnapshot({
      result: {
        agentCount: 2,
        durationMs: 1200,
        agents: [
          { id: "r:1", tokens: 100, cost: 0.01, durationMs: 500, model: "m1", maxAttempts: 1 },
          { id: "r:2", durationMs: 700 },
        ],
      },
    });
    expect(usage!.agentCount).toBe(2);
    expect(usage!.tokens).toBe(100);
    expect(usage!.cost).toBeCloseTo(0.01);
    expect(usage!.perNode["r:2"]!.tokens).toBeUndefined();
  });

  it("kind=checkpoint 的伪 agent 不计入用量（runtime 把 checkpoint 节点写进 result.agents；agentCount 字段含它，展示层过滤）", () => {
    const usage = usageFromSnapshot({
      result: {
        agentCount: 4, // 含 checkpoint 伪 agent（探针：3 agent + 1 checkpoint → 4）
        durationMs: 2000,
        agents: [
          { id: "r:1", tokens: 100, durationMs: 500 },
          { id: "r:2", tokens: 100, durationMs: 500 },
          { id: "r:3", kind: "checkpoint", durationMs: 50 },
          { id: "r:4", tokens: 100, durationMs: 500 },
        ],
      },
    });
    expect(usage!.agentCount).toBe(3);
    expect(usage!.tokens).toBe(300);
    expect(usage!.perNode["r:3"]).toBeUndefined();
  });

  it("非终态/无 result → null", () => {
    expect(usageFromSnapshot({})).toBeNull();
    expect(usageFromSnapshot(undefined)).toBeNull();
  });
});
