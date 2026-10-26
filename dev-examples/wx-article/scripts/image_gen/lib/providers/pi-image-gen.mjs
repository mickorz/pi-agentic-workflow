// 真实 Provider：@amaster.ai/pi-image-gen（P0 T0.4 已真实验证 8.1s cogview-3-flash）。
// 通用 OpenAI 兼容层：任何 OpenAI API 格式的文生图端点用三件套接入——
//   IMAGE_GEN_API_KEY / IMAGE_GEN_BASE_URL / IMAGE_GEN_MODEL（缺省智谱 cogview-3-flash）。
// 智谱特化补丁（去 n:1、1314 错误码识别）仅智谱域名生效，非智谱端点走标准 wire format。
import { generateImage, loadImageGenSettings } from "@amaster.ai/pi-image-gen";
import path from "node:path";
import fsp from "node:fs/promises";

export const providerId = "pi-image-gen";

const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const CUSTOM_PROVIDER_KEY = "custom-openai";

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
    baseUrl,
    settings: {
      ...loadImageGenSettings({ cwd: process.cwd() }),
      defaultModel: modelId,
      // 库契约：customProviders 为 Record<string, CustomImageProvider>（pi-image-gen dist/types.d.ts）。
      // 显式 models 列表 = 确定性路由（resolveModel 第 1 优先级命中，不会库内置 id 抢道）。
      customProviders: {
        [CUSTOM_PROVIDER_KEY]: {
          api: "openai",
          baseUrl,
          apiKey,
          models: [{ id: modelId }],
        },
      },
    },
    modelId,
  };
}

/** 智谱端点判定（仅域名匹配，用于特化补丁的开关；非智谱端点走标准 OpenAI wire format） */
export function isZhipuEndpoint(baseUrl) {
  return /bigmodel\.cn/i.test(String(baseUrl ?? ""));
}

/** 去掉 pi-image-gen openai adapter 固定发送的 n:1（智谱 429 伪装业务错误，见 P0 报告）。
 *  仅智谱端点应用：非智谱端点保留原始请求体，不做任何改写。 */
function zhipuFetchPatch(enabled) {
  if (!enabled) return undefined; // 不注入 fetchImpl → 库内原生 fetch，请求体原样
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
  // 限流/网关类 → 可重试（服务端明确拒绝，未计费）；参数/鉴权类 → 不可重试（清单见 P0 报告错误分类表）。
  // 智谱 1314「企业套餐已失效」实测是限流/配额伪装码（P0 报告）：映射为可恢复。
  // P1.5-D：timeout/econnreset/econnaborteded → uncertain（请求可能已送达并计费，
  // 由执行器禁自动重试、整跑暂停转人工，与需求第三节/第七节对齐）。
  err.recoverable =
    /\b(429|rate|limit|timeout|econnreset|econnrefused|etimedout|5\d\d)\b/i.test(msg) ||
    /1314|套餐已失效/.test(msg);
  err.uncertain = /\b(timeout|econnreset|econnaborteded|etimedout)\b/i.test(msg);
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
  // 尺寸提示（如 "1536x1024"）：未设置不发送该字段，走端点/模型缺省尺寸；provider 可忽略
  const sizeHint = process.env.IMAGE_GEN_SIZE?.trim() || null;
  const attemptSignal = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(deadlineMs)]);
  // pi-image-gen 把 filename 当 stem，实际扩展名由返回 MIME 决定（MIME_TO_EXT）
  const stem = path.basename(outPath).replace(/\.[a-z0-9]+$/i, "");
  try {
    const result = await generateImage(
      { prompt, filename: stem, outputDir: path.dirname(outPath), image: reference ? [reference] : undefined, size: sizeHint ?? undefined },
      {
        cwd: cfg.cwd,
        settings: { ...cfg.settings, defaultModel: useModel },
        fetchImpl: zhipuFetchPatch(isZhipuEndpoint(cfg.baseUrl ?? ZHIPU_BASE_URL)),
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
    // 外层 deadline 触发时把挂起请求转成超时：扣费不确定（P1.5-D）
    if (attemptSignal.aborted && !signal?.aborted && e?.name !== "AbortError") {
      const err = new Error(`attempt deadline ${deadlineMs}ms exceeded`);
      err.code = "E_TIMEOUT";
      err.recoverable = true;
      err.uncertain = true;
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
