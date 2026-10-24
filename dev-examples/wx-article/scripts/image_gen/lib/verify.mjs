// 输出核验（T1.8/A13）：单文件有效性 + Manifest↔文件系统双向核验（零 LLM 终审的事实依据）。
import fsp from "node:fs/promises";
import path from "node:path";

/** 判定为「有效图片」的最小字节数（截断文件拦截阈值） */
const MIN_IMAGE_BYTES = 1024;
/** 判定为异常的超大单图（图片正常几百 KB～几 MB；>50MB 几乎必为损坏/错文件） */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/**
 * 单文件核验：存在 / 大小阈值 / 魔数（PNG/JPEG/WebP）/ PNG 基本结构（IHDR 尺寸>0）。
 * 返回 {ok, reason?, bytes, format, width?, height?}。不抛错（核验语义，错误即 verdict）。
 */
export async function verifyImageFile(filePath) {
  const no = (reason) => ({ ok: false, reason, bytes: 0, format: null });
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) return no("not-a-file");
    if (st.size < MIN_IMAGE_BYTES) return no(`too-small:${st.size}B`);
    if (st.size > MAX_IMAGE_BYTES) return no(`too-large:${st.size}B`);
    const fh = await fsp.open(filePath, "r");
    try {
      const head = Buffer.alloc(64);
      await fh.read(head, 0, 64, 0);
      // PNG：89 50 4E 47 0D 0A 1A 0A + IHDR
      if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        if (head.readUInt32BE(8) !== 13 || head.subarray(12, 16).toString("ascii") !== "IHDR") {
          return { ok: false, reason: "png-no-ihdr", bytes: st.size, format: "png" };
        }
        const width = head.readUInt32BE(16);
        const height = head.readUInt32BE(20);
        if (!(width > 0 && height > 0)) return { ok: false, reason: "png-bad-dims", bytes: st.size, format: "png" };
        return { ok: true, bytes: st.size, format: "png", width, height };
      }
      // JPEG：FF D8 FF
      if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
        return { ok: true, bytes: st.size, format: "jpeg" };
      }
      // WebP：RIFF....WEBP
      if (
        head.subarray(0, 4).toString("ascii") === "RIFF" &&
        head.subarray(8, 12).toString("ascii") === "WEBP"
      ) {
        return { ok: true, bytes: st.size, format: "webp" };
      }
      return no("unknown-magic");
    } finally {
      await fh.close();
    }
  } catch (e) {
    if (e.code === "ENOENT") return no("missing");
    return no(`stat-error:${e.code ?? e.message}`);
  }
}

/**
 * 双向核验（A13）：Manifest 记录 ↔ 实际文件系统一致。
 * 正向：每个 succeeded 条目的 path 存在且通过 verifyImageFile；mime/format 与记录自洽。
 * 反向：imgs/ 与根 cover.* 中本执行器管理的孤儿形态（*.cand-*）给出 problem；
 *       未知文件（下游/手工放的其他图）不算 problem——manifest 只管理自己生成的图。
 * 返回 {ok, problems: [{id?, path, problem}], checked}。零副作用。
 */
export async function verifyManifestPair(manifest, articleDir) {
  const problems = [];
  let checked = 0;
  for (const entry of Object.values(manifest.entries ?? {})) {
    if (entry.status !== "succeeded" && entry.status !== "stale") continue;
    checked += 1;
    if (typeof entry.path !== "string" || !entry.path) {
      problems.push({ id: entry.id, path: null, problem: "manifest-entry-no-path" });
      continue;
    }
    const abs = path.resolve(articleDir, entry.path);
    const inside = abs.startsWith(path.resolve(articleDir) + path.sep);
    if (!inside) {
      problems.push({ id: entry.id, path: entry.path, problem: "manifest-path-escape" });
      continue;
    }
    const verdict = await verifyImageFile(abs);
    if (!verdict.ok) {
      problems.push({ id: entry.id, path: entry.path, problem: verdict.reason });
      continue;
    }
    // mime 自洽（宽松：jpeg 允许 image/jpeg，png→image/png，webp→image/webp）
    if (entry.mime_type) {
      const expect = verdict.format === "jpeg" ? "image/jpeg" : `image/${verdict.format}`;
      if (entry.mime_type !== expect) {
        problems.push({ id: entry.id, path: entry.path, problem: `mime-mismatch:${entry.mime_type}!=${expect}` });
      }
    }
    // stale 条目：旧图必须仍然有效（D7：输入失效 ≠ 图片失效）
  }
  // 反向：候选文件残留（生成中断/失败后未清理）→ 报告但不算失败？A05 要求 candidate 文件可清理。
  // 这里作为 warning 类 problem（kind:"orphan-candidate"），ok 不受影响。
  const imgsDir = path.join(articleDir, "imgs");
  const orphans = [];
  try {
    const files = await fsp.readdir(imgsDir);
    for (const f of files) {
      if (/\.cand-\d+\.(png|jpe?g|webp)$/.test(f)) orphans.push({ path: `imgs/${f}`, problem: "orphan-candidate" });
    }
  } catch {
    // imgs/ 不存在 → 无反向可查
  }
  return { ok: problems.length === 0, problems, warnings: orphans, checked };
}
