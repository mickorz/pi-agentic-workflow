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
  styleHash,
  styleBindingFingerprint,
  styleApprovalOf,
  newStyleApproval,
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

/** 超时/连接中断类错误码：请求可能已达服务端并计费 → 扣费不确定，禁自动重试（P1.5-D） */
const UNCERTAIN_CODES = new Set(["E_TIMEOUT", "ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "E_UNKNOWN_CHARGE"]);

const MODES = new Set(["preview", "batch", "regenerate"]);

// ── 参数解析 ──
function parseArgs(argv) {
  const out = {
    articleDir: null,
    manifest: null,
    mode: "batch",
    previewId: null,
    approveStyle: false,
    noRequireStyleApproval: false,
    onlyIds: null,
    retryFailed: false,
    retryUnknown: false,
    forceRegenerate: false,
    maxRetries: null, // 废弃别名：--max-retries（转 maxAttemptsPerImage = n+1）
    maxAttemptsPerImage: null,
    maxImagesPerRun: null,
    continueOnError: false,
    dryRun: false,
    verifyOnly: false,
    provider: "pi-image-gen",
    model: null,
    styleReference: null,
    promote: null,
    priceCny: null,
    budgetCny: null,
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
      case "--mode": out.mode = next(); break;
      case "--preview-id": out.previewId = next(); break;
      case "--approve-style": out.approveStyle = true; break;
      case "--no-require-style-approval": out.noRequireStyleApproval = true; break;
      case "--only-ids": out.onlyIds = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--retry-failed": out.retryFailed = true; break;
      case "--retry-unknown": out.retryUnknown = true; break;
      case "--force-regenerate": out.forceRegenerate = true; break;
      case "--max-retries": out.maxRetries = Number(next()); break;
      case "--max-attempts-per-image": out.maxAttemptsPerImage = Number(next()); break;
      case "--max-images-per-run": out.maxImagesPerRun = Number(next()); break;
      case "--continue-on-error": out.continueOnError = true; break;
      case "--dry-run": out.dryRun = true; break;
      case "--verify-only": out.verifyOnly = true; break;
      case "--provider": out.provider = next(); break;
      case "--model": out.model = next(); break;
      case "--style-reference": out.styleReference = next(); break;
      case "--promote": out.promote = next(); break;
      case "--price-cny": out.priceCny = Number(next()); break;
      case "--budget-cny": out.budgetCny = Number(next()); break;
      case "-h": case "--help": out.help = true; break;
      default: throw new Error(`未知参数：${a}`);
    }
  }
  return out;
}

const HELP = `用法：node generate.mjs --article-dir <dir> [选项]

必选：
  --article-dir <dir>       文章目录（含 image-prompts.json）
模式（P1.5，需求 V1.0 第二节）：
  --mode preview            试生成：只跑 1 张代表图（首个 body，缺省），固定单次请求不重试，
                            成功后写入 style_approval 绑定（等 --approve-style 确认）
  --mode batch              批量：需风格审批通过（require_style_approval 缺省开启，
                            未审批 exit 2；提示词/模型/参考图变更 → 审批自动失效回 pending）
  --mode regenerate         单独重做：需配合 --only-ids，走 candidate 链（原图隔离）
  --preview-id <id>         preview 代表条目覆盖（缺省首个 body）
  --approve-style           风格确认动作：把 preview_completed 锁定为 approved（绑定校验）
  --no-require-style-approval  关闭 batch 风格审批门（测试/逃生口，生产链路勿用）
预算与请求次数（P1.5-C，需求 V1.0 第三节）：
  --max-images-per-run <n>  单次运行最多生成的张数（硬上限，剩余留 pending 待再跑）
  --max-attempts-per-image <n> 单张最多请求次数含首次（缺省 3；--max-retries 为废弃别名 n-1）
  --price-cny <x>           单张单价（缺省读环境变量 IMAGE_GEN_PRICE_PER_IMAGE）
  --budget-cny <x>          预算硬门：最坏估算（张数×单价×尝试上限）超预算 → exit 2 不发请求
可选：
  --provider <p>            fake | pi-image-gen | pi-ai | <provider 模块 .mjs 路径>（缺省 pi-image-gen）
  --model <id>              模型 id（缺省取 provider 配置）
  --manifest <path>         manifest 覆盖路径（缺省 <article-dir>/image-manifest.json）
  --only-ids id1,id2        只处理子集
  --retry-failed            failed 条目重试（缺省只报告）
  --retry-unknown           unknown（扣费不确定）条目人工确认后重试（缺省只报告，禁自动重试）
  --force-regenerate        succeeded 也强制重生成（等价 regenerate 原语）
  --continue-on-error       单图失败继续后续图（缺省遇错即停；扣费不确定例外：一律暂停转人工）
  --style-reference <path>  风格参考图（参与哈希 + 传给支持的 provider）
  --dry-run                 只输出 [PLAN] 不生成（batch 模式下风格门仍生效）
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
  if (!MODES.has(args.mode)) fail(`--mode 必须是 ${[...MODES].join("|")}，收到 ${args.mode}`);
  if (args.mode === "regenerate" && !args.onlyIds) fail("--mode regenerate 需配合 --only-ids 指定重做条目");
  if (args.previewId && args.mode !== "preview") fail("--preview-id 仅在 --mode preview 下可用");

  // 单张尝试上限解析：--max-attempts-per-image 优先；--max-retries 为废弃别名（n+1）；两者同传拒绝
  if (args.maxAttemptsPerImage !== null && args.maxRetries !== null) {
    fail("--max-attempts-per-image 与 --max-retries 互斥（后者为废弃别名）");
  }
  let maxAttempts = args.maxAttemptsPerImage ?? (args.maxRetries !== null ? args.maxRetries + 1 : 3);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) fail("单张尝试上限须为 ≥1 整数（含首次）");
  if (args.mode === "preview") maxAttempts = 1; // 验收 1：preview 只发 1 次请求

  if (args.maxImagesPerRun !== null && (!Number.isInteger(args.maxImagesPerRun) || args.maxImagesPerRun < 1)) {
    fail("--max-images-per-run 须为 ≥1 整数");
  }
  const price = args.priceCny !== null ? args.priceCny : (process.env.IMAGE_GEN_PRICE_PER_IMAGE ? Number(process.env.IMAGE_GEN_PRICE_PER_IMAGE) : null);
  if (price !== null && (!Number.isFinite(price) || price < 0)) fail("--price-cny / IMAGE_GEN_PRICE_PER_IMAGE 须为非负数");
  if (args.budgetCny !== null && (!Number.isFinite(args.budgetCny) || args.budgetCny < 0)) fail("--budget-cny 须为非负数");

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

  // ── --approve-style：风格确认独立动作（锁内 RMW，不发任何请求）──
  if (args.approveStyle) {
    await runApproveStyle(args, { articleDir, manifestPath, prompts });
    return;
  }

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

  // ── 预算运行时口径（V1.1 评审建议 1）：requests_issued 累计请求数持久化（跨运行/分批累计）；
  //  每次发请求前检查累计估算消耗（单价×请求数，估算口径——服务商未必实时返回费用，不代表实际账单）──
  manifest0.requests_issued ??= 0;
  const requestsIssuedStart = manifest0.requests_issued;

  // ── preview 代表条目（P1.5-A：固定只跑 1 张代表图；优先 --preview-id，否则首个 body，再退化首个条目）──
  let previewItem = null;
  if (args.mode === "preview") {
    previewItem = args.previewId
      ? prompts.items.find((it) => it.id === args.previewId)
      : (prompts.items.find((it) => it.kind === "body") ?? prompts.items[0]);
    if (!previewItem) fail(`--preview-id 含未知 id：${args.previewId}`);
  }

  const targets = args.mode === "preview" ? [previewItem] : (args.onlyIds ? prompts.items.filter((it) => args.onlyIds.includes(it.id)) : prompts.items);
  if (args.onlyIds && args.mode !== "preview") {
    const known = new Set(prompts.items.map((it) => it.id));
    for (const id of args.onlyIds) if (!known.has(id)) fail(`--only-ids 含未知 id：${id}`);
  }

  // ── 风格审批绑定指纹（当前输入）：风格层 + 预览条目提示词 + 模型指纹 + 参考图 ──
  const styleHashV = styleHash(prompts.style_prefix);
  const bindingRepId = args.mode === "preview" ? previewItem.id : styleApprovalOf(manifest0).preview_image_id;
  const bindingRepItem = bindingRepId ? prompts.items.find((it) => it.id === bindingRepId) ?? null : null;
  const bindingPreviewHash = bindingRepItem ? promptHash(prompts.style_prefix, bindingRepItem.prompt) : null;
  const currentFingerprint = styleBindingFingerprint({ styleHashV, previewPromptHash: bindingPreviewHash, modelFingerprint, referenceHash });

  const plan = [];
  for (const item of targets) {
    const hash = promptHash(prompts.style_prefix, item.prompt);
    const entry = entryFor(manifest0, item, modelFingerprint, referenceHash, hash);
    let action;
    if ((args.forceRegenerate || args.mode === "regenerate") && (entry.status === STATUS.SUCCEEDED || entry.status === STATUS.STALE)) {
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
        retryUnknown: args.retryUnknown,
      });
      action = r.action;
      if (r.changed) await saveManifest(manifestPath, manifest0);
    }
    plan.push({ item, entry, action });
  }
  enrichPlan(plan, prompts);

  const toRun = plan.filter((x) => x.action === "run-main" || x.action === "run-candidate");

  // ── 风格审批门（P1.5-B 验收 3：未审批直接 batch 拒绝；输入变更 → 审批失效回 pending）──
  //  --promote 不发请求，不过门
  let styleGate = null;
  if (args.mode === "batch" && !args.noRequireStyleApproval && !args.promote && toRun.length > 0) {
    const sa = styleApprovalOf(manifest0);
    const valid = sa.status === "approved" && sa.fingerprint === currentFingerprint;
    if (!valid) {
      if (sa.status === "approved") {
        // 输入已变：旧审批自动失效（懒落盘）
        manifest0.style_approval = { ...sa, status: "pending", updated_at: new Date().toISOString() };
        await saveManifest(manifestPath, manifest0);
      }
      const reason =
        sa.status === "approved"
          ? "提示词/模型/风格参考已变更，原风格审批自动失效（回 pending），需重新 preview + 确认"
          : `当前风格审批状态为 ${sa.status}，需先 --mode preview 试生成并通过 --approve-style 确认风格`;
      fail(`--mode batch 风格审批门：${reason}`);
      return;
    }
    styleGate = { required: true, status: "approved", valid: true };
  } else {
    styleGate = {
      required: args.mode === "batch" && !args.noRequireStyleApproval,
      status: styleApprovalOf(manifest0).status,
      valid: args.mode === "batch" && !args.noRequireStyleApproval ? toRun.length === 0 : null,
    };
  }

  // ── 单次运行张数硬上限（P1.5-C 验收 4：超出部分留 pending，下次再跑）；
  // 切片在预算门之前：预算门按本轮实际会跑的张数估算（cap 后），不误拦被 cap 挡住的部分 ──
  let runQueue = toRun;
  let cappedRemaining = 0;
  if (args.maxImagesPerRun !== null && toRun.length > args.maxImagesPerRun) {
    cappedRemaining = toRun.length - args.maxImagesPerRun;
    runQueue = toRun.slice(0, args.maxImagesPerRun);
  }

  // ── 预算硬门（P1.5-C 验收 7：最坏估算超预算 → 不发任何请求；
  //  另有运行时门：每次发请求前按累计请求数检查，见 runOne）──
  let cost = null;
  if (price !== null && runQueue.length > 0) {
    cost = {
      price_cny: price,
      images: runQueue.length,
      est_min_cny: round2(runQueue.length * price),
      est_max_cny: round2(runQueue.length * price * maxAttempts),
    };
    if (args.budgetCny !== null && cost.est_max_cny > args.budgetCny) {
      fail(
        `预算拦截：${runQueue.length} 张 × ¥${price}/张 × 最多 ${maxAttempts} 次尝试 = 最坏估算 ¥${cost.est_max_cny}，超出预算 ¥${args.budgetCny}（成功一次也要 ¥${cost.est_min_cny}）。` +
          `可上调 --budget-cny、减少张数（--only-ids / --max-images-per-run）或降低 --max-attempts-per-image`,
      );
      return;
    }
  }

  if (args.dryRun) {
    const p = plan.map((x) => ({ id: x.item.id, kind: x.item.kind, action: x.action, status: x.entry.status }));
    console.log(`[PLAN] ${JSON.stringify({ article_dir: articleDir, mode: args.mode, provider: provider.name, model_fingerprint: modelFingerprint, style_gate: styleGate, cost, items: p })}`);
    return;
  }

  // ── --promote：独立小事务（取锁，提升 ready 候选）──
  if (args.promote) {
    await runPromote(args, { articleDir, manifestPath, manifest0 });
    return;
  }

  // ── 生成阶段（持锁，D5：锁 PID=本进程，全程有效）──
  const summary = {
    ok: false,
    mode: args.mode,
    article_dir: articleDir,
    total: targets.length,
    succeeded: 0,
    failed: 0,
    pending: 0,
    unknown: 0,
    manifest_path: manifestPath,
    generated_paths: [],
    failed_ids: [],
    pending_ids: [],
    unknown_ids: [],
    paused_unknown: false,
    requests_issued: 0,
    budget_stopped: false,
    capped_remaining: cappedRemaining,
    cost,
  };

  let lockRef = null;
  try {
    lockRef = await withArticleLock(path.join(articleDir, LOCK_NAME), { runId: `imggen-${Date.now().toString(36)}`, scope: "image-generate" }, async () => {
      const interDelayMs = Number(process.env.IMAGE_GEN_INTER_DELAY_MS ?? 1000);
      for (let i = 0; i < runQueue.length; i++) {
        if (interrupted) break;
        const outcome = await runOne(runQueue[i], {
          articleDir,
          manifestPath,
          manifest: manifest0,
          provider,
          providerContext,
          args,
          maxAttempts,
          modelFingerprint,
          referenceHash,
          summary,
          price,
          budgetCny: args.budgetCny,
        });
        if (outcome === "paused-unknown") {
          summary.paused_unknown = true;
          break; // 扣费不确定：暂停转人工，不因 --continue-on-error 继续
        }
        if (outcome === "budget-stopped") {
          summary.budget_stopped = true;
          break; // 累计估算超预算：剩余条目留 pending，提额后可续跑
        }
        if (outcome === "stopped" && !args.continueOnError) break;
        // 图间隔节流（限流防线：免费档 QPS 敏感，T1.10 实测 27 连发触发小时级配额封锁）
        if (i < runQueue.length - 1 && interDelayMs > 0 && !interrupted) {
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

  // ── preview 成功后写入风格审批绑定（P1.5-B：preview_completed + 当时输入指纹）──
  if (args.mode === "preview") {
    const repEntry = plan[0].entry;
    if (repEntry.status === STATUS.SUCCEEDED) {
      manifest0.style_approval = {
        ...newStyleApproval(),
        status: "preview_completed",
        preview_image_id: previewItem.id,
        preview_prompt_hash: bindingPreviewHash,
        style_hash: styleHashV,
        model_fingerprint: modelFingerprint,
        reference_hash: referenceHash ?? null,
        fingerprint: currentFingerprint,
        preview_path: repEntry.path,
        updated_at: new Date().toISOString(),
      };
      await saveManifest(manifestPath, manifest0);
      summary.style_approval = { status: "preview_completed", preview_image_id: previewItem.id, fingerprint: currentFingerprint, preview_path: repEntry.path };
    } else {
      // 预览未成功：若旧审批绑定已失效则物化回 pending（懒失效）
      const sa = styleApprovalOf(manifest0);
      if (sa.status === "approved" && sa.fingerprint !== currentFingerprint) {
        manifest0.style_approval = { ...sa, status: "pending", updated_at: new Date().toISOString() };
        await saveManifest(manifestPath, manifest0);
      }
    }
  }

  // 汇总（skip/report-only/被中断未跑的都计入 pending；unknown 单列）
  for (const { entry } of plan) {
    if (entry.status === STATUS.SUCCEEDED) summary.succeeded += 1;
    else if (entry.status === STATUS.FAILED) {
      summary.failed += 1;
      summary.failed_ids.push(entry.id);
    } else if (entry.status === STATUS.UNKNOWN) {
      summary.unknown += 1;
      summary.unknown_ids.push(entry.id);
    } else if (entry.status === STATUS.STALE) {
      // stale = 有有效原图，本轮未完成再生成：计入 pending（可续）
      summary.pending += 1;
      summary.pending_ids.push(entry.id);
    } else {
      summary.pending += 1;
      summary.pending_ids.push(entry.id);
    }
  }
  summary.paused_unknown = summary.paused_unknown || summary.unknown_ids.length > 0;
  summary.requests_issued = manifest0.requests_issued - requestsIssuedStart;
  summary.requests_issued_total = manifest0.requests_issued;
  summary.ok = summary.failed === 0 && summary.pending === 0 && summary.unknown === 0;

  console.log(`[RESULT] ${JSON.stringify(summary)}`);
  process.exit(interrupted ? 130 : summary.ok ? 0 : 1);
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

/**
 * 单条目执行（主链或候选链）。返回 "done" | "stopped"。
 * 每次 Manifest 状态转换即时落盘（running 即写，压双计费窗口到单图粒度）。
 */
async function runOne(step, ctx) {
  const { articleDir, manifestPath, manifest, provider, providerContext, args, modelFingerprint, summary, maxAttempts, price, budgetCny } = ctx;
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

  const maxAttemptsResolved = maxAttempts ?? 1 + (args.maxRetries ?? 2);
  let lastErr = null;
  let lastUncertain = false;

  try {
    for (let n = 1; n <= maxAttemptsResolved; n++) {
      if (interrupted) break;
      // 预算运行时门（V1.1 评审建议 1）：每次发请求前检查累计估算消耗（估算口径，非实际账单）；
      // 超限不发请求，条目保持原状态回 pending（走 finally 无副作用分支）
      if (price !== null && price !== undefined && budgetCny !== null && budgetCny !== undefined) {
        if ((manifest.requests_issued + 1) * price > budgetCny + 1e-9) {
          console.log(
            `[BUDGET] stop ${item.id}: 累计请求 ${manifest.requests_issued} 次 × ¥${price} + 本次 ¥${price} 将超预算 ¥${budgetCny}，停止（估算口径，剩余条目留 pending）`,
          );
          return "budget-stopped";
        }
      }
      manifest.requests_issued += 1;
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
        lastErr = null; // 成功即清：防 finally 终态块把已成功条目改写为 FAILED（T1.10 实测踩坑）
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
        // P1.5-D：超时/连接中断 → 请求可能已送达并计费，扣费不确定 → 不重试、整跑暂停转人工
        const uncertain = e.uncertain === true || UNCERTAIN_CODES.has(e.code);
        if (uncertain) lastUncertain = true;
        const brief = String(e.message ?? "").replace(/\s+/g, " ").slice(0, 140);
        console.log(`[IMG fail] ${item.id} attempts=${n} code=${e.code ?? "E_UNKNOWN"}${uncertain ? " (uncertain:扣费不确定)" : recoverable ? " (recoverable)" : ""} ${brief}`);
        if (interrupted || (e.code === "E_ABORTED" && abortController.signal.aborted)) break;
        if (uncertain) break; // 扣费不确定：禁自动重试（需求第三节/第七节，验收 6）
        if (!recoverable || n >= maxAttemptsResolved) break;
        // 可恢复错误退避后重试（限流类 429 连发零退避只会连烧三次配额）
        await new Promise((r) => setTimeout(r, 2000 * n));
      }
    }
  } finally {
    // 终态落盘：失败/不确定/中断收敛
    if (interrupted) {
      if (isCandidate) {
        candRecord.status = CAND_STATUS.PENDING;
      } else {
        entry.status = STATUS.PENDING;
      }
      entry.updated_at = new Date().toISOString();
      await saveManifest(manifestPath, manifest).catch(() => {});
    } else if (lastErr && lastUncertain) {
      // unknown：扣费不确定，禁自动重试，待人工（--retry-unknown 显式确认后才重生成）
      if (isCandidate) {
        candRecord.status = CAND_STATUS.FAILED;
        candRecord.error_code = lastErr.code ?? "E_UNKNOWN";
        entry.uncertain = true;
      } else {
        entry.status = STATUS.UNKNOWN;
        entry.error_code = lastErr.code ?? "E_UNKNOWN";
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
  return lastUncertain ? "paused-unknown" : "stopped";
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

/** --approve-style：风格确认独立动作（P1.5-B）。绑定校验失败 → exit 2 绝不沿用旧审批（验收 2）。
 *  模型指纹用预览时快照（不重新装载 provider，避免无 key 场景误拒）；
 *  模型变更在 batch 门重算指纹时必然失配拦下。 */
async function runApproveStyle(args, { articleDir, manifestPath, prompts }) {
  const { doc: manifest } = await loadManifest(articleDir, manifestPath);
  const sa = styleApprovalOf(manifest);
  if (sa.status !== "preview_completed" && sa.status !== "approved") {
    fail(`--approve-style：当前风格审批状态为 ${sa.status}，需先 --mode preview 生成预览图`);
    return;
  }
  const repItem = sa.preview_image_id ? prompts.items.find((it) => it.id === sa.preview_image_id) ?? null : null;
  const previewHash = repItem ? promptHash(prompts.style_prefix, repItem.prompt) : null;
  let refHash = null;
  if (args.styleReference) {
    try {
      refHash = await fileSha256(path.resolve(args.styleReference));
    } catch {
      fail(`--style-reference 文件不存在：${args.styleReference}`);
      return;
    }
  }
  const fp = styleBindingFingerprint({
    styleHashV: styleHash(prompts.style_prefix),
    previewPromptHash: previewHash,
    modelFingerprint: sa.model_fingerprint,
    referenceHash: refHash,
  });
  if (fp !== sa.fingerprint) {
    // 预览后输入已变更：旧审批不得沿用，物化回 pending（验收 2）
    manifest.style_approval = { ...sa, status: "pending", updated_at: new Date().toISOString() };
    await saveManifest(manifestPath, manifest);
    fail("--approve-style：预览后提示词/风格已变更，原预览失效（已回 pending），请重新 --mode preview");
    return;
  }
  if (sa.status === "approved") {
    console.log(`[RESULT] ${JSON.stringify({ ok: true, approved: true, already: true, preview_image_id: sa.preview_image_id, fingerprint: sa.fingerprint })}`);
    process.exit(0);
  }
  const updated = { ...sa, status: "approved", approved_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  try {
    await withArticleLock(path.join(articleDir, LOCK_NAME), { runId: `style-${Date.now().toString(36)}`, scope: "image-generate" }, async () => {
      manifest.style_approval = updated;
      await saveManifest(manifestPath, manifest);
    });
  } catch (e) {
    if (e instanceof LockHeldError) {
      console.log(`[LOCKED] pid=${e.info?.pid} runId=${e.info?.runId}`);
      process.exit(3);
    }
    throw e;
  }
  console.log(`[RESULT] ${JSON.stringify({ ok: true, approved: true, preview_image_id: updated.preview_image_id, fingerprint: updated.fingerprint, approved_at: updated.approved_at })}`);
  process.exit(0);
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
