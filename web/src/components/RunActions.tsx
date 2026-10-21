/**
 * RunActions —— 取消/恢复操作（P2-07，E11）。
 *
 * 原则：
 *  - 取消按钮只在可取消态（running / waiting_checkpoint）出现；
 *  - 取消需二次确认（防误操作）；
 *  - 恢复面板默认不带副作用确认发起——若服务端裁定需要确认（409 SIDE_EFFECTS_UNACKNOWLEDGED），
 *    明确提示并停住，绝不自动带 ack 重试（E11：副作用确认缺失不执行）；
 *    用户勾选「副作用已确认」后才以 acknowledgeSideEffects:true 重新发起。
 */
import { useState } from "react";
import { api, ApiRequestError } from "../api/client";

const CANCELLABLE = new Set(["running", "waiting_checkpoint"]);
const RESUMABLE = new Set(["failed", "cancelled", "interrupted"]);

export default function RunActions({
  runId,
  effectiveStatus,
  onChanged,
}: {
  runId: string;
  effectiveStatus: string;
  /** 取消/恢复成功或冲突后重同步 */
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "cancel-confirm" | "resume-panel">("idle");
  const [busy, setBusy] = useState(false);
  const [ackChecked, setAckChecked] = useState(false);
  const [notice, setNotice] = useState<{ kind: "warn" | "error"; text: string } | null>(null);

  const cancellable = CANCELLABLE.has(effectiveStatus);
  const resumable = RESUMABLE.has(effectiveStatus);

  const doCancel = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await api.cancel(runId);
      setMode("idle");
      onChanged();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const doResume = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      // E11：勾选框未勾 → 不带 ack；服务端若要求确认则 409，绝不静默自动补 ack 重试
      await api.resume(runId, { acknowledgeSideEffects: ackChecked });
      setMode("idle");
      setAckChecked(false);
      onChanged();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "SIDE_EFFECTS_UNACKNOWLEDGED") {
        setNotice({
          kind: "warn",
          text: "该 run 中断时已有执行记录：恢复可能重复未记 journal 节点的副作用。勾选下方确认后方可恢复。",
        });
      } else if (err instanceof ApiRequestError && err.code === "RUN_STILL_ACTIVE") {
        setNotice({ kind: "warn", text: "run 仍在运行中，无需恢复（正在刷新…）。" });
        onChanged();
      } else if (err instanceof ApiRequestError && err.code === "RUN_LIMIT_REACHED") {
        setNotice({ kind: "warn", text: "并发 Run 上限已满：等待现有 Run 结束或取消其一。" });
      } else {
        setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setBusy(false);
    }
  };

  if (!cancellable && !resumable && mode === "idle") return null;

  return (
    <div className="run-actions">
      {mode === "idle" && (
        <span className="row" style={{ gap: 8 }}>
          {cancellable && (
            <button className="danger" disabled={busy} onClick={() => setMode("cancel-confirm")}>
              取消…
            </button>
          )}
          {resumable && (
            <button disabled={busy} onClick={() => setMode("resume-panel")}>
              恢复…
            </button>
          )}
        </span>
      )}

      {mode === "cancel-confirm" && (
        <span className="row" style={{ gap: 8 }}>
          <span className="warn">确认取消？执行中的 agent 会被中止，已执行节点副作用不回滚。</span>
          <button className="danger" disabled={busy} onClick={() => void doCancel()}>
            {busy ? "取消中…" : "确认取消"}
          </button>
          <button disabled={busy} onClick={() => setMode("idle")}>
            返回
          </button>
        </span>
      )}

      {mode === "resume-panel" && (
        <div className="resume-panel">
          <p className="muted" style={{ margin: "4px 0" }}>
            恢复 = 从 journal 断点续跑：已执行节点不会重跑，未执行节点继续。
          </p>
          <label className="row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={ackChecked}
              onChange={(e) => setAckChecked(e.target.checked)}
            />
            <span>我确认了解恢复可能重复未记 journal 节点的副作用</span>
          </label>
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            <button className="primary" disabled={busy} onClick={() => void doResume()}>
              {busy ? "恢复中…" : ackChecked ? "带副作用确认恢复" : "尝试恢复"}
            </button>
            <button disabled={busy} onClick={() => { setMode("idle"); setNotice(null); setAckChecked(false); }}>
              返回
            </button>
          </div>
        </div>
      )}

      {notice && <p className={notice.kind === "warn" ? "warn" : "error"}>{notice.text}</p>}
    </div>
  );
}
