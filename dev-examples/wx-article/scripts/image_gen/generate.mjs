#!/usr/bin/env node
// 公众号批量生图执行器（T1.x 主编排）——image_gen/generate.mjs
//
// 输入：<article_dir>/image-prompts.json（唯一输入，D6）
// 输出：封面 <article_dir>/cover.<ext>；正文图 <article_dir>/imgs/<filename>
//       （filename 决定基础名；实际扩展名由 provider 返回格式决定，manifest.path 记真实路径）
// 状态：<article_dir>/image-manifest.json（双状态机，D7）
// 锁　：<article_dir>/.publish.article.lock（与 Python publish 链路同协议互斥，D5）
//
// stdout 契约（下游 workflow/article_image_generate.js 依赖，改动须同步）：
//   [FAIL] <msg>            校验/配置失败 → exit 2
//   [LOCKED] <msg>          文章锁被占用 → exit 3
//   [PLAN] <json>           --dry-run 计划 → exit 0
//   [IMG ok] <id> attempts=<n> <ms>ms <path>     单图成功
//   [IMG fail] <id> attempts=<n> code=<code>    单图失败
//   [RESULT] <json>         汇总（ok=failed===0&&pending===0）→ exit 0|1
//   exit 130                SIGINT 优雅中止（running 回写 pending，锁释放）
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validatePrompts, normalizePrompts } from "./lib/validate.mjs";
import {
  MANIFEST_NAME,
  STATUS,
  CAND_STATUS,
  promptHash,
  fileSha256,
  loadManifest,
  newManifest,
  saveManifest,
  entryFor,
  reconcileEntry,
  nextCandidatePath,
  nextBakPath,
} from "./lib/manifest.mjs";
import { verifyImageFile, verifyManifestPair } from "./lib/verify.mjs";
import { ArticleLock, LockHeldError, withArticleLock } from "./lib/lock.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCK_NAME = ".publish.article.lock";
const PROMPTS_NAME = "image-prompts.json";
void SCRIPT_DIR;

// ── 参数解析 ──
function parseArgs(argv) {
  const out = {
    articleDir: null,
    manifest: null,
    onlyIds: null,
    retryFailed: false,
    forceRegenerate: false,
    maxRetries: 2,
    continueOnError: false,
    dryRun: false,
    verifyOnly: false,
    provider: "pi-image-gen",
    model: null,
    styleReference: null,
    promote: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`参数 ${a} 缺少取值`);
      return argv[++i];
    };
    switch (a) {
      case "--article-dir": out.articleDir = next(); break;
      case "--manifest": out.manifest = next(); break;
      case "--only-ids": out.onlyIds = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--retry-failed": out.retryFailed = true; break;
      case "--force-regenerate": out.forceRegenerate = true; break;
      case "--max-retries": out.maxRetries = Number(next()); break;
      case "--continue-on-error": out.continueOnError = true; break;
      case "--dry-run": out.dryRun = true; break;
      case "--verify-only": out.verifyOnly = true; break;
      case "--provider": out.provider = next(); break;
      case "--model": out.model = next(); break;
      case "--style-reference": out.styleReference = next(); break;
      case "--promote": out.promote = next(); break;
      case "-h": case "--help": out.help = true; break;
      default: throw new Error(`未知参数：${a}`);
    }
  }
  return out;
}

const HELP = `用法：node generate.mjs --article-dir <dir> [选项]

必选：
  --article-dir <dir>       文章目录（含 image-prompts.json）
可选：
  --provider <p>            fake | pi-image-gen | pi-ai | <provider 模块 .mjs 路径>（缺省 pi-image-gen）
  --model <id>              模型 id（缺省取 provider 配置）
  --manifest <path>         manifest 覆盖路径（缺省 <article-dir>/image-manifest.json）
  --only-ids id1,id2        只处理子集
  --retry-failed            failed 条目重试（缺省只报告）
  --force-regenerate        succeeded 也强制重生成（走 candidate 链，原图不受影响）
  --max-retries <n>         可恢复错误的最大重试次数（缺省 2）
  --continue-on-error       单图失败继续后续图（缺省遇错即停）
  --style-reference <path>  风格参考图（参与哈希 + 传给支持的 provider）
  --dry-run                 只输出 [PLAN] 不生成
  --verify-only             Manifest↔文件双向核验（A13），不生成
  --promote <id>            提升指定条目的 ready 候选`;

