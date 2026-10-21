import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ProjectDto, ValidateResponse, WorkflowDto } from "@server/contract";
import { api, ApiRequestError } from "../api/client";

const NUMBER_FIELDS = [
  { key: "concurrency", label: "并发 concurrency", min: 1, placeholder: "如 4" },
  { key: "retries", label: "重试 retries", min: 0, placeholder: "如 1" },
  { key: "maxAgents", label: "最大 Agent 数 maxAgents", min: 1, placeholder: "如 20" },
  { key: "timeoutMs", label: "超时 timeoutMs (ms)", min: 1, placeholder: "如 600000" },
] as const;

type NumberKey = (typeof NUMBER_FIELDS)[number]["key"];

export default function NewRun() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [workflows, setWorkflows] = useState<WorkflowDto[] | null>(null);
  const [workflowPath, setWorkflowPath] = useState("");
  const [preview, setPreview] = useState<ValidateResponse | null>(null);
  const [argsText, setArgsText] = useState("");
  const [model, setModel] = useState("");
  const [numbers, setNumbers] = useState<Partial<Record<NumberKey, string>>>({});
  const [continueOnFailure, setContinueOnFailure] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 幂等键：表单交互起点生成；提交失败重试沿用同一键（防止重复创建）
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    api
      .projects()
      .then((r) => {
        setProjects(r.projects);
        if (r.projects.length > 0) setProjectId(r.projects[0].id);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!projectId) return;
    setWorkflows(null);
    setWorkflowPath("");
    setPreview(null);
    api
      .workflows(projectId)
      .then((r) => setWorkflows(r.workflows))
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [projectId]);

  // 前端预校验：选中即解析 meta（Server 端不执行 JS）
  useEffect(() => {
    if (!projectId || !workflowPath) {
      setPreview(null);
      return;
    }
    api
      .validate({ projectId, path: workflowPath })
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [projectId, workflowPath]);

  function parseNumbers(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const f of NUMBER_FIELDS) {
      const v = numbers[f.key]?.trim();
      if (!v) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < f.min) throw new Error(`${f.label} 需为 ≥${f.min} 的数字`);
      out[f.key] = n;
    }
    return out;
  }

  async function submit() {
    setError(null);
    if (!projectId || !workflowPath) {
      setError("请选择项目与工作流");
      return;
    }
    let args: unknown;
    if (argsText.trim()) {
      try {
        args = JSON.parse(argsText);
      } catch {
        setError("参数必须是合法 JSON");
        return;
      }
    }
    let numbersOut: Record<string, number>;
    try {
      numbersOut = parseNumbers();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.startRun({
        projectId,
        path: workflowPath,
        ...(args !== undefined ? { args } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...numbersOut,
        continueOnFailure: continueOnFailure || undefined,
        idempotencyKey,
      });
      navigate(`/runs/${res.runId}`);
    } catch (e) {
      if (e instanceof ApiRequestError) {
        const detail = e.details?.length ? `（${e.details.join("；")}）` : "";
        setError(`${e.message}${detail}${e.code === "RUN_LIMIT_REACHED" ? "——请等待现有 Run 结束或取消后再启动" : ""}`);
        // 幂等键保留：同键重试不会重复创建（网络错误时 Server 可能已受理）
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <div className="panel">
        <h2>无法加载项目列表</h2>
        <p className="error">{loadError}</p>
        <button className="primary" onClick={() => window.location.reload()}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>新建 Run</h2>

      {projects !== null && projects.length === 0 && (
        <div className="panel" style={{ background: "#fffbeb" }}>
          <b>Server 未配置任何项目白名单</b>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            在 pi-workflow.config.json 的 web.projectRoots 中登记工作流目录后重启 Server。
          </p>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!submitting) void submit();
        }}
      >
      <div className="row" style={{ marginBottom: 12 }}>
        <label>项目（白名单）</label>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={!projects}>
          {projects?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}（{p.id}）
            </option>
          ))}
        </select>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <label>工作流</label>
        <select value={workflowPath} onChange={(e) => setWorkflowPath(e.target.value)} disabled={!workflows}>
          <option value="">— 选择 —</option>
          {workflows?.map((w) => (
            <option key={w.path} value={w.path}>
              {w.path}
              {w.error ? "（解析失败）" : w.meta?.name ? ` · ${w.meta.name}` : ""}
            </option>
          ))}
        </select>
      </div>

      {preview && (
        <div className="panel" style={{ background: "#f8fafc" }}>
          <b>{preview.meta.name}</b>
          {preview.meta.description && <p className="muted" style={{ margin: "4px 0" }}>{preview.meta.description}</p>}
          <p className="muted" style={{ margin: 0 }}>
            {preview.phaseCount} 个阶段
            {preview.meta.phases?.length ? `：${preview.meta.phases.map((p) => p.title).join(" / ")}` : ""}
          </p>
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <label>参数 args（JSON，可空）</label>
        <textarea
          rows={3}
          style={{ width: "100%" }}
          placeholder='例如 {"topic": "..."}'
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
        />
      </div>

      <button className="ghost" onClick={() => setShowAdvanced(!showAdvanced)} style={{ marginBottom: 12 }}>
        {showAdvanced ? "收起" : "展开"}高级选项
      </button>

      {showAdvanced && (
        <div style={{ marginBottom: 12 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <label>模型 model</label>
            <input placeholder="留空用默认" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
          {NUMBER_FIELDS.map((f) => (
            <div className="row" style={{ marginBottom: 8 }} key={f.key}>
              <label>{f.label}</label>
              <input
                placeholder={f.placeholder}
                value={numbers[f.key] ?? ""}
                onChange={(e) => setNumbers({ ...numbers, [f.key]: e.target.value })}
              />
            </div>
          ))}
          <label>
            <input
              type="checkbox"
              checked={continueOnFailure}
              onChange={(e) => setContinueOnFailure(e.target.checked)}
            />{" "}
            节点失败继续（continueOnFailure）
          </label>
        </div>
      )}

      {error && <p className="error" style={{ whiteSpace: "pre-wrap" }}>{error}</p>}

      {workflows !== null && workflows.length === 0 && (
        <p className="muted">该项目下没有可用工作流（仅识别 .js/.mjs 且 meta 合法者）。</p>
      )}

      <div className="row">
        <button className="primary" type="submit" onClick={submit} disabled={submitting || !projectId || !workflowPath}>
          {submitting ? "启动中…" : "启动 Run"}
        </button>
        <span className="muted">幂等保护已启用：失败重试不会重复创建</span>
      </div>
      </form>
    </div>
  );
}
