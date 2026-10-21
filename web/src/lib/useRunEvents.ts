/**
 * useRunEvents —— RunDetail 的实时同步 hook（P2-05）。
 *
 * 生产 deps 接线：
 *  - fetchEvents ← api.events(runId, after)（磁盘增量/全量）
 *  - fetchSnapshot ← api.getRun(runId)（manifest 层状态+终态 result 用量）
 *  - openStream ← client.streamRun（SSE，Last-Event-ID 游标续传）
 *
 * 模型在 RunEventSync 内原地更新（applyEvent 幂等），onModel 引用回填 ref，version 计数驱动渲染。
 */
import { useEffect, useRef, useState } from "react";
import { api, streamRun, ApiRequestError } from "../api/client";
import type { CheckpointDto, EventsResponse, RunDetailResponse } from "@server/contract";
import { RunEventSync, type SnapshotLike } from "./run-event-sync";
import { emptyRunModel, type RunEventLike, type RunModel } from "./runModel";

export interface UseRunEventsResult {
  model: RunModel;
  snapshot: SnapshotLike | null;
  /** manifest 层审批清单（快照携带 + checkpoint.* 事件后补拉） */
  checkpoints: CheckpointDto[];
  connected: boolean;
  done: boolean;
  error: string | null;
  /** 重新同步（手动刷新） */
  refresh: () => void;
}

/** streamRun 已 JSON.parse 帧 data；这里只做形状校验 */
function parseFrameEvent(data: unknown): RunEventLike | null {
  const ev = data as RunEventLike | null;
  return ev && typeof ev.sequence === "number" && typeof ev.type === "string" ? ev : null;
}

export function useRunEvents(runId: string): UseRunEventsResult {
  const modelRef = useRef<RunModel>(emptyRunModel());
  const [version, setVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<SnapshotLike | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointDto[]>([]);
  const [connected, setConnected] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // version 仅作渲染信号（模型原地更新）
  void version;

  useEffect(() => {
    // runId 变化/手动刷新：全新模型与同步器
    modelRef.current = emptyRunModel();
    setSnapshot(null);
    setCheckpoints([]);
    setConnected(false);
    setDone(false);
    setError(null);

    const sync = new RunEventSync(
      {
        fetchEvents: async (after: number) => {
          const res: EventsResponse = await api.events(runId, after);
          return res.events.filter((e: EventsResponse["events"][number]): e is EventsResponse["events"][number] => {
            const ev = e as RunEventLike;
            return typeof ev.sequence === "number" && typeof ev.type === "string";
          }) as unknown as RunEventLike[];
        },
        fetchSnapshot: async () => {
          try {
            const res: RunDetailResponse = await api.getRun(runId);
            if (Array.isArray(res.checkpoints)) setCheckpoints(res.checkpoints);
            return (res.snapshot ?? null) as unknown as SnapshotLike;
          } catch (e) {
            if (e instanceof ApiRequestError && e.status === 404) return null;
            throw e;
          }
        },
        openStream: (lastEventId, observer, signal) =>
          streamRun(
            runId,
            lastEventId,
            {
              onEvent: ({ data }) => {
                const ev = parseFrameEvent(data);
                if (ev) {
                  observer.onFrame(ev);
                  // checkpoint 状态变化：manifest 层清单需补拉（事件流不含 CheckpointDto）
                  if (ev.type === "checkpoint.requested" || ev.type === "checkpoint.resolved") {
                    api
                      .checkpoints(runId)
                      .then((r) => setCheckpoints(r.checkpoints ?? []))
                      .catch(() => {/* 下次事件/刷新再拉 */});
                  }
                }
              },
              onDone: () => observer.onDone(),
            },
            signal,
          ),
        sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      },
      {
        onModel: (m) => {
          modelRef.current = m;
          setVersion((v) => v + 1);
        },
        onSnapshot: (s) => {
          setSnapshot(s);
          setVersion((v) => v + 1);
        },
        onConnectionChange: setConnected,
        onDone: () => setDone(true),
        onError: setError,
      },
    );
    sync.start();
    return () => sync.stop();
  }, [runId, nonce]);

  return {
    model: modelRef.current,
    snapshot,
    checkpoints,
    connected,
    done,
    error,
    refresh: () => setNonce((n) => n + 1),
  };
}