function fail(msg, code = 2) {
  console.log(`[FAIL] ${msg}`);
  process.exit(code);
}

// ── Provider 装载（fake|pi-image-gen|pi-ai|模块路径）──
async function loadProvider(name, opts) {
  if (name === "fake") {
    return { ...(await import("./lib/providers/fake.mjs")), name: "fake" };
  }
  if (name === "pi-image-gen") {
    const mod = await import("./lib/providers/pi-image-gen.mjs");
    // A08：缺 key 快速失败（不进入锁、不落任何状态）
    mod.buildSettings();
    return { ...mod, name: "pi-image-gen" };
  }
  if (name === "pi-ai") {
    const mod = await import("./lib/providers/pi-ai.mjs");
    return { ...mod, name: "pi-ai" };
  }
  // 模块路径注入（测试注错 provider：A03/A04）
  const p = path.isAbsolute(name) ? name : path.resolve(process.cwd(), name);
  const mod = await import(pathToFileURL(p).href);
  if (typeof mod.generate !== "function") throw new Error(`provider 模块 ${name} 未导出 generate()`);
  return { ...mod, name: mod.providerId ?? path.basename(p, ".mjs") };
}

// ── SIGINT 优雅中止 ──
const abortController = new AbortController();
let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  abortController.abort();
});

