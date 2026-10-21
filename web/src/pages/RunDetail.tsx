import { useParams } from "react-router-dom";

export default function RunDetail() {
  const { runId } = useParams<{ runId: string }>();
  // P2-04/P2-05 实装：SSE 实时事件流 + checkpoint 审批 + resume/cancel
  return (
    <div className="panel">
      <h2>Run {runId}</h2>
      <p className="muted">详情与审批（P2-04/P2-05 实装）</p>
    </div>
  );
}
