// 测试专用 Provider：注入故障 + 调用计数（A02/A03/A04/A05/A06/A11/A14 的事实源）。
// 配置（环境变量）：
//   TEST_CALLS_FILE  每次调用追加一行 JSONL {id, ts}
//   TEST_FAULT_FILE  JSON {"<item-id>": {failTimes: n, code, recoverable, slowMs}}
//   TEST_SLOW_MS     全局每图耗时注入（A14 并发窗口用）
// 输出文件本体复用 fake.mjs 的 encodePng（确定性、零依赖）。
import fsp from "node:fs/promises";
import path from "node:path";
import { encodePng, FAKE_SIZES, GenError } from "../../lib/providers/fake.mjs";

export const providerId = "test-fake";
export const defaultModel = "test-1";

async function readFaults() {
  const f = process.env.TEST_FAULT_FILE;
  if (!f) return {};
  try {
    return JSON.parse(await fsp.readFile(f, "utf8"));
  } catch {
    return {};
  }
}

export async function generate({ id, kind, prompt, outPath, signal }) {
  const started = Date.now();
  if (process.env.TEST_CALLS_FILE) {
    await fsp.appendFile(process.env.TEST_CALLS_FILE, JSON.stringify({ id, ts: started }) + "\n");
  }
  const faults = await readFaults();
  const f = faults[id] ?? {};
  if (f.slowMs || process.env.TEST_SLOW_MS) {
    const ms = f.slowMs ?? Number(process.env.TEST_SLOW_MS);
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new GenError("E_ABORTED", "aborted in slow window", { recoverable: true }));
      });
    });
  }
  if (f.failTimes > 0) {
    f.failTimes -= 1;
    faults[id] = f;
    await fsp.writeFile(process.env.TEST_FAULT_FILE, JSON.stringify(faults));
    throw new GenError(f.code ?? "E_TIMEOUT", `injected failure for ${id}`, { recoverable: f.recoverable ?? true });
  }
  const size = FAKE_SIZES[kind === "cover" ? "cover" : "body"];
  const png = encodePng(size.width, size.height, prompt + (f.variant ?? ""));
  await fsp.mkdir(path.dirname(outPath), { recursive: true }).catch(() => {});
  await fsp.writeFile(outPath, png);
  return {
    path: outPath,
    mime: "image/png",
    bytes: png.length,
    format: "png",
    width: size.width,
    height: size.height,
    model: defaultModel,
    provider: providerId,
    durationMs: Date.now() - started,
  };
}
