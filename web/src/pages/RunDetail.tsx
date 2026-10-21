import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import StatusChip from "../components/StatusChip";
import { formatDateTime, shortRunId } from "../util/format";
import { usageFromSnapshot, type NodeModel, type RunModel } from "../lib/runModel";
import { useRunEvents } from "../lib/useRunEvents";
import CheckpointPanel from "../components/CheckpointPanel";
import RunActions from "../components/RunActions";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

function NodeRow({
  node,
  selected,
  onClick,
}: {
  node: NodeModel;
  selected: boolean;
  onClick: () => void;
}) {
  const icon =
    node.status === "ok" ? "✅" : node.status === "failed" ? "❌" : node.status === "replayed" ? "♻️" : "⏳";
  return (
    <div className={`node-row ${selected ? "selected" : ""} node-${node.status}`} onClick={onClick}>
      <span>{icon}</span>
      <span className="node-label">{node.label}</span>
      {node.attempt > 1 && <span className="badge">第 {node.attempt} 次</span>}
      {node.durationMs !== undefined && <span className="muted">{(node.durationMs / 1000).toFixed(1)}s</span>}
    </div>
  );
}

function Inspector({ node, model }: { node: NodeModel | null; model: RunModel }) {
  if (!node) {
    return (
      <div className="panel inspector">
        <h3>节点详情</h3>
        <p className="muted">点击左侧树中的节点查看详情</p>
      </div>
    );
  }
  const events = model.timeline.filter((t) => t.nodeId === node.id);
  const fields: Array<[string, string]> = [
    ["节点", node.id],
    ["标签", node.label],
    ["状态", node.status === "ok" ? "完成" : node.status === "failed" ? "失败" : node.status === "replayed" ? "回放（未重跑）" : "执行中"],
    ["尝试次数", node.attempt > 1 ? `${node.attempt} 次（重试）` : "1 次"],
    ["阶段", node.phase],
    ...(node.scopePath && node.scopePath.length > 1 ? [["嵌套路径", node.scopePath.join(" / ")]] as Array<[string, string]> : []),
    ...(node.startedAt ? [["开始", formatDateTime(node.startedAt)]] as Array<[string, string]> : []),
    ...(node.durationMs !== undefined ? [["耗时", `${(node.durationMs / 1000).toFixed(1)}s`]] as Array<[string, string]> : []),
    ...(node.sessionId ? [["会话", node.sessionId]] as Array<[string, string]> : []),
    ...(node.error ? [["错误", node.error]] as Array<[string, string]> : []),
  ];
  return (
    <div className="panel inspector">
      <h3>{node.label}</h3>
      <dl>
        {fields.map(([k, v]) => (
          <div className="kv" key={k}>
            <dt>{k}</dt>
            <dd className={k === "错误" ? "error" : undefined}>{v}</dd>
          </div>
        ))}
      </dl>
      {events.length > 0 && (
        <>
          <h4>该节点事件（新→旧）</h4>
          <ul className="timeline compact">
            {events
              .slice()
              .reverse()
              .map((e) => (
                <li key={e.sequence}>
                  <span className="muted">#{e.sequence}</span> {e.summary}
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default function RunDetail() {
  const { runId = "" } = useParams<{ runId: string }>();
  const { model, snapshot, checkpoints, connected, done, error, refresh } = useRunEvents(runId);
  const [selected, setSelected] = useState<string | null>(null);

  interface SnapView {
    meta?: { name?: string };
    createdAt?: string;
    updatedAt?: string;
    error?: string;
    effectiveStatus?: string;
    status?: string;
    [k: string]: unknown;
  }
  const snap = (snapshot ?? null) as SnapView | null;
  const effectiveStatus = snap?.effectiveStatus ?? snap?.status ?? model.runStatus ?? "running";
  const terminal = TERMINAL.has(effectiveStatus) && model.runStatus !== undefined;
  const noData = !snap && model.timeline.length === 0;

  const usage = useMemo(
    () => usageFromSnapshot(snap as { result?: unknown } | undefined),
    [snap, model.lastSequence],
  );
  const selectedNode = selected ? model.nodes[selected] ?? null : null;

  if (noData && error) {
    return (
      <div className="panel">
        <h2>无法加载 Run</h2>
        <p className="error">{error}</p>
        <button className="primary" onClick={() => refresh()}>
          重试
        </button>
      </div>
    );
  }
  return (
    <>
      <div className="panel">
        <div className="row">
          <h2 style={{ margin: 0 }}>
            <code>{shortRunId(runId)}</code> {snap?.meta?.name ?? ""}
          </h2>
          <StatusChip status={effectiveStatus as never} />
          <span className="muted">
            {terminal
              ? done
                ? "已同步完成"
                : "终态收敛中…"
              : connected
                ? "实时连接中（SSE）"
                : "连接已断开，自动重连中…"}
          </span>
          <span className="grow" />
          <RunActions runId={runId} effectiveStatus={effectiveStatus} onChanged={refresh} />
          <button onClick={() => refresh()}>重新同步</button>
        </div>
        {snap && (
          <p className="muted" style={{ margin: "8px 0 0" }}>
            创建 {formatDateTime(snap.createdAt)} · 更新 {formatDateTime(snap.updatedAt)}
            {snap.error ? ` · 错误：${snap.error}` : ""}
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </div>

      <CheckpointPanel
        runId={runId}
        checkpoints={checkpoints}
        waiting={effectiveStatus === "waiting_checkpoint"}
        onDecided={refresh}
      />

      <div className="detail-grid">
        <div className="panel tree">
          <h3>执行树</h3>
          {model.phases.length === 0 && <p className="empty">暂无节点事件</p>}
          {model.phases.map((ph) => (
            <div key={ph.title} className="phase-block">
              <div className="phase-title">{ph.title}</div>
              {ph.nodeIds.length === 0 && <p className="muted" style={{ margin: "2px 0 8px" }}>（无节点）</p>}
              {ph.nodeIds.map((id) => {
                const n = model.nodes[id]!;
                return <NodeRow key={id} node={n} selected={selected === id} onClick={() => setSelected(id)} />;
              })}
            </div>
          ))}
        </div>

        <div className="detail-right">
          <Inspector node={selectedNode} model={model} />

          <div className="panel">
            <h3>用量</h3>
            {usage ? (
              <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
                <span>agent 数：<b>{usage.agentCount}</b></span>
                <span>总耗时：<b>{(usage.durationMs / 1000).toFixed(1)}s</b></span>
                {usage.tokens !== undefined && <span>tokens：<b>{usage.tokens.toLocaleString()}</b></span>}
                {usage.cost !== undefined && usage.cost > 0 && (
                  <span>费用：<b>${usage.cost.toFixed(4)}</b></span>
                )}
                {usage.tokens === undefined && (
                  <span className="muted">（fake runner / 无用量数据）</span>
                )}
              </div>
            ) : (
              <p className="muted">Run 完成后展示 tokens/费用/耗时明细</p>
            )}
            {usage &&
              Object.entries(usage.perNode).length > 0 && (
                <table style={{ marginTop: 8 }}>
                  <thead>
                    <tr>
                      <th>节点</th>
                      <th>模型</th>
                      <th>tokens</th>
                      <th>费用</th>
                      <th>耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(usage.perNode).map(([id, u]) => (
                      <tr key={id} className="clickable" onClick={() => setSelected(id)}>
                        <td>
                          <code>{model.nodes[id]?.label ?? id}</code>
                        </td>
                        <td>{u.model ?? "—"}</td>
                        <td>{u.tokens !== undefined ? u.tokens.toLocaleString() : "—"}</td>
                        <td>{u.cost ? `$${u.cost.toFixed(4)}` : "—"}</td>
                        <td>{u.durationMs !== undefined ? `${(u.durationMs / 1000).toFixed(1)}s` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>事件时间线（新→旧，共 {model.timeline.length} 条）</h3>
        <ul className="timeline">
          {model.timeline
            .slice()
            .reverse()
            .map((e) => (
              <li key={e.sequence}>
                <span className="muted">#{e.sequence} {formatDateTime(e.timestamp)}</span>{" "}
                <span className={`ev-${e.type.replace(".", "-")}`}>{e.type}</span> {e.summary}
              </li>
            ))}
        </ul>
      </div>
    </>
  );
}
