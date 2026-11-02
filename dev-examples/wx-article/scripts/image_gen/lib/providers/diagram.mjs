// diagram Provider（2026-11-02 阶段 1）：示意图脱离 ChatGPT 直出（mermaid 静态）。
// 设计：dev-docs/design/2026-11-02-示意图GIF直出方案分析.md（分图型路由决策记录）
//
// 链路：条目 diagram_source（mermaid 源码，经 generate() 的 diagramSource 字段透传）
//   → drawskills vendored 渲染器（Node，beautiful-mermaid 缺依赖自动安装）：
//     node <drawskills>/vendor/pretty-mermaid/scripts/render.mjs
//       --input <tmp>.mmd --output <outPath> --format png --theme <theme> --width <n>
//   → PNG 落 outPath（文件名来自条目 filename，.png/.gif 均可——当前阶段仅产 PNG）。
//
// 失败分类：E_NO_SOURCE（条目未带 diagram_source，不可恢复——该条目应改走 image-use）；
//          E_ABORTED（外部中断，可恢复）；E_RENDERER（渲染器缺失/失败/产物核验失败）。
// 主题：DIAGRAM_THEME 环境变量（默认 github-light，公众号白底）；宽度 DIAGRAM_WIDTH（默认 1600）。
// 依赖说明：livepanel GIF 直出为阶段 2（drawskills 内建 --format gif）；本阶段仅 mermaid 静态 PNG。
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";

