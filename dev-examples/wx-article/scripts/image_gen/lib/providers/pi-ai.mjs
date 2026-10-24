// 实验轨 Provider：宿主自带 @earendil-works/pi-ai 直连（P0 T0.3 静态核验）。
// 现状：目录 63 模型全走 openrouter；generateImages 永不 reject（stopReason 表错误）；
//      ImagesOptions 无 size/n/quality 参数面 → 仅作 pi-image-gen 不可用时的第二轨。
// 未真实调用过（P0 遗留），标记 EXPERIMENTAL；--provider pi-ai 显式选择才加载。
import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider, getBuiltinImageModels } from "@earendil-works/pi-ai/providers/all";
import fsp from "node:fs/promises";
import path from "node:path";

export const providerId = "pi-ai";
export const EXPERIMENTAL = true;

function buildClient(env = process.env) {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const err = new Error("OPENROUTER_API_KEY is not set (pi-ai provider)");
    err.code = "E_NO_KEY";
    throw err;
  }
  const models = createModels();
  models.setProvider(openrouterProvider());
  return { models, modelId: env.IMAGE_GEN_MODEL || "google/gemini-2.5-flash-image" };
}

export function listModels() {
  return getBuiltinImageModels("openrouter").map((m) => m.id);
}

function extractImageFiles(output, outPath) {
  // ImagesOutputContent: {type:'images', images:[{mimeType, data(base64)|url?}]}
  for (const part of output ?? []) {
    const imgs = part?.images ?? [];
    const first = imgs.find((im) => typeof im.data === "string" && im.data.length > 0);
    if (first) {
      const buf = Buffer.from(first.data, "base64");
      const ext = mimeExt(first.mimeType) ?? path.extname(outPath).slice(1) ?? "png";
      const finalPath = outPath.replace(/\.[a-z0-9]+$/i, `.${ext}`);
      return { buf, finalPath, mimeType: first.mimeType };
    }
  }
  return null;
}

function mimeExt(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return null;
}

export async function generate({ prompt, outPath, model, signal, context = {} }) {
  const client = context.models ?? buildClient();
  const modelId = model ?? client.modelId;
  const started = Date.now();
  // Models 接口无 imageModel(id)：ImageModel 对象直接取自内置目录（P0 T0.3 同源）
  const imageModel = getBuiltinImageModels("openrouter").find((m) => m.id === modelId);
  if (!imageModel) throw new Error(`pi-ai: unknown image model ${modelId} (openrouter catalog)`);
  const reply = await client.models.generateImages(
    imageModel,
    { input: [{ type: "text", text: prompt }] },
    { signal },
  );
  if (reply.stopReason !== "stop") {
    const err = new Error(reply.errorMessage || `pi-ai stopReason=${reply.stopReason}`);
    err.code = reply.stopReason === "aborted" ? "E_ABORTED" : "E_PROVIDER";
    err.recoverable = true;
    throw err;
  }
  const found = extractImageFiles(reply.output, outPath);
  if (!found) throw new Error("pi-ai returned no image data");
  await fsp.mkdir(path.dirname(found.finalPath), { recursive: true });
  await fsp.writeFile(found.finalPath, found.buf);
  return {
    path: found.finalPath,
    mime: found.mimeType ?? "image/png",
    bytes: found.buf.length,
    format: mimeExt(found.mimeType) ?? "png",
    width: null,
    height: null,
    model: modelId,
    provider: providerId,
    durationMs: Date.now() - started,
  };
}