// ── 主流程 ──
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.log(HELP);
    fail(e.message);
    return;
  }
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!args.articleDir) fail("--article-dir 必填");
  if (args.maxRetries < 0 || !Number.isInteger(args.maxRetries)) fail("--max-retries 须为非负整数");

  const articleDir = path.resolve(args.articleDir);
  const manifestPath = args.manifest ? path.resolve(args.manifest) : path.join(articleDir, MANIFEST_NAME);

  // 读输入（唯一输入，D6）
  let promptsRaw;
  try {
    promptsRaw = JSON.parse(await fsp.readFile(path.join(articleDir, PROMPTS_NAME), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") fail(`${articleDir} 下没有 ${PROMPTS_NAME}`);
    fail(`image-prompts.json 解析失败：${e.message}`);
    return;
  }
  const verdict = validatePrompts(promptsRaw);
  if (!verdict.ok) {
    fail(`image-prompts.json 校验失败：${verdict.errors.join("；")}`);
    return;
  }
  for (const w of verdict.warnings) console.error(`[WARN] ${w}`);
  const prompts = normalizePrompts(promptsRaw);

  // --verify-only：只读核验，不取锁
  if (args.verifyOnly) {
    const { doc, existed } = await loadManifest(articleDir, manifestPath);
    if (!existed) fail(`manifest 不存在：${manifestPath}`);
    const pair = await verifyManifestPair(doc, articleDir);
    console.log(`[RESULT] ${JSON.stringify({ ok: pair.ok, checked: pair.checked, problems: pair.problems, warnings: pair.warnings })}`);
    process.exit(pair.ok ? 0 : 1);
  }

  let provider;
  try {
    provider = await loadProvider(args.provider, args);
  } catch (e) {
    fail(`provider 装载失败：${e.message}`);
    return;
  }

  const modelFingerprint = `${provider.name}:${args.model ?? provider.defaultModel ?? "default"}`;

  // 参考图哈希（风格参考变更 = 输入变更 → stale）
  let referenceHash = null;
  if (args.styleReference) {
    const refPath = path.resolve(args.styleReference);
    try {
      referenceHash = await fileSha256(refPath);
    } catch {
      fail(`--style-reference 文件不存在：${refPath}`);
      return;
    }
  }

  const providerContext = provider.name === "pi-image-gen" ? { settings: provider.buildSettings() } : {};

  // ── 只读计划阶段（取锁前）：reconcile 全部条目 → 动作表 ──
  const { doc: manifest0 } = await loadManifest(articleDir, manifestPath);
  if (!manifest0.article_id) {
    manifest0.article_id = prompts.article_id;
  } else if (manifest0.article_id !== prompts.article_id) {
    fail(`manifest.article_id(${manifest0.article_id}) 与 image-prompts.article_id(${prompts.article_id}) 不一致`);
    return;
  }

  const targets = args.onlyIds ? prompts.items.filter((it) => args.onlyIds.includes(it.id)) : prompts.items;
  if (args.onlyIds) {
    const known = new Set(prompts.items.map((it) => it.id));
    for (const id of args.onlyIds) if (!known.has(id)) fail(`--only-ids 含未知 id：${id}`);
  }

  const plan = [];
  for (const item of targets) {
    const hash = promptHash(prompts.style_prefix, item.prompt);
    const entry = entryFor(manifest0, item, modelFingerprint, referenceHash, hash);
    let action;
    if (args.forceRegenerate && (entry.status === STATUS.SUCCEEDED || entry.status === STATUS.STALE)) {
      if (entry.status === STATUS.SUCCEEDED) {
        entry.status = STATUS.STALE;
        entry.updated_at = new Date().toISOString();
      }
      action = "run-candidate";
    } else {
      const r = await reconcileEntry(entry, {
        hash,
        modelFingerprint,
        referenceHash,
        verifyFile: (p) => verifyImageFile(path.resolve(articleDir, p)),
        retryFailed: args.retryFailed,
      });
      action = r.action;
      if (r.changed) await saveManifest(manifestPath, manifest0);
    }
    plan.push({ item, entry, action });
  }
  enrichPlan(plan, prompts);

  if (args.dryRun) {
    const p = plan.map((x) => ({ id: x.item.id, kind: x.item.kind, action: x.action, status: x.entry.status }));
    console.log(`[PLAN] ${JSON.stringify({ article_dir: articleDir, provider: provider.name, model_fingerprint: modelFingerprint, items: p })}`);
    return;
  }

  // ── --promote：独立小事务（取锁，提升 ready 候选）──
  if (args.promote) {
    await runPromote(args, { articleDir, manifestPath, manifest0 });
    return;
  }

  const toRun = plan.filter((x) => x.action === "run-main" || x.action === "run-candidate");

  // ── 生成阶段（持锁，D5：锁 PID=本进程，全程有效）──
  const summary = {
    ok: false,
    article_dir: articleDir,
    total: targets.length,
    succeeded: 0,
    failed: 0,
    pending: 0,
    manifest_path: manifestPath,
    generated_paths: [],
    failed_ids: [],
    pending_ids: [],
  };

  let lockRef = null;
  try {
    lockRef = await withArticleLock(path.join(articleDir, LOCK_NAME), { runId: `imggen-${Date.now().toString(36)}`, scope: "image-generate" }, async () => {
      const interDelayMs = Number(process.env.IMAGE_GEN_INTER_DELAY_MS ?? 1000);
      for (let i = 0; i < toRun.length; i++) {
        if (interrupted) break;
        const outcome = await runOne(toRun[i], {
          articleDir,
          manifestPath,
          manifest: manifest0,
          provider,
          providerContext,
          args,
          modelFingerprint,
          referenceHash,
          summary,
        });
        if (outcome === "stopped" && !args.continueOnError) break;
        // 图间隔节流（限流防线：免费档 QPS 敏感，T1.10 实测 27 连发触发小时级配额封锁）
        if (i < toRun.length - 1 && interDelayMs > 0 && !interrupted) {
          await new Promise((r) => setTimeout(r, interDelayMs));
        }
      }
    });
  } catch (e) {
    if (e instanceof LockHeldError) {
      console.log(`[LOCKED] pid=${e.info?.pid} runId=${e.info?.runId}`);
      process.exit(3);
    }
    throw e;
  }

  // 汇总（skip/report-only/被中断未跑的都计入 pending）
  for (const { entry } of plan) {
    if (entry.status === STATUS.SUCCEEDED) summary.succeeded += 1;
    else if (entry.status === STATUS.FAILED) {
      summary.failed += 1;
      summary.failed_ids.push(entry.id);
    } else if (entry.status === STATUS.STALE) {
      // stale = 有有效原图，本轮未完成再生成：计入 pending（可续）
      summary.pending += 1;
      summary.pending_ids.push(entry.id);
    } else {
      summary.pending += 1;
      summary.pending_ids.push(entry.id);
    }
  }
  summary.ok = summary.failed === 0 && summary.pending === 0;

  console.log(`[RESULT] ${JSON.stringify(summary)}`);
  process.exit(interrupted ? 130 : summary.ok ? 0 : 1);
}

/**
 * 单条目执行（主链或候选链）。返回 "done" | "stopped"。
 * 每次 Manifest 状态转换即时落盘（running 即写，压双计费窗口到单图粒度）。
 */
async function runOne(step, ctx) {
  const { articleDir, manifestPath, manifest, provider, providerContext, args, modelFingerprint, summary } = ctx;
  const { item, entry } = step;
  const isCandidate = step.action === "run-candidate";
  const fullPrompt = step.__fullPrompt;

  // 目标路径：主链 = 规范路径；候选链 = imgs/<stem>.cand-<n>.<ext>
  const canonicalDir = item.kind === "cover" ? articleDir : path.join(articleDir, "imgs");
  const canonicalPath = path.join(canonicalDir, item.filename);
  let targetPath = canonicalPath;
  let candRecord = null;

  const attempt = async (n) => {
    const signal = abortController.signal;
    try {
      const r = await provider.generate({
        id: item.id,
        kind: item.kind,
        prompt: fullPrompt,
        outPath: targetPath,
        model: args.model,
        signal,
        context: providerContext,
        reference: args.styleReference ? path.resolve(args.styleReference) : undefined,
      });
      const v = await verifyImageFile(r.path);
      if (!v.ok) {
        const err = new Error(`输出文件核验失败：${v.reason}`);
        err.code = "E_BAD_OUTPUT";
        err.recoverable = false;
        throw err;
      }
      return r;
    } catch (e) {
      e.__attempt = n;
      throw e;
    }
  };

  const maxAttempts = 1 + (args.maxRetries ?? 2);
  let lastErr = null;

  try {
    for (let n = 1; n <= maxAttempts; n++) {
      if (interrupted) break;
      // 状态置 running（候选链置 generating）并落盘
      if (isCandidate) {
        if (n === 1) {
          const imgsDir = item.kind === "cover" ? articleDir : path.join(articleDir, "imgs");
          await fsp.mkdir(imgsDir, { recursive: true });
          targetPath = await nextCandidatePath(imgsDir, item.filename);
          candRecord = {
            status: CAND_STATUS.GENERATING,
            path: rel(articleDir, targetPath),
            prompt_hash: entry.prompt_hash,
            model_fingerprint: modelFingerprint,
            started_at: new Date().toISOString(),
          };
          entry.candidate = candRecord;
        } else {
          candRecord.status = CAND_STATUS.GENERATING;
        }
      } else {
        entry.status = STATUS.RUNNING;
        entry.attempts = n;
        entry.path = null;
      }
      entry.updated_at = new Date().toISOString();
      await saveManifest(manifestPath, manifest);

      // 主链：清掉上次失败/旧格式残留（writeUnique 遇同名会 -v2，破坏规范路径语义）
      if (!isCandidate) {
        await fsp.unlink(targetPath).catch(() => {});
        if (entry.path && entry.path !== rel(articleDir, targetPath)) {
          await fsp.unlink(path.join(articleDir, entry.path)).catch(() => {});
        }
      }

      try {
        const r = await attempt(n);
        if (isCandidate) {
          candRecord.status = CAND_STATUS.READY;
          entry.updated_at = new Date().toISOString();
          await saveManifest(manifestPath, manifest);
          // 自动提升：旧图 → bak，候选转正（D7：重生成失败原图不受影响 → 提升在成功之后）
          await promoteEntry({ articleDir, manifestPath, manifest, entry, candRecord });
          summary.generated_paths.push(path.join(articleDir, entry.path));
        } else {
          entry.status = STATUS.SUCCEEDED;
          entry.path = rel(articleDir, r.path);
          entry.mime_type = r.mime;
          entry.model = r.model;
          entry.provider = r.provider;
          entry.error_code = null;
          entry.updated_at = new Date().toISOString();
          await saveManifest(manifestPath, manifest);
          summary.generated_paths.push(r.path);
        }
        console.log(`[IMG ok] ${item.id} attempts=${n} ${r.durationMs}ms ${rel(articleDir, r.path)}`);
        return "done";
      } catch (e) {
        lastErr = e;
        const recoverable = e.recoverable === true;
        const brief = String(e.message ?? "").replace(/\s+/g, " ").slice(0, 140);
        console.log(`[IMG fail] ${item.id} attempts=${n} code=${e.code ?? "E_UNKNOWN"}${recoverable ? " (recoverable)" : ""} ${brief}`);
        if (interrupted || (e.code === "E_ABORTED" && abortController.signal.aborted)) break;
        if (!recoverable || n >= maxAttempts) break;
        // 可恢复错误退避后重试（限流类 429 连发零退避只会连烧三次配额）
        await new Promise((r) => setTimeout(r, 2000 * n));
      }
    }
  } finally {
    // 终态落盘：失败/中断收敛
    if (interrupted) {
      if (isCandidate) {
        candRecord.status = CAND_STATUS.PENDING;
      } else {
        entry.status = STATUS.PENDING;
      }
      entry.updated_at = new Date().toISOString();
      await saveManifest(manifestPath, manifest).catch(() => {});
    } else if (lastErr) {
      if (isCandidate) {
        candRecord.status = CAND_STATUS.FAILED;
        candRecord.error_code = lastErr.code ?? "E_UNKNOWN";
      } else {
        entry.status = STATUS.FAILED;
        entry.error_code = lastErr.code ?? "E_UNKNOWN";
      }
      entry.updated_at = new Date().toISOString();
      await saveManifest(manifestPath, manifest).catch(() => {});
    }
  }
  return "stopped";
}

function rel(base, p) {
  const r = path.relative(base, p);
  return r.split(path.sep).join("/");
}

/** 候选提升：旧图 → <name>.bak-<n>，候选 rename 成规范名，条目回 succeeded */
async function promoteEntry({ articleDir, manifestPath, manifest, entry, candRecord }) {
  const item = { filename: entry.filename, kind: entry.kind };
  const canonicalDir = item.kind === "cover" ? articleDir : path.join(articleDir, "imgs");
  await fsp.mkdir(canonicalDir, { recursive: true });
  const canonicalPath = path.join(canonicalDir, item.filename);
  const candAbs = path.join(articleDir, candRecord.path);
  // 旧图备份（若存在）
  try {
    await fsp.access(canonicalPath);
    const bak = await nextBakPath(canonicalDir, item.filename);
    await fsp.rename(canonicalPath, bak);
    entry.previous_path = rel(articleDir, bak);
  } catch {
    // 无旧图（首次生成走候选链，如 --force-regenerate 前 status=pending？理论少见）
  }
  await fsp.rename(candAbs, canonicalPath);
  candRecord.status = CAND_STATUS.PROMOTED;
  entry.status = STATUS.SUCCEEDED;
  entry.path = rel(articleDir, canonicalPath);
  const v = await verifyImageFile(canonicalPath);
  entry.mime_type = v.ok ? `image/${v.format === "jpeg" ? "jpeg" : v.format}` : null;
  entry.updated_at = new Date().toISOString();
  await saveManifest(manifestPath, manifest);
}

/** --promote <id>：提升崩溃残留的 ready 候选 */
async function runPromote(args, { articleDir, manifestPath, manifest0 }) {
  const entry = Object.values(manifest0.entries ?? {}).find((e) => e.id === args.promote);
  if (!entry) fail(`--promote：未知 id ${args.promote}`);
  const cand = entry.candidate;
  if (!cand || cand.status !== CAND_STATUS.READY) {
    fail(`--promote：条目 ${args.promote} 无 ready 候选（candidate=${cand?.status ?? "none"}）`);
    return;
  }
  try {
    await withArticleLock(path.join(articleDir, LOCK_NAME), { runId: `promote-${Date.now().toString(36)}`, scope: "image-generate" }, async () => {
      await promoteEntry({ articleDir, manifestPath, manifest: manifest0, entry, candRecord: cand });
    });
  } catch (e) {
    if (e instanceof LockHeldError) {
      console.log(`[LOCKED] pid=${e.info?.pid} runId=${e.info?.runId}`);
      process.exit(3);
    }
    throw e;
  }
  console.log(`[RESULT] ${JSON.stringify({ ok: true, promoted: args.promote, path: entry.path })}`);
}

// fullPrompt 注入：style_prefix + "\n---\n" + prompt 与哈希一致
// （在 main 中 plan 构建时填充，runOne 读 step.__fullPrompt）
function enrichPlan(plan, prompts) {
  for (const step of plan) {
    step.__fullPrompt = `${prompts.style_prefix}\n---\n${step.item.prompt}`;
  }
}

main().catch((e) => {
  console.error(`[ERROR] ${e?.stack ?? e}`);
  process.exit(1);
});

export { parseArgs, loadProvider, enrichPlan };
