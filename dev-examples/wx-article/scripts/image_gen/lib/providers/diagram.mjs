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
const RENDER_TIMEOUT_MS = 120_000;

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

/**
 * 统一 Provider 接口。diagramSource 由 generate.mjs 调用点从条目 diagram_source 透传；
 * prompt（风格头+画面描述）对本 provider 无渲染意义，仅进 manifest 留档。
 */
export async function generate({ diagramSource, outPath, signal }) {
  const started = Date.now();
  if (signal?.aborted) throw new GenError("E_ABORTED", "aborted before start", { recoverable: true });
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
