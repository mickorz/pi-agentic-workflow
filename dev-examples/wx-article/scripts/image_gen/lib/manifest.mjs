// Manifest 引擎（D7）：双状态机（active 主链 + candidate 链）、内容寻址失效、
// 原子写（tmp+rename，Windows EPERM/EBUSY 有界重试沿 48053e1 经验）、遗留 running 文件核验。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const MANIFEST_NAME = "image-manifest.json";
export const MANIFEST_VERSION = 1;

/** 主状态机：pending → running → succeeded | failed；stale = 输入变更待处理（旧图仍有效）；
 *  unknown = 扣费不确定（超时/连接中断，请求可能已达服务端并计费）——禁自动重试，待人工（P1.5-D） */
export const STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  STALE: "stale",
  UNKNOWN: "unknown",
};

/** 候选状态机：candidate_pending → candidate_generating → candidate_ready → (promoted)；失败 candidate_failed */
export const CAND_STATUS = {
  PENDING: "candidate_pending",
  GENERATING: "candidate_generating",
  READY: "candidate_ready",
  FAILED: "candidate_failed",
  PROMOTED: "promoted",
};

// ── 内容审核状态机（T4，IMG-L 阶段二）────────────────────────────────
// 与生成状态机严格分离：只由人工动作（--approve-text/--reject-text）或绑定失效驱动；
// 执行器不得自动置 approved。绑定因子：图片文件 sha256 + 要求内容哈希，任一变化 → 回 pending。
export const REVIEW_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
};

/** 要求哈希：sha256(JSON.stringify(expected_text))（数组序敏感：顺序变化视为要求变化） */
export function requirementsHash(expectedText) {
  return crypto.createHash("sha256").update(JSON.stringify(expectedText ?? null)).digest("hex");
}

/** 新建/重置审核记录（生成成功或绑定失效时） */
export function newContentReview(imageSha256, reqHash) {
  return {
    status: REVIEW_STATUS.PENDING,
    image_sha256: imageSha256,
    requirements_hash: reqHash,
    reviewed_at: null,
    updated_at: new Date().toISOString(),
  };
}

export function manifestPath(articleDir, override) {
  return override ?? path.join(articleDir, MANIFEST_NAME);
}

/** prompt_hash = sha256(style_prefix + "\n---\n" + prompt)（D7 定案分隔符） */
export function promptHash(stylePrefix, prompt) {
  return crypto.createHash("sha256").update(`${stylePrefix ?? ""}\n---\n${prompt ?? ""}`).digest("hex");
}

// ── 风格审批绑定（P1.5-B，需求 V1.0 第四节）────────────────────────────
// 审批必须绑定当时的提示词版本、模型及风格参数：绑定指纹任一因子变化 → 审批失效回 pending。
// 因子：全局风格 style_prefix + 预览条目完整提示词 + 模型指纹 + 风格参考图。

/** 风格层哈希：sha256(style_prefix)（全局画风，独立于具体条目构图） */
export function styleHash(stylePrefix) {
  return crypto.createHash("sha256").update(String(stylePrefix ?? "")).digest("hex");
}

/** 审批绑定指纹：sha256(风格哈希 + 预览条目哈希 + 模型指纹 + 参考图哈希) */
export function styleBindingFingerprint({ styleHashV, previewPromptHash, modelFingerprint, referenceHash }) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        style_hash: styleHashV,
        preview_prompt_hash: previewPromptHash,
        model_fingerprint: modelFingerprint,
        reference_hash: referenceHash ?? null,
      }),
    )
    .digest("hex");
}

/** manifest.style_approval 缺省形态 */
export function newStyleApproval() {
  return {
    status: "none", // none → preview_completed → approved；输入变化 → pending（失效）
    preview_image_id: null,
    preview_prompt_hash: null,
    style_hash: null,
    model_fingerprint: null,
    reference_hash: null,
    fingerprint: null,
    preview_path: null,
    approved_at: null,
    updated_at: null,
  };
}

/** 读取（兼容无该字段族的旧 manifest），返回有效对象（不落盘） */
export function styleApprovalOf(manifest) {
  return manifest.style_approval ?? newStyleApproval();
}

export function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(filePath);
    s.on("error", reject);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/** 载入（缺失/损坏 → 全新空 manifest；损坏时备份原文件并告警返回 null 语义由调用方处理） */
export async function loadManifest(articleDir, overridePath) {
  const p = manifestPath(articleDir, overridePath);
  try {
    const raw = await fsp.readFile(p, "utf8");
    const doc = JSON.parse(raw);
    if (doc !== null && typeof doc === "object" && typeof doc.entries === "object") {
      return { path: p, doc, existed: true };
    }
    throw new Error(`manifest 结构非法（缺少 entries）`);
  } catch (e) {
    if (e.code === "ENOENT") {
      return { path: p, doc: { version: MANIFEST_VERSION, article_id: null, entries: {} }, existed: false };
    }
    throw e;
  }
}

export function newManifest(articleId) {
  return { version: MANIFEST_VERSION, article_id: articleId, entries: {} };
}

/**
 * 原子写：tmp 同目录写 + rename。
 * Windows 下目标被 AV/并发读者短暂占用 → EPERM/EBUSY 有界重试（20-80ms 退避 ×5，沿 48053e1）。
 */
