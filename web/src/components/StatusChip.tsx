import type { RunStatus } from "@server/contract";

const LABELS: Record<RunStatus, string> = {
  running: "执行中",
  waiting_checkpoint: "待审批",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

export function statusLabel(s: RunStatus): string {
  return LABELS[s] ?? s;
}

export default function StatusChip({ status }: { status: RunStatus }) {
  return <span className={`status-chip status-${status}`}>{statusLabel(status)}</span>;
}
