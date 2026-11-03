/**
 * GZH 排版预览页(T0.3,方案 V2 4.2)
 *
 * 结构:左侧文章信息/工具栏 + iframe(huasheng 编辑器,/huasheng/index.html 同源加载)。
 * 职责边界:编辑器负责编辑与主题切换(自身下拉框),本页负责 加载/拉取/保存/脏状态;
 * 编辑器不持有任何文件权限(发布隔离)。
 * 协议:postMessage 6 消息(D1);article:get:request 带超时,不无限等待。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { gzhApi, type GzhArticle, type GzhArticleListItem } from "../api/gzh";

const EDITOR_SRC = "/huasheng/index.html";
const GET_TIMEOUT_MS = 3000;

type EditorMsg =
  | { type: "editor:ready" }
  | { type: "article:dirty"; dirtyType: "content" | "style" }
  | { type: "article:get:response"; requestId: string; markdown: string; style: string }
  | { type: "article:export:response"; requestId: string; html: string; style: string };

export default function GzhPreview() {
  const [params, setParams] = useSearchParams();
  const dir = params.get("dir") ?? "";
  const [article, setArticle] = useState<GzhArticle | null>(null);
  const [list, setList] = useState<GzhArticleListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [contentDirty, setContentDirty] = useState(false);
  const [styleDirty, setStyleDirty] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sessionIdRef = useRef(`gzh-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  // 拉取响应回调表(按 requestId 配对;带超时)
  const pendingGetRef = useRef(new Map<string, { resolve: (v: { markdown: string; style: string }) => void; timer: number }>());
  const pendingExportRef = useRef(new Map<string, { resolve: (v: { html: string; style: string }) => void; timer: number }>());

  const send = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ sessionId: sessionIdRef.current, ...msg }, window.location.origin);
  }, []);

  const requestContent = useCallback(
    (): Promise<{ markdown: string; style: string }> =>
      new Promise((resolve, reject) => {
        const requestId = `get-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const timer = window.setTimeout(() => {
          pendingGetRef.current.delete(requestId);
          reject(new Error("编辑器响应超时(3s),未保存;请检查编辑器状态后重试"));
        }, GET_TIMEOUT_MS);
        pendingGetRef.current.set(requestId, { resolve, timer });
        send({ type: "article:get:request", requestId });
      }),
    [send],
  );

  const requestExport = useCallback(
    (): Promise<{ html: string; style: string }> =>
      new Promise((resolve, reject) => {
        const requestId = `exp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const timer = window.setTimeout(() => {
          pendingExportRef.current.delete(requestId);
          reject(new Error("编辑器导出超时(3s)"));
        }, GET_TIMEOUT_MS);
        pendingExportRef.current.set(requestId, { resolve, timer });
        send({ type: "article:export:request", requestId });
      }),
    [send],
  );

  // iframe 消息监听(编辑器方向)
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.origin !== window.location.origin) return;
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const d = ev.data as EditorMsg & { sessionId?: string };
      if (!d || typeof d !== "object") return;
      if (d.type === "editor:ready") {
        setEditorReady(true);
        return;
      }
      if (d.sessionId !== sessionIdRef.current) return; // 会话串扰防护
      if (d.type === "article:dirty") {
        if (d.dirtyType === "content") setContentDirty(true);
        if (d.dirtyType === "style") setStyleDirty(true);
      } else if (d.type === "article:get:response") {
        const pending = pendingGetRef.current.get(d.requestId);
        if (pending) {
          window.clearTimeout(pending.timer);
          pendingGetRef.current.delete(d.requestId);
          pending.resolve({ markdown: d.markdown, style: d.style });
        }
      } else if (d.type === "article:export:response") {
        const pending = pendingExportRef.current.get(d.requestId);
        if (pending) {
          window.clearTimeout(pending.timer);
          pendingExportRef.current.delete(d.requestId);
          pending.resolve({ html: d.html, style: d.style });
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      pendingGetRef.current.forEach((p) => window.clearTimeout(p.timer));
      pendingGetRef.current.clear();
      pendingExportRef.current.forEach((p) => window.clearTimeout(p.timer));
      pendingExportRef.current.clear();
    };
  }, []);

  // 加载文章(后端);注入交给下方双就绪 effect(ready 与 article 任一后到都能触发)
  useEffect(() => {
    if (!dir) {
      gzhApi
        .listArticles()
        .then((r) => setList(r.articles))
        .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
      return;
    }
    setArticle(null);
    setLoadError(null);
    setContentDirty(false);
    setStyleDirty(false);
    gzhApi
      .loadArticle(dir)
      .then((a) => setArticle(a))
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [dir]);

  // 注入时机:editor:ready 与 article 双就绪才发 article:load。
  // 竞态防护:bridge 的消息监听器在其脚本执行时才注册,宿主提前 postMessage 会丢消息;
  // 故绝不直接发送,一律等 editor:ready(切文章时 ready 已是 true,article 变化即重发)。
  // 幂等键:仅 dir 或 ready 变化才重注入 —— 保存后 setArticle 不得触发重注入覆盖用户后续输入。
  const injectedKeyRef = useRef("");
  useEffect(() => {
    if (!editorReady || !article) return;
    const key = `${article.dir}#${editorReady ? 1 : 0}`;
    if (injectedKeyRef.current === key) return;
    injectedKeyRef.current = key;
    send({ type: "article:load", markdown: article.markdown, style: article.style || "wechat-default" });
    setContentDirty(false);
    setStyleDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorReady, article, send]);

  // 未保存提醒(仅内容脏;切主题不拦截)
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (contentDirty) e.preventDefault();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [contentDirty]);

  async function save() {
    if (!article) return;
    setSaving(true);
    setStatus("");
    try {
      const current = await requestContent();
      const base = article;
      const changedMd = current.markdown !== base.markdown;
      const changedStyle = current.style !== base.style && current.style !== base.style;
      const wantSaveMd = contentDirty || changedMd;
      const wantSaveStyle = styleDirty || changedStyle;
      if (!wantSaveMd && !wantSaveStyle) {
        setStatus("没有需要保存的改动");
        return;
      }
      const result = await gzhApi.save({
        dir: base.dir,
        ...(wantSaveMd ? { markdown: current.markdown, baseMdHash: base.mdHash } : {}),
        ...(wantSaveStyle ? { style: current.style, baseStyleHash: base.styleHash || undefined } : {}),
      });
      setArticle({
        ...base,
        markdown: current.markdown,
        style: current.style,
        mdHash: result.mdHash ?? base.mdHash,
        styleHash: result.styleHash ?? base.styleHash,
      });
      setContentDirty(false);
      setStyleDirty(false);
      setStatus(`已保存:${result.saved.join("、")};发布前请重跑 check_state`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(msg.includes("已被其他进程修改") ? `${msg}(请刷新重新加载)` : `保存失败:${msg}`);
    } finally {
      setSaving(false);
    }
  }

  async function exportLayout() {
    if (!article) return;
    setStatus("");
    try {
      const ex = await requestExport();
      if (!ex.html || ex.html.length < 100) {
        setStatus("导出失败:编辑器渲染内容为空");
        return;
      }
      const r = await gzhApi.exportLayout(article.dir, ex.html);
      setStatus(`已导出 layout.html(${Math.round(r.size / 1024)}KB,主题 ${ex.style});publish 可用 --html-file`);
    } catch (e) {
      setStatus(`导出失败:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!dir) {
    return (
      <section className="gzh-preview">
        <h2>GZH 排版预览</h2>
        <p className="hint">选择要预览的文章目录(vault 内最近修改的 30 篇):</p>
        {loadError && <p className="error">{loadError}</p>}
        {list === null && !loadError && <p>加载中…</p>}
        <ul className="gzh-article-list">
          {(list ?? []).map((a) => (
            <li key={a.dir}>
              <button className="link" onClick={() => setParams({ dir: a.dir })}>
                {a.title}
              </button>
              <span className="meta">
                {a.drafted ? "[已入箱]" : ""} {new Date(a.mtime).toLocaleString()} {a.style ? `主题:${a.style}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section className="gzh-preview">
      <header className="gzh-toolbar">
        <button className="ghost" onClick={() => setParams({})}>
          返回列表
        </button>
        <strong>{article?.mdName ?? dir}</strong>
        <span className={`dirty ${contentDirty ? "on" : ""}`}>{contentDirty ? "[正文未保存]" : "[正文已同步]"}</span>
        <span className={`dirty ${styleDirty ? "on" : ""}`}>{styleDirty ? "[主题未保存]" : "[主题已同步]"}</span>
        <button onClick={save} disabled={!article || !editorReady || saving}>
          {saving ? "保存中…" : "保存"}
        </button>
        <button className="ghost" onClick={exportLayout} disabled={!article || !editorReady}>
          导出渲染 HTML
        </button>
        <span className="status">{status}</span>
      </header>
      <p className="hint">
        P0 说明:主题切换仅影响预览效果,不改变入箱样式(publish 链路不变);正文保存后才写文章目录。
        {article?.yaml.digest ? ` digest:${article.yaml.digest.slice(0, 30)}` : ""}
      </p>
      {loadError && <p className="error">{loadError}(dir={dir})</p>}
      <iframe ref={iframeRef} src={EDITOR_SRC} title="gzh-editor" className="gzh-editor-frame" />
    </section>
  );
}
