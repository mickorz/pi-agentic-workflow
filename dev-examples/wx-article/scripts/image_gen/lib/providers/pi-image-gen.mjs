// 真实 Provider：@amaster.ai/pi-image-gen（P0 T0.4 已真实验证 8.1s cogview-3-flash）。
// 智谱兼容层：customProviders + fetchImpl 去掉固定 n:1（智谱对显式 n 报 HTTP 429 + code 1314，P0 实测坑）。
// 配置来源：IMAGE_GEN_API_KEY / IMAGE_GEN_BASE_URL / IMAGE_GEN_MODEL 环境变量（缺省 zhipu cogview-3-flash）。
import { generateImage, loadImageGenSettings } from "@amaster.ai/pi-image-gen";
import path from "node:path";
import fsp from "node:fs/promises";

export const providerId = "pi-image-gen";

const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

export function buildSettings(env = process.env) {
  const apiKey = env.IMAGE_GEN_API_KEY;
  const baseUrl = env.IMAGE_GEN_BASE_URL || ZHIPU_BASE_URL;
  const modelId = env.IMAGE_GEN_MODEL || "cogview-3-flash";
  if (!apiKey) {
    const err = new Error("IMAGE_GEN_API_KEY is not set (pi-image-gen provider)");
    err.code = "E_NO_KEY";
    throw err;
  }
  return {
    cwd: process.cwd(),
    settings: {
      ...loadImageGenSettings({ cwd: process.cwd() }),
      defaultModel: modelId,
      customProviders: [
        {
          id: "zhipu",
          api: "openai",
          baseUrl,
          apiKey,
          models: [{ id: modelId }],
        },
      ],
    },
    modelId,
  };
}

/** 去掉 pi-image-gen openai adapter 固定发送的 n:1（智谱 429 伪装业务错误，见 P0 报告） */
function zhipuFetchPatch() {
  return async (url, init = {}) => {
    if (typeof init.body === "string" && init.body.includes('"n"')) {
      try {
        const body = JSON.parse(init.body);
        if (typeof body.n === "number") delete body.n;
        init = { ...init, body: JSON.stringify(body) };
      } catch {
        /* 非 JSON body 原样透传 */
      }
    }
    return fetch(url, init);
  };
}

function mapError(e) {
  const msg = String(e?.message ?? e);
  const err = new Error(msg);
  err.code = "E_PROVIDER";
  // 限流/网关类 → 可重试；参数/鉴权类 → 不可重试（清单见 P0 报告错误分类表）。
  // 智谱 1314「企业套餐已失效」实测是限流/配额伪装码（P0 报告）：映射为可恢复。
  err.recoverable =
    /\b(429|rate|limit|timeout|econnreset|econnrefused|etimedout|5\d\d)\b/i.test(msg) ||
    /1314|套餐已失效/.test(msg);
  if (e?.name === "AbortError" || /abort/i.test(msg)) {
    err.code = "E_ABORTED";
    err.recoverable = true;
  }
  return err;
}

/**
 * 统一接口（与 fake.mjs 相同签名）：
 * generate({ id, kind, prompt, outPath, model, signal, context, reference })
 * reference：风格参考图路径（pi-image-gen 支持图生图，传 image: [reference]）
 * 单次尝试硬超时（缺省 180s，env IMAGE_GEN_TIMEOUT_MS 覆盖）：provider 内部可能无超时，
 * 外层 Promise.race 兑底防挂起（T1.10 实测：限流后请求可挂 10min+）。
 */
export async function generate({ kind, prompt, outPath, model, signal, context = {}, reference }) {
  const cfg = context.settings ?? buildSettings();
  const useModel = model ?? cfg.modelId;
  const started = Date.now();
  const deadlineMs = Number(context.timeoutMs ?? process.env.IMAGE_GEN_TIMEOUT_MS ?? 180_000);
  const attemptSignal = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(deadlineMs)]);
  // pi-image-gen 把 filename 当 stem，实际扩展名由返回 MIME 决定（MIME_TO_EXT）
  const stem = path.basename(outPath).replace(/\.[a-z0-9]+$/i, "");
  try {
    const result = await generateImage(
      { prompt, filename: stem, outputDir: path.dirname(outPath), image: reference ? [reference] : undefined },
      {
        cwd: cfg.cwd,
        settings: { ...cfg.settings, defaultModel: useModel },
        fetchImpl: zhipuFetchPatch(),
        signal: attemptSignal,
      },
    );
    const img = result?.images?.[0];
    if (!img?.path) throw new Error("provider returned no image");
    // pi-image-gen 按 filename 写文件；核验存在后归一化返回
    await fsp.access(img.path);
    const bytes = (await fsp.stat(img.path)).size;
    return {
      path: img.path,
      mime: mimeFromExt(path.extname(img.path)),
      bytes,
      format: (path.extname(img.path) || "").replace(".", "").toLowerCase(),
      width: img.width ?? null,
      height: img.height ?? null,
      model: result.model ?? useModel,
      provider: result.provider ?? providerId,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    // 外层 deadline 触发时把挂起请求转成可重试超时
    if (attemptSignal.aborted && !signal?.aborted && e?.name !== "AbortError") {
      const err = new Error(`attempt deadline ${deadlineMs}ms exceeded`);
      err.code = "E_TIMEOUT";
      err.recoverable = true;
      throw err;
    }
    throw mapError(e);
  }
}

export function mimeFromExt(ext = "") {
  const e = ext.toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".webp") return "image/webp";
  return "application/octet-stream";
}
