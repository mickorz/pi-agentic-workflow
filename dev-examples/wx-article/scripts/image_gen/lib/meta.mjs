// meta 配套写入与校验（P0-C T8，方案 V2.1 §6.2）
// 定位：两个写入源（compile.mjs 走 plan、convert.mjs 走 markdown）共用同一套
// 版本常量与安全写入逻辑；连续 rename 不是跨文件原子事务，因此目标定位为
// 「可检测、可恢复的一致性」——meta 记录 json_content_hash，读取侧强制配套校验，
// 不匹配一律拒绝复用、走重编译。
import { readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, existsSync } from "node:fs";
import crypto from "node:crypto";

// 升级编译/转换实现时同步递增；读取侧发现版本不一致按缓存无效处理（保守失效）
export const COMPILER_VERSION = "1.0.0";

export const META_NAME = "image-prompts.meta.json";

export function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** 单文件安全写入：tmp -> fsync -> rename（单文件内原子） */
export function safeWriteFile(file, content) {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/**
 * json + meta 配套写入：meta 先写、json 后写，meta.json_content_hash 锁定 json 内容。
 * 中断恢复保证：json 新/meta 旧 -> 内容哈希不匹配；json 旧/meta 新 -> 不匹配。
 * 两侧不一致均可被 checkMetaConsistency 检出。
 */
export function writeJsonWithMeta(jsonPath, doc, metaExtra) {
  const jsonContent = JSON.stringify(doc, null, 2) + "\n";
  const metaPath = jsonPath.replace(/[^/\\]+$/, META_NAME);
  const meta = {
    version: 1,
    compiler_version: COMPILER_VERSION,
    source: metaExtra.source,
    source_md_hash: metaExtra.source_md_hash ?? null,
    article_hash: metaExtra.article_hash ?? null,
    plan_hash: metaExtra.plan_hash ?? null,
    rules_hash: metaExtra.rules_hash ?? null,
    json_content_hash: sha256Hex(jsonContent),
    items_effective_hash: metaExtra.items_effective_hash ?? {},
    written_at: new Date().toISOString(),
  };
  safeWriteFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  safeWriteFile(jsonPath, jsonContent);
  return { metaPath, meta };
}

/**
 * 读取侧配套校验：返回 { ok, reason, meta }。
 * 任何不配套（缺文件、meta 损坏、版本不一致、内容哈希不匹配）都视为缓存无效。
 */
export function checkMetaConsistency(jsonPath, metaPath) {
  if (!existsSync(jsonPath)) return { ok: false, reason: "json-missing", meta: null };
  if (!existsSync(metaPath)) return { ok: false, reason: "meta-missing", meta: null };
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (e) {
    return { ok: false, reason: `meta-corrupt（${e.message}）`, meta: null };
  }
  if (meta.compiler_version !== COMPILER_VERSION) {
    return { ok: false, reason: `compiler-version（meta=${meta.compiler_version} current=${COMPILER_VERSION}）`, meta: null };
  }
  const actual = sha256Hex(readFileSync(jsonPath, "utf8"));
  if (meta.json_content_hash !== actual) {
    return { ok: false, reason: "content-hash（两次写入之间中断或被外部改动，拒绝复用）", meta: null };
  }
  return { ok: true, reason: "", meta };
}
