#!/usr/bin/env node
/**
 * P3-05 跨平台最小 smoke（纯 Node，无 bash 依赖，Windows/macOS/Linux 通用）：
 *   build → 启动 Web Server（fake runner）→ health / 401 / token / projects /
 *   POST run → SSE 订阅收到事件与 done → manifest 终态 completed → 清理。
 *
 * 用法：node dev-examples/v2-web/xplat-smoke.mjs   （需先 npm run build）
 * 退出码 0 = 全过；非 0 = 有失败（逐项打印 PASS/FAIL）。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.XPLAT_PORT ?? 4691);
const TOKEN = "xplat-fixed-token-0123456789abcdef";
const BASE_URL = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log(`PASS: ${m}`); };
const bad = (m) => { fail++; console.log(`FAIL: ${m}`); };
const eq = (name, expected, actual) => (expected === actual ? ok(`${name}（=${actual}）`) : bad(`${name}：期望 ${expected} 实际 ${actual}`));

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "p305-xplat-"));
const srv = {
  stdout: "",
  stderr: "",
};
let child = null;

async function up(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/api/health`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function api(method, url, body, token = TOKEN) {
  const res = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json, text };
}

/** 读 SSE 流直到 done 或拿到 minEvents 条 message 帧 */
function readStream(runId, minEvents, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSE 超时")), timeoutMs);
    fetch(`${BASE_URL}/api/runs/${runId}/stream`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then(async (res) => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const events = [];
      let buf = "";
      let done = false;
      while (!done) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = { event: "message", data: "" };
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) ev.event = line.slice(6).trim();
            else if (line.startsWith("data:")) ev.data += line.slice(5).trim();
          }
          if (ev.event === "done") { done = true; break; }
          if (ev.event !== "heartbeat" && ev.data) events.push(ev);
        }
        if (events.length >= minEvents && !done) { /* 继续读直到 done */ }
      }
      clearTimeout(timer);
      resolve({ events, gotDone: done });
    }).catch((e) => { clearTimeout(timer); reject(e); });
  });
}

async function main() {
  // 0) dist 存在（构建产物）
  const distOk = fs.existsSync(path.join(REPO, "dist", "cli", "index.js"));
  distOk ? ok("dist 构建产物存在") : bad("dist 缺失（先 npm run build）");

  // 1) 准备项目白名单 + 固定 token 配置
  const projDir = path.join(BASE, "proj");
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "ok.js"), `export const meta = { name: "xplat_demo" }\nconst a = await agent("hi")\nreturn a\n`);
  fs.writeFileSync(path.join(BASE, "pi-workflow.config.json"), JSON.stringify({
    web: { port: PORT, token: TOKEN, projectRoots: [projDir] },
  }));

  // 2) 启动 Server（cwd=BASE，fake runner）
  child = spawn(process.execPath, [path.join(REPO, "dist", "cli", "index.js"), "web", "--config", BASE, "--port", String(PORT)], {
    cwd: BASE,
    env: { ...process.env, PI_WORKFLOW_TEST_RUNNER: "fake", PI_WORKFLOW_FAKE_DELAY_MS: "150", PI_WORKFLOW_HEARTBEAT_MS: "1000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { srv.stdout += d; });
  child.stderr.on("data", (d) => { srv.stderr += d; });

  const ready = await up(20_000);
  if (!ready) {
    bad(`Server 未就绪。stderr 尾部：${srv.stderr.slice(-500)}`);
    return finish(1);
  }
  ok("Server 启动 + health 200");

  // 3) 安全面：无 token 401；错 Origin 403
  eq("无 token → 401", 401, (await api("GET", "/api/runs", undefined, null)).status);
  eq("跨 Origin → 403", 403, (await fetch(`${BASE_URL}/api/runs`, { headers: { authorization: `Bearer ${TOKEN}`, origin: "http://evil.example" } })).status);

  // 4) projects 枚举
  const projects = await api("GET", "/api/projects");
  eq("projects 200", 200, projects.status);
  eq("白名单项目数=1", 1, projects.json?.projects?.length ?? -1);

  // 5) POST run（fake runner）→ 202 → completed
  const started = await api("POST", "/api/runs", { projectId: projects.json.projects[0].id, path: "ok.js" });
  eq("POST /api/runs → 202", 202, started.status);
  const runId = started.json?.runId;
  if (!runId) { bad("无 runId"); return finish(1); }

  // 6) SSE：事件帧 + done 收敛
  try {
    const { events, gotDone } = await readStream(runId, 1, 30_000);
    eq("SSE 事件帧 ≥1", true, events.length >= 1);
    eq("SSE done 收敛", true, gotDone);
  } catch (e) {
    bad(`SSE 读取失败：${e.message}`);
  }

  // 7) 终态核对
  const deadline = Date.now() + 20_000;
  let detail = null;
  while (Date.now() < deadline) {
    detail = await api("GET", `/api/runs/${runId}`);
    if (detail.json?.snapshot?.status === "completed") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  eq("run 终态 completed", "completed", detail.json?.snapshot?.status ?? "timeout");

  finish(fail === 0 ? 0 : 1);
}

function finish(code) {
  console.log(`\n== 结果：PASS=${pass} FAIL=${fail} ==`);
  if (child) {
    try {
      child.kill(); // POSIX SIGTERM / Windows 终止
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* noop */ } }, 2000).unref?.();
    } catch { /* noop */ }
  }
  setTimeout(() => {
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* noop */ }
    process.exit(code);
  }, 300);
}

main().catch((e) => { bad(`主流程异常：${e?.stack ?? e}`); finish(1); });
