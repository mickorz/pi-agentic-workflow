// image-use Provider（P1.6 / T2）：ChatGPT 订阅 web 后端适配器（零 API 计费）。
// 方案：dev-docs/planning/2026-10-27-image-use-provider接入执行方案.md（V3）
//
// 形态：spawn 子进程调用 vendored 脚本 thirdparties/image-use/image-use：
//   python <script> "<prompt>" -o <outPath> --backend web --quiet [--size S] [--style-ref R] [--timeout T]
// stdout 契约（--quiet）：只有保存路径；stderr 是进度时间线（提交标记的证据源，不传 --no-progress）。
//
// 设计决策（V3 决策树，方案 2.3 节）：
//   1. 本 provider 刻意不用 recoverable:true 触发执行器秒级退避自动重试——免费通道的重试代价
//      是每日配额与账号风控（上游 SKILL 明示 do not retry in a loop）；失败停跑留状态，人工重跑即续。
//      唯一例外：可证明未提交的外部中断（E_ABORTED，条目回 pending 由执行器中断语义处理）。
//   2. 提交标记判据（stderr 时间线，上游 L2868/L2902/L2953）：
//      - "prompt submitted once" → 已确认提交
//      - "pasting prompt" / "verified prompt" / "attaching" / "uploaded" → 发送窗口，无法证明未提交
//      - 均无 → 可证明未提交
//      可能已提交（标记存在或无法判断）→ uncertain=true（执行器置 unknown，人工走 recover + --resolve-unknown）。
//   3. stderr 双层出口：完整尾部（含会话 URL）只进本地 console.error；
//      error.message 只含分类名+首行摘要，不含 URL（微信回执源头是 [IMG fail] 140 字符 brief）。
//   4. 路径契约：stdout 解析路径 resolve 后必须等于 outPath 的 resolve（防上游写偏，含越界文章目录）。
import { spawn } from "node:child_process";
import path from "node:path";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const providerId = "image-use";
export const defaultModel = "web";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 本模块在 <repo>/dev-examples/wx-article/scripts/image_gen/lib/providers/ 下，向上 6 层到仓库根
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..", "..", "..", "..");
const DEFAULT_SCRIPT = path.join(REPO_ROOT, "thirdparties", "image-use", "image-use");

/** 缺省单次尝试预算：image-use 缺省 --timeout 300s + 落盘余量（方案 2.1） */
const DEFAULT_DEADLINE_MS = 330_000;
/** 后端：web=chrome-use 驱动已登录浏览器（Windows 主力）；codex=headless 复用 ~/.codex/auth.json（Mac 无 chrome-use 时用，计 Codex 订阅额度） */
const DEFAULT_BACKEND = "web";
/** --timeout flag 最小安全值：仅当 floor(deadline/1000)-5 ≥ 30 才传，防小 deadline 出负数（V3 细节修 1） */
const MIN_CLI_TIMEOUT_S = 30;

/** 提交标记（方案 2.3）：命中任一 = 无法证明未提交（已提交或发送窗口已开启） */
const SUBMITTED_RE = /prompt submitted once|pasting prompt|verified prompt|attaching \d+ reference|reference image\(s\) uploaded/i;

/** fail-fast（A08 对齐）：脚本缺失在取锁前报错；不做 python 探测（缺 python 在首次 generate 以 E_NO_PYTHON 暴露） */
export function buildSettings(env = process.env) {
  const script = env.IMAGE_USE_SCRIPT || DEFAULT_SCRIPT;
  return {
    pythonBin: env.IMAGE_USE_PYTHON || (process.platform === "win32" ? "python" : "python3"),
    script,
    scriptExists: null, // generate() 内惰性检查；buildSettings 只锁配置
    backend: env.IMAGE_USE_BACKEND || DEFAULT_BACKEND,
  };
  if (cfg.backend !== "web" && cfg.backend !== "codex") {
    throw new Error(`IMAGE_USE_BACKEND 非法（web|codex）: ${cfg.backend}`);
  }
}

/** 命令拼装（纯函数，IU-2 断言对象）。deadlineMs=330000 时 timeout flag 为 325s。 */
export function buildArgs({ prompt, outPath, size, reference, deadlineMs = DEFAULT_DEADLINE_MS, backend = DEFAULT_BACKEND }) {
  const args = ["--backend", backend, "--quiet"];
  if (prompt !== undefined && prompt !== null) args.push(String(prompt));
  args.push("-o", outPath);
  if (size && String(size).trim()) args.push("--size", String(size).trim());
  if (reference) args.push("--style-ref", reference);
  const cliTimeout = Math.floor(deadlineMs / 1000) - 5;
  if (cliTimeout >= MIN_CLI_TIMEOUT_S) args.push("--timeout", String(cliTimeout));
  return args;
}

