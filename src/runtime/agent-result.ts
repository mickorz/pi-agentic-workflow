/**
 * 结果展示助手——纯函数、零依赖、宿主无关。
 *
 * 职责：为 AgentRecord 的 outputPreview 提供截断 / 脱敏 / 序列化。
 * 不变量：本文件只处理展示副本，绝不修改结果原值。
 */

/** 结果预览的字节预算 */
export const OUTPUT_PREVIEW_LIMIT_BYTES = 2048;

/** 敏感键命中正则：api_key / apikey / secret / token / password / authorization / credential */
const REDACT_KEY = /api[_-]?key|secret|token|password|authorization|credential/i;
/** 脱敏递归深度上限（防超深嵌套） */
const REDACT_DEPTH = 4;
/** 脱敏数组元素上限（防超长数组拖慢预览构建） */
const REDACT_ARRAY_CAP = 50;

/**
 * UTF-8 安全截断：按字节截断后回退到码点边界，避免截出半个多字节字符。
 */
export function truncateUtf8ByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const slice = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return slice.endsWith("�") ? slice.slice(0, -1) : slice;
}

/**
 * 脱敏：命中敏感键的对象字段值替换为 "[REDACTED]"。
 * 只处理展示副本；深度超限原样返回，数组截断到 cap。
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth >= REDACT_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, REDACT_ARRAY_CAP).map((item) => redactValue(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_KEY.test(key) ? "[REDACTED]" : redactValue(item, depth + 1);
  }
  return out;
}

/**
 * 预览构建：脱敏 -> 序列化（string 原样 / 对象 JSON pretty）-> 截断。
 * 序列化失败（循环引用等）退化为 String() 截断。
 */
export function buildOutputPreview(value: unknown, maxBytes = OUTPUT_PREVIEW_LIMIT_BYTES): string {
  let text: string;
  try {
    if (typeof value === "string") {
      text = value;
    } else {
      const serialized = JSON.stringify(redactValue(value), null, 2);
      text = serialized === undefined ? String(value) : serialized;
    }
  } catch {
    text = String(value);
  }
  return truncateUtf8ByBytes(text, maxBytes);
}
