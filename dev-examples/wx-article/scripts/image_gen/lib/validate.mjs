// 契约校验（D6/FR-01）：image-prompts.json 是执行器唯一输入。
// 非法输入 → 调用方以 [FAIL] exit 2 终止，绝不部分执行。
import path from "node:path";

/** 允许的图片扩展名（微信图文兼容集） */
export const ALLOWED_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);

/** Windows 保留设备名（不带扩展名比较，大小写不敏感） */
const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/** id 约束：小写字母/数字开头，仅小写字母、数字、连字符 */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 安全相对文件名（A07 路径逃逸拒绝）：
 * 禁绝对路径、禁 .. 逃逸、禁路径分隔符、禁控制字符、禁 Windows 保留名、
 * 禁前导点/尾随点与空格、扩展名必须在允许集内、长度 ≤ 128。
 */
export function isSafeImageFilename(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 128) return false;
  if (name !== name.trim()) return false;
  if (name.startsWith(".")) return false;
  // 控制字符
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  // 任何路径分隔符（本字段必须是纯文件名，不含子目录）
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes("..")) return false;
  // Windows 盘符/UNC 形态（C:\x、\\server）已被分隔符/.. 覆盖，双保险查前导反斜杠
  if (/^[a-zA-Z]:/.test(name)) return false;
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) return false;
  const base = name.slice(0, name.length - path.extname(name).length);
  if (base.length === 0) return false;
  if (WINDOWS_RESERVED.has(base.toUpperCase())) return false;
  return true;
}

/**
 * 校验 image-prompts.json 文档。
 * 返回 { ok, errors: string[], warnings: string[] }；errors 非空即拒绝执行。
 */
export function validatePrompts(doc) {
  const errors = [];
  const warnings = [];
  const fail = (msg) => errors.push(msg);

  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    fail("清单必须是 JSON 对象");
    return { ok: false, errors, warnings };
  }
  if (doc.version !== 1) fail(`version 必须为 1，收到 ${JSON.stringify(doc.version)}`);
  if (typeof doc.article_id !== "string" || !doc.article_id.trim()) fail("article_id 必须是非空字符串");
  if (doc.style_prefix !== undefined && typeof doc.style_prefix !== "string") fail("style_prefix 必须是字符串");
  if (!Array.isArray(doc.items) || doc.items.length === 0) {
    fail("items 必须是非空数组");
    return { ok: false, errors, warnings };
  }
  if (doc.items.length > 50) warnings.push(`items 共 ${doc.items.length} 条，超过 50 条建议分批（费用与时长考虑）`);

  const seenIds = new Set();
  const seenFilenames = new Set();
  let coverCount = 0;

  doc.items.forEach((item, i) => {
    const at = `items[${i}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      fail(`${at} 必须是对象`);
      return;
    }
    if (typeof item.id !== "string" || !ID_RE.test(item.id)) {
      fail(`${at}.id 非法（须匹配 ^[a-z0-9][a-z0-9-]*$）：${JSON.stringify(item.id)}`);
    } else if (seenIds.has(item.id)) {
      fail(`${at}.id 重复：${item.id}`);
    } else {
      seenIds.add(item.id);
    }
    if (item.kind !== "cover" && item.kind !== "body") {
      fail(`${at}(${item.id ?? "?"}).kind 必须是 cover|body，收到 ${JSON.stringify(item.kind)}`);
    } else if (item.kind === "cover") {
      coverCount += 1;
      if (coverCount > 1) fail(`${at}(${item.id}) 出现第二个 cover 条目（至多一个）`);
    }
    if (typeof item.prompt !== "string" || !item.prompt.trim()) {
      fail(`${at}(${item.id ?? "?"}).prompt 必须是非空字符串`);
    } else if (item.prompt.length > 8000) {
      warnings.push(`${at}(${item.id}).prompt 长度 ${item.prompt.length}，多数模型上限内但建议精简`);
    }
    if (item.heading !== undefined && typeof item.heading !== "string") {
      fail(`${at}(${item.id ?? "?"}).heading 必须是字符串`);
    }
    // T4（IMG-L 阶段二）：可选验收字段——声明该图必须出现的指定文字（非空字符串数组）。
    // 纯验收元数据，不进 prompt（进 prompt 会改变 prompt_hash，破坏“纯改要求不触发重新付费生图”的失效规则）。
    if (item.expected_text !== undefined) {
      if (!Array.isArray(item.expected_text) || item.expected_text.length === 0 || item.expected_text.some((t) => typeof t !== "string" || !t.trim())) {
        fail(`${at}(${item.id ?? "?"}).expected_text 若提供必须是非空字符串数组（每条为该图必须出现的文字）`);
      }
    }
    // filename：body 必填；cover 缺省 cover.png（由执行器补全）
    if (item.kind === "cover") {
      if (item.filename !== undefined && !isSafeImageFilename(item.filename)) {
        fail(`${at}(${item.id}).filename 非法（路径逃逸/保留名/扩展名）：${JSON.stringify(item.filename)}`);
      }
    } else if (typeof item.filename !== "string" || !isSafeImageFilename(item.filename)) {
      fail(`${at}(${item.id ?? "?"}).filename 非法或缺失（body 必填，且须为安全相对名）：${JSON.stringify(item.filename)}`);
    }
    if (typeof item.filename === "string") {
      if (seenFilenames.has(item.filename)) fail(`${at}(${item.id}).filename 重复：${item.filename}`);
      else seenFilenames.add(item.filename);
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}

/** 补全缺省值（不改变原对象）：cover.filename 缺省 cover.png；默认名与显式名冲突时报错 */
export function normalizePrompts(doc) {
  const items = doc.items.map((it) => ({
    ...it,
    filename: it.kind === "cover" && it.filename === undefined ? "cover.png" : it.filename,
  }));
  const names = new Set(items.map((it) => it.filename));
  if (names.size !== items.length) {
    throw new Error("normalize 后 filename 仍有重复（cover 缺省名 cover.png 与显式条目冲突？）");
  }
  return { ...doc, style_prefix: doc.style_prefix ?? "", items };
}