export async function saveManifest(filePath, manifest) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const payload = JSON.stringify(manifest, null, 2) + "\n";
  await fsp.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
  await fsp.writeFile(tmp, payload, "utf8");
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try {
      await fsp.rename(tmp, filePath);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code === "EPERM" || e.code === "EBUSY" || e.code === "EACCES") {
        await new Promise((r) => setTimeout(r, 20 + i * 15));
        continue;
      }
      break;
    }
  }
  await fsp.unlink(tmp).catch(() => {});
  throw lastErr ?? new Error("manifest rename failed");
}

/** 取或建条目（不落盘；调用方负责 save） */
export function entryFor(manifest, item, modelFingerprint, referenceHash, hash) {
  let e = manifest.entries[item.id];
  if (!e) {
    e = {
      id: item.id,
      kind: item.kind,
      filename: item.filename,
      prompt_hash: hash,
      status: STATUS.PENDING,
      attempts: 0,
      model: null,
      provider: null,
      path: null,
      mime_type: null,
      error_code: null,
      updated_at: new Date().toISOString(),
      model_fingerprint: modelFingerprint,
      reference_hash: referenceHash ?? null,
      candidate: null,
    };
    manifest.entries[item.id] = e;
  }
  return e;
}

/**
 * 对账（reconcile）：在生成前把遗留状态收敛为可执行决策。返回该条目本轮应采取的动作。
 * 动作：
 *  - skip            succeeded 且输入哈希/指纹未变（A02 零重复调用；文件核验由调用方 verify-only 或此处可选用）
 *  - stale           succeeded 但输入变化 → 标 stale（原图有效，走 candidate 重生成）
 *  - run-main        pending / failed(需 --retry-failed) / 遗留 running 且文件缺失
 *  - run-candidate   stale / force-regenerate 的 succeeded（走 candidate 链）
 * 遗留 running（上次进程死在落盘后未写终态）：先文件核验 → 有效则直接 succeeded（A09 恢复）。
 */
export async function reconcileEntry(entry, { hash, modelFingerprint, referenceHash, verifyFile, retryFailed, retryUnknown }) {
  const inputChanged =
    entry.prompt_hash !== hash ||
    entry.model_fingerprint !== modelFingerprint ||
    (entry.reference_hash ?? null) !== (referenceHash ?? null);

  if (entry.status === STATUS.RUNNING) {
    // 遗留 running：文件核验决定恢复语义（D7 补强）
    const target = entry.candidate?.status === CAND_STATUS.GENERATING ? entry.candidate.path : entry.path;
    const verdict = target ? await verifyFile(target) : { ok: false };
    if (verdict.ok) {
      entry.status = STATUS.SUCCEEDED;
      entry.error_code = null;
      entry.updated_at = new Date().toISOString();
      if (entry.candidate?.status === CAND_STATUS.GENERATING) {
        // 死在候选已落盘未 ready：文件有效 → 直接 ready 等提升（或由调用方立即提升）
        entry.candidate.status = CAND_STATUS.READY;
      }
      return { action: "verify-recovered", changed: true };
    }
    entry.status = STATUS.PENDING;
    entry.updated_at = new Date().toISOString();
    return { action: "run-main", changed: true };
  }

  if (entry.status === STATUS.SUCCEEDED) {
    if (!inputChanged) return { action: "skip", changed: false };
    entry.status = STATUS.STALE;
    entry.updated_at = new Date().toISOString();
    return { action: "run-candidate", changed: true };
  }

  if (entry.status === STATUS.STALE) return { action: "run-candidate", changed: false };

  if (entry.status === STATUS.FAILED) {
    return { action: retryFailed ? "run-main" : "report-only", changed: false };
  }

  // unknown（P1.5-D）：扣费不确定，禁自动重试。文件恰好有效 → 直接恢复 succeeded（零额外费用）；
  // 否则 report-only（人工显式 --retry-unknown 才重生成）。
  if (entry.status === STATUS.UNKNOWN) {
    const verdict = entry.path ? await verifyFile(entry.path) : { ok: false };
    if (verdict.ok) {
      entry.status = STATUS.SUCCEEDED;
      entry.error_code = null;
      entry.updated_at = new Date().toISOString();
      return { action: "verify-recovered", changed: true };
    }
    return { action: retryUnknown ? "run-main" : "report-unknown", changed: false };
  }

  // pending
  return { action: "run-main", changed: false };
}

/** 生成候选文件名：imgs/<name>.cand-<n>.<ext>（n 从 1 起找空位） */
export async function nextCandidatePath(dir, baseName) {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  for (let n = 1; n <= 99; n++) {
    const p = path.join(dir, `${stem}.cand-${n}${ext}`);
    try {
      await fsp.access(p);
      continue; // 已存在，找下一个
    } catch {
      return p; // 不存在 → 可用
    }
  }
  throw new Error(`候选文件编号耗尽（${stem}）`);
}

/** bak 编号：旧图移 <name>.<ext>.bak-<n>（从 1 起找空位，绝不覆盖既有 bak） */
export async function nextBakPath(dir, fileName) {
  for (let n = 1; n <= 999; n++) {
    const p = path.join(dir, `${fileName}.bak-${n}`);
    try {
      await fsp.access(p);
      continue;
    } catch {
      return p;
    }
  }
  throw new Error(`bak 编号耗尽（${fileName}）`);
}
