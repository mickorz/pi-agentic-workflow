/**
 * CheckpointPanel —— checkpoint 审批面板（P2-06，E15）。
 *
 * 原则：
 *  - 绝不自动批准：决策只由用户点击「批准 / 拒绝」触发，组件挂载/刷新从不发 decision 请求；
 *  - 拒绝不给一键误触：点击后需二次「确认拒绝」；
 *  - 乐观并发冲突（409 CONFLICT / RESUME_MISMATCH / CHECKPOINT_NOT_PENDING）：
 *    提示「已在别处处理」并自动刷新快照，不重试决策。
 */
import { useState } from "react";
import type { CheckpointDto } from "@server/contract";
import { api, ApiRequestError } from "../api/client";
import { shortRunId } from "../util/format";

/** 决策冲突类错误：不重试，刷新即可看到他人决策结果 */
export function isDecisionConflict(err: unknown): boolean {
  if (!(err instanceof ApiRequestError)) return false;
  return err.code === "CONFLICT" || err.code === "RESUME_MISMATCH" || err.code === "CHECKPOINT_NOT_PENDING";
}

const STATUS_LABEL: Record<string, string> = {
  pending: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
};

export default function CheckpointPanel({
  runId,
  checkpoints,
  waiting,
  onDecided,
}: {
  runId: string;
  checkpoints: CheckpointDto[];
  /** manifest 层已在等待（checkpoints 元数据尚未同步时兜底提示） */
  waiting: boolean;
  /** 决策完成/冲突后重同步（refresh()） */
  onDecided: () => void;
}) {
  const pending = checkpoints.filter((c) => c.status === "pending");
  const decided = checkpoints.filter((c) => c.status !== "pending");
  const [busy, setBusy] = useState<Record<string, "approve" | "reject" | undefined>>({});
  const [confirming, setConfirming] = useState<Record<string, "approve" | "reject" | undefined>>({});
  const [notice, setNotice] = useState<{ id: string; kind: "conflict" | "error"; text: string } | null>(null);

  if (pending.length === 0 && decided.length === 0 && !waiting) return null;

  const decide = async (cp: CheckpointDto, decision: "approve" | "reject"): Promise<void> => {
    const id = cp.checkpointId;
    setBusy((b) => ({ ...b, [id]: decision }));
    setNotice(null);
    try {
      await api.decideCheckpoint(runId, id, { decision, expectedVersion: cp.version });
      setConfirming((c) => ({ ...c, [id]: undefined }));
      onDecided(); // 重同步：checkpoint.resolved 事件 + manifest 状态
    } catch (err) {
      if (isDecisionConflict(err)) {
        setNotice({
          id,
          kind: "conflict",
          text: "审批冲突：该 checkpoint 已在别处处理（或版本已变化），正在刷新最新状态…",
        });
        onDecided();
      } else {
        setNotice({
          id,
          kind: "error",
          text: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      setBusy((b) => ({ ...b, [id]: undefined }));
    }
  };

  return (
    <div className="panel checkpoint-panel">
      <h3>⏸ Checkpoint 审批</h3>
      {pending.length === 0 && waiting && <p className="muted">Run 正在等待 checkpoint（元数据同步中…）</p>}
      {pending.map((cp) => {
        const mode = confirming[cp.checkpointId];
        return (
          <div className="checkpoint-card" key={cp.checkpointId}>
            <div className="row">
              <span className="checkpoint-q">{cp.question}</span>
              <span className="badge" title="乐观并发版本号，决策时必须匹配">v{cp.version}</span>
            </div>
            <p className="muted" style={{ margin: "4px 0 8px" }}>
              <code>{shortRunId(cp.checkpointId)}</code>
              {cp.requestedAt ? ` · 请求于 ${new Date(cp.requestedAt).toLocaleString()}` : ""}
              {cp.nodeId ? ` · 节点 ${cp.nodeId}` : ""}
            </p>
            <div className="row">
              {mode === "approve" ? (
                <>
                  <span className="warn">确认批准？副作用将真实执行。</span>
                  <button className="primary" disabled={busy[cp.checkpointId] !== undefined} onClick={() => void decide(cp, "approve")}>
                    {busy[cp.checkpointId] === "approve" ? "批准中…" : "确认批准"}
                  </button>
                  <button disabled={busy[cp.checkpointId] !== undefined} onClick={() => setConfirming((c) => ({ ...c, [cp.checkpointId]: undefined }))}>
                    返回
                  </button>
                </>
              ) : mode === "reject" ? (
                <>
                  <span className="warn">确认拒绝？人工拒绝将强停止流程（不可降级重试）。</span>
                  <button className="danger" disabled={busy[cp.checkpointId] !== undefined} onClick={() => void decide(cp, "reject")}>
                    {busy[cp.checkpointId] === "reject" ? "拒绝中…" : "确认拒绝"}
                  </button>
                  <button disabled={busy[cp.checkpointId] !== undefined} onClick={() => setConfirming((c) => ({ ...c, [cp.checkpointId]: undefined }))}>
                    返回
                  </button>
                </>
              ) : (
                <>
                  <button className="primary" disabled={busy[cp.checkpointId] !== undefined} onClick={() => setConfirming((c) => ({ ...c, [cp.checkpointId]: "approve" }))}>
                    批准…
                  </button>
                  <button className="danger" disabled={busy[cp.checkpointId] !== undefined} onClick={() => setConfirming((c) => ({ ...c, [cp.checkpointId]: "reject" }))}>
                    拒绝…
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
      {notice && <p className={notice.kind === "conflict" ? "warn" : "error"}>{notice.text}</p>}
      {decided.length > 0 && (
        <div className="checkpoint-history">
          <h4>历史决策</h4>
          <ul>
            {decided.map((cp) => (
              <li key={cp.checkpointId}>
                <span className={`status-chip ${cp.status === "approved" ? "status-completed" : "status-failed"}`}>
                  {STATUS_LABEL[cp.status] ?? cp.status}
                </span>{" "}
                <code>{shortRunId(cp.checkpointId)}</code> {cp.question}
                {cp.decidedAt ? <span className="muted"> · {new Date(cp.decidedAt).toLocaleString()}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
