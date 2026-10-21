import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { clearToken, getToken, setToken } from "./api/auth";
import { api } from "./api/client";

/** 无 token 时的门槛页：粘贴 Server 启动打印的 token，连通性验证后放行 */
function TokenGate({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function save() {
    const t = value.trim();
    if (!t) return;
    setChecking(true);
    setError(null);
    setToken(t);
    try {
      await api.projects(); // 连通+鉴权验证
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      clearToken();
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="gate">
      <h2>连接 pi-workflow Server</h2>
      <p>请粘贴 Server 启动时打印的 Web token（<code>pi-workflow web</code> 横幅中的 token）。</p>
      <div className="gate-row">
        <input
          type="password"
          placeholder="token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          autoFocus
        />
        <button onClick={save} disabled={checking || !value.trim()}>
          {checking ? "验证中…" : "连接"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export default function App() {
  const [hasToken, setHasToken] = useState(() => Boolean(getToken()));
  const [serverOk, setServerOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (!hasToken) return;
    api
      .health()
      .then(() => setServerOk(true))
      .catch(() => setServerOk(false));
  }, [hasToken]);

  if (!hasToken) {
    return <TokenGate onSaved={() => setHasToken(true)} />;
  }

  return (
    <div className="app">
      <header>
        <span className="brand">pi-workflow</span>
        <nav>
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/runs/new">New Run</NavLink>
        </nav>
        <span className={`server-dot ${serverOk ? "ok" : "bad"}`} title={serverOk ? "Server 在线" : "Server 不可达"}>
          {serverOk ? "在线" : serverOk === false ? "离线" : "…"}
        </span>
        <button
          className="ghost"
          onClick={() => {
            clearToken();
            setHasToken(false);
          }}
        >
          断开
        </button>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