export const providerId = "diagram";
export const defaultModel = "mermaid";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// drawskills 技能目录：默认用户 Claude 技能目录，可用 DRAWSKILLS_DIR 覆盖
const DRAWSKILLS_DIR = process.env.DRAWSKILLS_DIR || join(os.homedir(), ".claude", "skills", "drawskills");
const RENDER_SCRIPT = join(DRAWSKILLS_DIR, "vendor", "pretty-mermaid", "scripts", "render.mjs");
const DEFAULT_THEME = process.env.DIAGRAM_THEME || "github-light";
const DEFAULT_WIDTH = process.env.DIAGRAM_WIDTH || "1600";
const RENDER_TIMEOUT_MS = 300_000;
// livepanel：Windows/macOS 渲染脚本与 Chrome 路径（可用环境变量覆盖）
const LIVEPANEL_SCRIPTS = join(DRAWSKILLS_DIR, "vendor", "live-panel", "scripts");
const IS_WIN = process.platform === "win32";
const LIVEPANEL_PY = process.env.DIAGRAM_PYTHON || (IS_WIN ? "python" : "python3");
const LIVEPANEL_RENDERER = IS_WIN ? "render_win.py" : "render.py";
const CHROME_PATH = process.env.CHROME_PATH
  || (IS_WIN ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
           : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");

class GenError extends Error {
  constructor(code, message, { recoverable = false } = {}) {
    super(message);
    this.name = "GenError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

/** 读 PNG IHDR 宽高（fake.mjs 同款手法；渲染器产物必为 PNG） */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return { width: null, height: null };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function runRenderer(args, signal) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [RENDER_SCRIPT, ...args], { signal });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (e) => reject(new GenError("E_RENDERER", `渲染器启动失败：${e.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = (stderr || stdout).trim().split("\n").slice(-3).join(" | ");
        reject(new GenError("E_RENDERER", `渲染器退出码 ${code}：${tail.slice(0, 200)}`));
      }
    });
  });
}

function runPython(args, signal) {
  return new Promise((resolve, reject) => {
    const proc = spawn(LIVEPANEL_PY, args, { signal, timeout: RENDER_TIMEOUT_MS });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (e) => reject(new GenError("E_RENDERER", `渲染进程启动失败：${e.message}`)));
    proc.on("close", (code, killedByTimeout) => {
      if (code === 0) resolve();
      else {
        const why = killedByTimeout ? "超时" : `exit ${code}`;
        const tail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
        reject(new GenError("E_RENDERER", `livepanel 渲染失败（${why}）：${tail}`));
      }
    });
  });
}

/** livepanel 引擎：JSON config → GIF 直出（阶段 2 改造后 render 脚本内建 --format gif） */
async function generateLivepanel(source, outPath, signal, started) {
  if (signal?.aborted) throw new GenError("E_ABORTED", "aborted before start", { recoverable: true });
  if (!String(outPath).toLowerCase().endsWith(".gif")) {
    throw new GenError("E_BAD_TARGET", "livepanel 输出必须为 .gif（条目 filename 请以 .gif 结尾）");
  }
  let cfg;
  try {
    cfg = typeof source === "string" ? JSON.parse(source) : source;
  } catch (e) {
    throw new GenError("E_NO_SOURCE", `diagram_source 不是合法的 livepanel JSON：${e.message}`);
  }
  if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.elements)) {
    throw new GenError("E_NO_SOURCE", "livepanel config 缺少 elements 数组");
  }
  // 决策记录 #4：公众号白底默认浅色主题；时长/帧率缺省 8s@12
  cfg.theme = cfg.theme || {};
  if (!cfg.theme.preset) cfg.theme.preset = "light-pastel";
  cfg.canvas = cfg.canvas || {};
  if (!cfg.canvas.duration) cfg.canvas.duration = 8;
  if (!cfg.canvas.fps) cfg.canvas.fps = 12;
  const tmpCfg = join(os.tmpdir(), `livepanel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await fsp.writeFile(tmpCfg, JSON.stringify(cfg), "utf8");
  const renderer = join(LIVEPANEL_SCRIPTS, LIVEPANEL_RENDERER);
  if (!fs.existsSync(renderer)) {
    throw new GenError("E_RENDERER", `livepanel 渲染脚本不存在：${renderer}（检查 DRAWSKILLS_DIR）`);
  }
  try {
    await runPython([renderer, "--config", tmpCfg, "--out", outPath, "--format", "gif", "--chrome", CHROME_PATH], signal);
  } finally {
    await fsp.rm(tmpCfg, { force: true }).catch(() => {});
  }
  const buf = await fsp.readFile(outPath);
  const canvasW = cfg.canvas.width ?? 800;
  const canvasH = cfg.canvas.height ?? 500;
  const width = Math.min(canvasW, 800);
  const height = Math.round((canvasH * width) / canvasW);
  return {
    path: outPath,
    mime: "image/gif",
    bytes: buf.length,
    format: "gif",
    width,
    height,
    model: "livepanel",
    provider: providerId,
    durationMs: Date.now() - started,
  };
}

/**
 * 统一 Provider 接口。diagramSource 由 generate.mjs 调用点从条目 diagram_source 透传；
 * prompt（风格头+画面描述）对本 provider 无渲染意义，仅进 manifest 留档。
 */
export async function generate({ diagramSource, diagramEngine, outPath, signal }) {
  const started = Date.now();
  if (signal?.aborted) throw new GenError("E_ABORTED", "aborted before start", { recoverable: true });
  const engine = String(diagramEngine ?? "mermaid").toLowerCase();
  if (engine === "livepanel") return generateLivepanel(diagramSource, outPath, signal, started);
  if (engine !== "mermaid") {
    throw new GenError("E_ENGINE", `未知 diagram_engine：${engine}（支持 mermaid | livepanel）`);
  }
  const source = String(diagramSource ?? "").trim();
  if (!source) {
    throw new GenError("E_NO_SOURCE", "条目缺少 diagram_source（mermaid 源码）——示意图直出条目须带该字段，纯概念图请走 image-use");
  }
  if (!fs.existsSync(RENDER_SCRIPT)) {
    throw new GenError("E_RENDERER", `渲染器不存在：${RENDER_SCRIPT}（可用 DRAWSKILLS_DIR 指定 drawskills 目录）`);
  }

  const tmpMmd = join(os.tmpdir(), `diagram-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mmd`);
  await fsp.writeFile(tmpMmd, source, "utf8");
  try {
    await runRenderer(
      ["--input", tmpMmd, "--output", outPath, "--format", "png", "--theme", DEFAULT_THEME, "--width", String(DEFAULT_WIDTH)],
      signal,
    );
  } finally {
    await fsp.rm(tmpMmd, { force: true }).catch(() => {});
  }

  const buf = await fsp.readFile(outPath);
  if (buf.length === 0) throw new GenError("E_RENDERER", "渲染产物为空");
  const { width, height } = pngSize(buf);
  return {
    path: outPath,
    mime: "image/png",
    bytes: buf.length,
    format: "png",
    width,
    height,
    model: defaultModel,
    provider: providerId,
    durationMs: Date.now() - started,
  };
}
