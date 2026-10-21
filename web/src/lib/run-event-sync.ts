/**
 * RunEventSync —— Run 事件同步状态机（框架无关，P2-05 核心）。
 *
 * 职责（E16 断网/刷新恢复）：
 *  1. 启动先全量拉取 events(after=0)（页面刷新后从磁盘重建状态）；
 *  2. 打开 SSE 流（Last-Event-ID=lastSequence 游标续传）；
 *  3. 帧按 sequence 单调去重（applyEvent 幂等）；
 *  4. 断流/网络错 → 退避重连，重连前先按 offset 补漏（api.events(after=lastSeq)）；
 *  5. 收到 done 或快照终态 → 最后一次补拉+快照，停循环。
 *
 * 传输全部经 deps 注入（测试替换；生产走 api client + streamRun）。
 */
import { applyEvent, emptyRunModel, type RunEventLike, type RunModel } from "./runModel";

export interface SnapshotLike {
  status?: string;
  effectiveStatus?: string;
  [k: string]: unknown;
}

/** 流观察者：由 deps.openStream 实现回调（生产=streamRun 桥接，测试=脚本化） */
export interface StreamObserver {
  onFrame: (ev: RunEventLike) => void;
  onDone: () => void;
}

export interface RunEventSyncDeps {
  /** after=lastSequence 增量拉取（补洞/全量重建） */
  fetchEvents: (after: number) => Promise<RunEventLike[]>;
  /** 快照（含 effectiveStatus/result） */
  fetchSnapshot: () => Promise<SnapshotLike | null>;
  /** SSE 流：帧/经 observer 回调；流结束 resolve；异常 reject；signal 中止 */
  openStream: (lastEventId: string | null, observer: StreamObserver, signal: AbortSignal) => Promise<void>;
  /** 退避等待（测试注入假时钟） */
  sleep: (ms: number) => Promise<void>;
}

export interface RunEventSyncCallbacks {
  onModel?: (model: RunModel) => void;
  onSnapshot?: (snapshot: SnapshotLike | null) => void;
  onConnectionChange?: (connected: boolean) => void;
  onDone?: () => void;
  onError?: (message: string | null) => void;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const MAX_BACKOFF_MS = 5000;

export class RunEventSync {
  private readonly model: RunModel = emptyRunModel();
  private readonly controller = new AbortController();
  private stopped = false;
  private doneReceived = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly deps: RunEventSyncDeps,
    private readonly cb: RunEventSyncCallbacks = {},
  ) {}

  get lastSequence(): number {
    return this.model.lastSequence;
  }

  getModel(): RunModel {
    return this.model;
  }

  start(): void {
    if (this.loopPromise) return;
    this.loopPromise = this.loop().catch(() => {
      /* stop()/abort 已处理 */
    });
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort();
    this.cb.onConnectionChange?.(false);
  }

  private emit(ev: RunEventLike): void {
    applyEvent(this.model, ev);
    this.cb.onModel?.(this.model);
  }

  private isTerminal(snapshot: SnapshotLike | null): boolean {
    if (!snapshot) return false;
    const eff = (snapshot.effectiveStatus ?? snapshot.status) as string | undefined;
    return eff !== undefined && TERMINAL.has(eff);
  }

  private async loop(): Promise<void> {
    let attempts = 0;
    while (!this.stopped) {
      try {
        // ① 磁盘补拉（刷新重建 / 断连窗口补漏）：after=lastSequence
        const missed = await this.deps.fetchEvents(this.model.lastSequence);
        for (const ev of missed) this.emit(ev);
        if (this.stopped) return;

        // ② 快照（effectiveStatus/result 等 manifest 层信息事件流没有）
        const snapshot = await this.deps.fetchSnapshot();
        this.cb.onSnapshot?.(snapshot);
        if (this.stopped) return;

        // 终态且事件已齐（run.* 终态事件已入 model）→ 尾拉一次后收敛
        if (this.isTerminal(snapshot) && this.model.runStatus !== undefined) {
          const tail = await this.deps.fetchEvents(this.model.lastSequence);
          for (const ev of tail) this.emit(ev);
          this.cb.onDone?.();
          this.cb.onConnectionChange?.(false);
          return;
        }

        // ③ SSE 增量流
        this.doneReceived = false;
        this.cb.onError?.(null);
        this.cb.onConnectionChange?.(true);
        await this.deps.openStream(
          this.model.lastSequence > 0 ? String(this.model.lastSequence) : null,
          {
            onFrame: (e) => this.emit(e),
            onDone: () => {
              this.doneReceived = true;
            },
          },
          this.controller.signal,
        );
        this.cb.onConnectionChange?.(false);
        if (this.doneReceived || this.stopped) {
          // done 帧已收：最后补一次快照（拿终态 result/usage）再停
          const fin = await this.deps.fetchSnapshot();
          this.cb.onSnapshot?.(fin);
          this.cb.onDone?.();
          return;
        }
        // 流被关但无 done（网络/服务端异常）→ 退避重连
        attempts += 1;
        this.cb.onError?.("连接中断，重连中…");
        await this.deps.sleep(Math.min(attempts * 500, MAX_BACKOFF_MS));
      } catch (e) {
        if (this.stopped || this.controller.signal.aborted) return;
        attempts += 1;
        this.cb.onConnectionChange?.(false);
        this.cb.onError?.(e instanceof Error ? `连接失败：${e.message}` : "连接失败，重连中…");
        try {
          await this.deps.sleep(Math.min(attempts * 500, MAX_BACKOFF_MS));
        } catch {
          return; // sleep 中止（stop）
        }
      }
    }
  }
}