/** 已知未提交特征 → { code }（方案 2.3 第 5 行；顺序敏感：在 already submitted 之后判定） */
function matchPresubmit(stderr) {
  const s = String(stderr ?? "");
  if (/chrome-use/i.test(s)) return { code: "E_ENV" };
  if (/rate-limited this account/i.test(s)) return { code: "E_RATE_LIMIT" };
  if (/image-generation limit|declined the image request/i.test(s)) return { code: "E_QUOTA" };
  if (/\blog(?:ged)?\s*in\b|\bsign\s*in\b/i.test(s)) return { code: "E_LOGIN" };
  return null;
}

/**
 * 失败分类决策树（纯函数，IU-1 表格驱动断言，V3 全 8 行）。
 * 入参：{ spawnError, exitCode, stdout, stderr, externalAbort, selfTimeout }
 * 返回：{ code, recoverable, uncertain, summary }（summary 不含 URL）
 */
export function classifyFailure({ spawnError, exitCode, stdout, stderr, externalAbort = false, selfTimeout = false }) {
  const errText = String(stderr ?? "");
  const firstLine = (errText.split("\n").find((l) => l.trim()) || "").trim();

  // 1. spawn ENOENT：从未启动，可证明未提交（按 spawnError 文本区分解释器/脚本缺失）
  if (spawnError && /ENOENT/i.test(String(spawnError.message ?? spawnError))) {
    const spawnText = String(spawnError.message ?? spawnError);
    const code = /python/i.test(spawnText) ? "E_NO_PYTHON" : "E_NO_SCRIPT";
    return { code, recoverable: false, uncertain: false, summary: "解释器或脚本缺失（进程未启动）" };
  }
  // 4. 已提交未确认（含提交后限流变体）
  if (/already submitted/i.test(errText)) {
    return { code: /rate-limited/i.test(errText) ? "E_RATELIMIT_SUBMITTED" : "E_TIMEOUT", recoverable: false, uncertain: true, summary: "提示词已提交但未确认出图" };
  }
  // 5. 已知未提交特征（环境/配额/登录）：立即停跑，不自动刷新登录不自动重试
  const pre = matchPresubmit(errText);
  if (pre) return { code: pre.code, recoverable: false, uncertain: false, summary: firstLine.slice(0, 80) || pre.code };
  // 6/6b. 外部中断（SIGINT）：按提交标记分流（V3 P0-1）
  if (externalAbort) {
    if (SUBMITTED_RE.test(errText)) {
      return { code: "E_ABORTED", recoverable: false, uncertain: true, summary: "中断时提示词可能已提交（发送窗口或已提交），禁止自动重发，人工检查会话后走 recover 导入" };
    }
    return { code: "E_ABORTED", recoverable: true, uncertain: false, summary: "中断于提交前（可证明未提交）" };
  }
  // 7/8. 自超时 / crash 兜底：有提交标记 → uncertain；无标记 → 不重试停跑
  if (selfTimeout || exitCode !== 0) {
    const code = selfTimeout ? "E_TIMEOUT" : "E_CRASH";
    if (SUBMITTED_RE.test(errText)) {
      return { code, recoverable: false, uncertain: true, summary: (selfTimeout ? "自超时" : "进程异常退出") + "且可能已提交" };
    }
    return { code, recoverable: false, uncertain: false, summary: (selfTimeout ? "自超时" : "进程异常退出") + "（未见提交标记，可证明未提交）" };
  }
  // 3. exit 0 但输出异常（stdout 空/路径不符在 generate 里前置抛 E_BAD_OUTPUT，此处兜底）
  return { code: "E_BAD_OUTPUT", recoverable: false, uncertain: false, summary: firstLine.slice(0, 80) || "exit 0 但无有效输出" };
}

function mkError(cls, detail) {
  const err = new Error(`[image-use ${cls.code}] ${cls.summary}${detail ? `：${detail}` : ""}`);
  err.code = cls.code;
  err.recoverable = cls.recoverable === true;
  err.uncertain = cls.uncertain === true;
  return err;
}

function mimeFromExt(ext = "") {
  const e = ext.toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".webp") return "image/webp";
  return "application/octet-stream";
}

/**
 * 统一 Provider 接口（与 fake.mjs / pi-image-gen.mjs 同签名）。
 * context.settings：buildSettings() 产物（执行器装载时注入）；context.timeoutMs 覆盖缺省 deadline。
 */
