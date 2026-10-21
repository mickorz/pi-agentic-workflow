/** 时间显示：本地短格式（MM-DD HH:mm:ss） */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** runId 短显（前 8 位） */
export function shortRunId(runId: string): string {
  return runId.length > 12 ? `${runId.slice(0, 8)}…` : runId;
}
