/**
 * 日志脱敏（SC-004，NFR-007）：认证 token / 密钥 / 凭据模式不得进入审计与日志明文。
 * 规则保守偏严：宁可多掩码，不可漏凭据。
 */

/** 命中即整体替换为 [REDACTED:<kind>] 的模式清单 */
const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  // API-Key 风格（sk-…、ghp_…、AKIA…）
  { kind: "api-key", re: /\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g },
  { kind: "api-key", re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { kind: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Bearer / Basic 头
  { kind: "bearer", re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  // JSON 字段（token / secret / password / credential / apiKey / sessionKey）
  {
    kind: "secret-field",
    re: /("(?:token|secret|password|passwd|credential[s]?|api[Kk]ey|session[Kk]ey|access[Kk]ey|authorization)"\s*:\s*")[^"]{4,}(")/g,
  },
  // 凭据文件路径（真机 SOP 产物）
  { kind: "credentials-path", re: /(~\/[^"'\s]*wechat-assistant[^"'\s]*credentials[^"'\s]*\.json)/g },
  // 长随机串（≥40 的 hex / base64，常见于会话密钥）
  { kind: "opaque-secret", re: /\b[A-Za-z0-9+/=_-]{40,}\b/g },
];

/** 掩码函数：所有命中的敏感片段替换为占位符 */
export function redact(text: string): string {
  let out = text;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, (match, ...rest) => {
      // secret-field 模式含捕获组：保留前缀与后引号，只掩值
      if (rest.length >= 2 && typeof rest[0] === "string" && typeof rest[1] === "string") {
        return `${rest[0]}[REDACTED:${kind}]${rest[1]}`;
      }
      return `[REDACTED:${kind}]`;
    });
  }
  return out;
}

/** 对任意值做字符串化 + 脱敏（供审计 detail 使用） */
export function redactValue(value: unknown): string {
  if (typeof value === "string") return redact(value);
  try {
    return redact(JSON.stringify(value));
  } catch {
    return redact(String(value));
  }
}