export async function generate({ prompt, outPath, model, signal, context = {}, reference }) {
  void model; // web 后端无模型可选；模型指纹 image-use:web 由 providerId+defaultModel 构成
  const cfg = context.settings ?? buildSettings();
  const started = Date.now();
  const deadlineMs = Number(context.timeoutMs ?? process.env.IMAGE_USE_TIMEOUT_MS ?? DEFAULT_DEADLINE_MS);
  const sizeHint = process.env.IMAGE_GEN_SIZE?.trim() || null;
  const args = buildArgs({ prompt, outPath, size: sizeHint, reference, deadlineMs, backend: cfg.backend });

  // fail-fast：脚本缺失（buildSettings 不做 IO，这里做一次存在性检查，E_NO_SCRIPT 语义）
  try {
    await fsp.access(cfg.script);
  } catch {
    throw mkError({ code: "E_NO_SCRIPT", recoverable: false, uncertain: false, summary: "vendored 脚本缺失（进程未启动）" });
  }

  // 外部中断 vs 自超时区分：外部 signal 触发且尚未到自deadline → externalAbort；AbortSignal.timeout 触发 → selfTimeout
  // 前置检查：signal 已 aborted（中断先于本张开始）→ 未 spawn，可证明未提交，直接中断语义
  if (signal?.aborted) {
    throw mkError({ code: "E_ABORTED", recoverable: true, uncertain: false, summary: "中断于进程启动前（可证明未提交）" }, null);
  }
  let externalAbort = false;
  let selfTimeout = false;
  const selfTimer = AbortSignal.timeout(deadlineMs);
  const onExternal = () => {
    if (!selfTimer.aborted) externalAbort = true;
  };
  signal?.addEventListener("abort", onExternal, { once: true });
  const onSelf = () => {
    if (!signal?.aborted) selfTimeout = true;
  };
  selfTimer.addEventListener("abort", onSelf, { once: true });

  const childEnv = { ...process.env };
  childEnv.PYTHONUTF8 ??= "1"; // Windows GBK：中文路径/提示词必需
  childEnv.PYTHONIOENCODING ??= "utf-8";
  childEnv.IMAGE_USE_NO_UPDATE_CHECK = "1"; // vendoring 禁自动升级（T1），升级走人工四件套流程

  // kill 回调放外层：finally 需要解除监听（signal 是执行器全局共享的，批量下会累积）
  let childRef = null;
  const abortAll = () => childRef?.kill();

  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cfg.pythonBin, [cfg.script, ...args], { shell: false, env: childEnv });
    childRef = child;
    signal?.addEventListener("abort", abortAll, { once: true });
    selfTimer.addEventListener("abort", abortAll, { once: true });
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      reject(mkError(classifyFailure({ spawnError: e, stderr }), null));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      // 成功路径：exit 0 + stdout 路径 + 路径契约 + 文件核验（轻量存在性/大小；格式嗅探由执行器 verifyImageFile 兜底）
      if (code === 0) {
        const out = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
        if (!out) {
          console.error(`[image-use] 完整 stderr 尾部：\n${stderr.slice(-2000)}`);
          return reject(mkError(classifyFailure({ exitCode: 0, stdout: "", stderr }), "stdout 无路径"));
        }
        const resolvedOut = path.resolve(out);
        if (resolvedOut !== path.resolve(outPath)) {
          console.error(`[image-use] 输出路径不符：stdout=${out} 期望=${outPath}\n${stderr.slice(-2000)}`);
          return reject(mkError({ code: "E_BAD_OUTPUT", recoverable: false, uncertain: false, summary: "输出路径与 outPath 不一致（越界拒绝）" }, out));
        }
        fsp
          .stat(resolvedOut)
          .then((st) => {
            if (!st.isFile() || st.size <= 0) throw new Error("empty");
            resolve({
              path: resolvedOut,
              mime: mimeFromExt(path.extname(resolvedOut)),
              bytes: st.size,
              format: path.extname(resolvedOut).replace(".", "").toLowerCase(),
              width: null,
              height: null,
              model: defaultModel,
              provider: providerId,
              durationMs: Date.now() - started,
            });
          })
          .catch(() => {
            console.error(`[image-use] 落盘文件无效：${resolvedOut}\n${stderr.slice(-2000)}`);
            reject(mkError({ code: "E_BAD_OUTPUT", recoverable: false, uncertain: false, summary: "落盘文件缺失或空文件" }, resolvedOut));
          });
        return;
      }
      // 失败路径：完整 stderr 只进本地日志（含会话 URL），error.message 不含 URL
      console.error(`[image-use] exit=${code} 完整 stderr 尾部：\n${stderr.slice(-2000)}`);
      reject(mkError(classifyFailure({ exitCode: code, stdout, stderr, externalAbort, selfTimeout }), null));
    });
  }).finally(() => {
    signal?.removeEventListener("abort", onExternal);
    signal?.removeEventListener("abort", abortAll);
    selfTimer.removeEventListener("abort", onSelf);
    selfTimer.removeEventListener("abort", abortAll);
  });
}
