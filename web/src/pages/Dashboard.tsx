import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { RunStatus, RunSummaryDto } from "@server/contract";
import { api, ApiRequestError } from "../api/client";
import StatusChip from "../components/StatusChip";
import { formatDateTime, shortRunId } from "../util/format";

const ACTIVE: RunStatus[] = ["running"];
const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled", "interrupted"];

interface SectionProps {
  title: string;
  runs: RunSummaryDto[];
  empty: string;
  onOpen: (runId: string) => void;
}

function RunTable({ title, runs, empty, onOpen }: SectionProps) {
  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>{title}</h2>
        <span className="muted">{runs.length}</span>
      </div>
      {runs.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>名称</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr
                key={r.runId}
                className="clickable"
                tabIndex={0}
                aria-label={`打开 run ${shortRunId(r.runId)}（${r.effectiveStatus}）`}
                onClick={() => onOpen(r.runId)}
                onKeyDown={(e) => e.key === "Enter" && onOpen(r.runId)}
              >
                <td>
                  <code>{shortRunId(r.runId)}</code>
                </td>
                <td>{r.name || "—"}</td>
                <td>
                  <StatusChip status={r.effectiveStatus} />
                </td>
                <td>{formatDateTime(r.createdAt)}</td>
                <td>{formatDateTime(r.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<RunSummaryDto[] | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [historyFilter, setHistoryFilter] = useState<"all" | RunStatus>("all");

  const load = useCallback(async () => {
    try {
      const res = await api.listRuns({ pageSize: 200 });
      setRuns(res.runs);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e : null);
    }
  }, []);

  // 自动刷新：3s 轮询（页面隐藏时暂停，回前台立即刷一次）
  useEffect(() => {
    load();
    const timer = window.setInterval(() => {
      if (!document.hidden) load();
    }, 3000);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const groups = useMemo(() => {
    if (!runs) return { active: [], waiting: [], history: [] };
    const active = runs.filter((r) => ACTIVE.includes(r.effectiveStatus));
    const waiting = runs.filter((r) => r.effectiveStatus === "waiting_checkpoint");
    const history = runs.filter(
      (r) => TERMINAL.includes(r.effectiveStatus) && (historyFilter === "all" || r.effectiveStatus === historyFilter),
    );
    return { active, waiting, history };
  }, [runs, historyFilter]);

  if (error) {
    return (
      <div className="panel">
        <h2>无法加载 Run 列表</h2>
        <p className="error">
          {error.message}
          {error.code === "UNAUTHORIZED" && "（token 无效或已更换，请断开后重连）"}
          {error.status === 0 && "（Server 不可达，请确认 pi-workflow web 已启动）"}
        </p>
        <button className="primary" onClick={load}>
          重试
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="panel row">
        <div className="grow">
          <b>Run 总览</b> <span className="muted">每 3 秒自动刷新</span>
        </div>
        <button onClick={load}>立即刷新</button>
      </div>

      <RunTable
        title="待审批"
        runs={groups.waiting}
        empty="没有等待审批的 Run"
        onOpen={navigate}
      />
      <RunTable
        title="执行中"
        runs={groups.active}
        empty="当前没有执行中的 Run"
        onOpen={navigate}
      />

      <div className="panel">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>历史</h2>
          <select value={historyFilter} onChange={(e) => setHistoryFilter(e.target.value as "all" | RunStatus)}>
            <option value="all">全部终态</option>
            <option value="completed">已完成</option>
            <option value="failed">失败</option>
            <option value="cancelled">已取消</option>
            <option value="interrupted">已中断</option>
          </select>
        </div>
        {groups.history.length === 0 ? (
          <p className="empty">
            {runs && runs.length > 0 ? "当前筛选下没有历史 Run" : "暂无历史 Run，去 New Run 启动一个"}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>名称</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {groups.history.map((r) => (
                <tr
                  key={r.runId}
                  className="clickable"
                  tabIndex={0}
                  aria-label={`打开 run ${shortRunId(r.runId)}（${r.effectiveStatus}）`}
                  onClick={() => navigate(r.runId)}
                  onKeyDown={(e) => e.key === "Enter" && navigate(r.runId)}
                >
                  <td>
                    <code>{shortRunId(r.runId)}</code>
                  </td>
                  <td>{r.name || "—"}</td>
                  <td>
                    <StatusChip status={r.effectiveStatus} />
                  </td>
                  <td>{formatDateTime(r.createdAt)}</td>
                  <td>{formatDateTime(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
