/**
 * GZH 排版工作台文章路由(T0.2,方案 V2)
 *
 * 设计:dev-docs/planning/2026-11-03-GZH排版工作台执行方案.md 4.2/4.3
 * 端点(Bearer 保护,由 app.ts 的 onRequest 钩子统一校验):
 *   GET  /api/gzh/articles            文章目录列表(按 md mtime 倒序,限 30)
 *   GET  /api/gzh/article?dir=<abs>   加载正文(图片引用重写为签名 URL)+ yaml 字段 + 基线哈希
 *   POST /api/gzh/article/save        保存(锁 + baseHash 冲突检测 + 双文件一致性回滚)
 * 免 Bearer(自带 HMAC 签名校验):
 *   GET  /gzh-img?d=&f=&e=&s=          文章图片(iframe 的 img 标签无法携带 Authorization 头)
 *
 * 安全约束:
 *   - dir 必须位于 vault root 之内(resolve + realpath 双重前缀校验,防 .. 与符号链接逃逸)
 *   - 图片仅允许 <articleDir>/imgs/ 下的一级文件名(不含路径分隔符)
 *   - 锁协议与 dev-examples/wx-article/scripts/draft_manager/article_lock.py 完全同格式,
 *     Python 侧与 Node 侧互拍可解锁;不重新发明锁文件格式
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

export interface GzhRoutesDeps {
  vaultRoot: string;
  /** HMAC 密钥(生产侧由 Web token 派生,测试可注入固定值) */
  imgSecret: string;
}

/** 与 check_state.py 的正文定位排除规则保持一致(不猜原则:多候选即报错) */
const MD_PREFIX_EXCLUDE = /^(article|draft|review)/;
const MD_NAME_ILLEGAL = ["审稿", "图片引用清单", "大纲", "配图建议"];

const IMG_URL_PATTERN = /\/gzh-img\?[^)\s"']+/g;
const MD_REF_PATTERN = /(!\[[^\]]*\]\()([^)]+)(\))/g;

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function err(code: string, message: string, details?: unknown): Error & { code: string; details?: unknown } {
  const e = new Error(message) as Error & { code: string; details?: unknown };
  e.code = code;
  e.details = details;
  return e;
}

/** resolve + realpath 双重校验:目标必须仍在 vault root 内(防 .. 与符号链接逃逸) */
function resolveInside(root: string, target: string): string {
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw err("FORBIDDEN_PATH", `路径越界: ${target}`);
  }
  try {
    const real = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw err("FORBIDDEN_PATH", `路径越界(符号链接): ${target}`);
    }
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === "FORBIDDEN_PATH") throw e;
    throw err("NOT_FOUND", `路径不存在: ${target}`);
  }
  return resolved;
}

/** 找文章正文 md:与 check_state.py 5.1 规则完全一致——
 *  article.yaml 有 content_source 时确定性指定优先(命中即唯一);否则唯一合法才自动,多候选报错不猜 */
function findArticleMd(articleDir: string): string {
  const entries = fs
    .readdirSync(articleDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name)
    .filter((n) => !MD_PREFIX_EXCLUDE.test(n) && !MD_NAME_ILLEGAL.some((b) => n.includes(b)));
  const yaml = readYamlFields(articleDir);
  if (yaml.contentSource) {
    if (!entries.includes(yaml.contentSource)) {
      throw err("NOT_FOUND", `content_source=${yaml.contentSource} 在目录中无对应 md 文件`);
    }
    return yaml.contentSource;
  }
  if (entries.length === 0) throw err("NOT_FOUND", `目录内没有可识别的正文 md: ${articleDir}`);
  if (entries.length > 1) {
    throw err("INVALID_INPUT", "正文 md 不唯一,拒绝猜测(需 article.yaml content_source 确定性指定)", {
      candidates: entries,
    });
  }
  return entries[0] as string;
}

/** 读 article.yaml 已知字段(check_state.py 同规则;style 为本工作台新增字段) */
function readYamlFields(articleDir: string): {
  title: string;
  digest: string;
  author: string;
  style: string;
  contentSource: string;
} {
  const out = { title: "", digest: "", author: "", style: "", contentSource: "" };
  const p = path.join(articleDir, "article.yaml");
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^(title|digest|author|style|content_source)\s*:\s*["']?(.+?)["']?\s*$/);
    const key = m?.[1] as "title" | "digest" | "author" | "style" | "content_source" | undefined;
    if (m && key && m[2] !== undefined) {
      (key === "content_source" ? (out.contentSource = m[2]) : (out[key] = m[2]));
    }
  }
  return out;
}

/** 写 yaml 的 style 字段:有则整行替换,无则追加;其余行原样保留 */
function writeYamlStyle(articleDir: string, style: string): void {
  const p = path.join(articleDir, "article.yaml");
  const old = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const line = `style: ${style}`;
  const lines = old.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^style\s*:/.test(l));
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  // 去尾空行后统一补一个换行,保证文件以单换行结尾(避免双追加/双换行)
  atomicWrite(p, lines.join("\n").replace(/\n+$/, "") + "\n");
}

/** 同目录临时文件 + rename 原子替换(与 article_state.py 的 os.replace 语义一致) */
function atomicWrite(filePath: string, content: string): void {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.gzh-tmp`);
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

// ---------- 文章锁(article_lock.py 同协议:O_CREAT|O_EXCL + JSON 内容 + pid 判活接管) ----------
const LOCK_NAME = ".publish.article.lock";

class LockHeldError extends Error {
  code = "CONFLICT";
  details: Record<string, unknown>;
  constructor(holder: Record<string, unknown>) {
    super(`文章锁被其他存活进程持有(pid=${holder.pid}),拒绝写入`);
    this.details = { holder };
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !((e as { code?: string }).code === "ESRCH");
  }
}

function acquireArticleLock(articleDir: string, runId: string): void {
  const lockPath = path.join(articleDir, LOCK_NAME);
  const content = JSON.stringify({
    pid: process.pid,
    runId,
    granularity: "article",
    acquiredAt: new Date().toISOString(),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, content, "utf8");
      fs.closeSync(fd);
      return;
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
      // 锁被持有:读持有者,进程已死视为残留锁可接管(与 Python 侧语义一致);存活则转人工
      let holder: Record<string, unknown> = {};
      try {
        holder = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
      } catch {
        holder = {};
      }
      const alive = typeof holder.pid === "number" ? pidAlive(holder.pid) : false;
      if (!alive && attempt === 0) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* 竞争失败则下一轮重试 */
        }
        continue;
      }
      throw new LockHeldError(holder);
    }
  }
}

function releaseArticleLock(articleDir: string): void {
  try {
    fs.unlinkSync(path.join(articleDir, LOCK_NAME));
  } catch {
    /* 已不存在视为已释放 */
  }
}

// ---------- 签名图片 URL ----------
function signImageUrl(secret: string, articleDir: string, fileName: string, ttlMs: number): string {
  const exp = Date.now() + ttlMs;
  const mac = crypto.createHmac("sha256", secret).update(`${articleDir}\n${fileName}\n${exp}`).digest("hex");
  const q = new URLSearchParams({ d: articleDir, f: fileName, e: String(exp), s: mac });
  return `/gzh-img?${q.toString()}`;
}

/** 保存时把签名 URL 还原为 imgs/ 相对路径(不转 Base64,保住文章目录结构) */
function restoreImageRefs(markdown: string): { markdown: string; restored: string[] } {
  const restored: string[] = [];
  const markdown2 = markdown.replace(IMG_URL_PATTERN, (url) => {
    // markdown-it 渲染 HTML 属性时会把 & 转义为 &amp;,解析前先还原
    const normalized = url.replace(/&amp;/g, "&");
    // new URL 的首参必须是 query 形态(补 ?),否则会被当路径解析导致 searchParams 全空
    const q = new URL(`?${normalized.slice(normalized.indexOf("?") + 1)}`, "http://x");
    const f = q.searchParams.get("f") ?? "";
    if (!f) return url;
    restored.push(f);
    return `imgs/${f}`;
  });
  return { markdown: markdown2, restored };
}

/** 列出文章图片文件(仅 imgs/ 一级文件) */
function listImages(articleDir: string): string[] {
  const imgsDir = path.join(articleDir, "imgs");
  if (!fs.existsSync(imgsDir)) return [];
  return fs
    .readdirSync(imgsDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

// ---------- 路由注册 ----------
export function registerGzhRoutes(app: FastifyInstance, deps: GzhRoutesDeps): void {
  const vaultRoot = path.resolve(deps.vaultRoot);
  const TTL = 24 * 3600 * 1000;

  app.get("/api/gzh/articles", async () => {
    // 扫描根:优先已知的单篇目录结构,否则退回 vault 根(测试夹具/自定义布局)
    const preferred = path.join(vaultRoot, "60_Workspace", "写作", "单篇");
    const scanRoot = fs.existsSync(preferred) ? preferred : vaultRoot;
    const found: Array<{ dir: string; title: string; mtime: number; style: string; drafted: boolean }> = [];
    const walk = (dir: string, depth: number) => {
      if (found.length >= 60 || depth > 3) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        const sub = path.join(dir, e.name);
        // 目录自身有 md:尝试当文章目录收录(多候选/无正文不报错,仅不下钻前先试)
        const hasMd = fs
          .readdirSync(sub, { withFileTypes: true })
          .some((x) => x.isFile() && x.name.toLowerCase().endsWith(".md"));
        if (hasMd) {
          try {
            const mdName = findArticleMd(sub);
            const stat = fs.statSync(path.join(sub, mdName));
            const yaml = readYamlFields(sub);
            const drafted = fs.existsSync(path.join(sub, "publish-state.json"));
            found.push({ dir: sub, title: mdName.replace(/\.md$/i, ""), mtime: stat.mtimeMs, style: yaml.style, drafted });
          } catch {
            /* 多候选/无正文:该目录不是文章目录,但子目录仍可能是(如日期层夹散故剪藏) */
          }
        }
        // 始终下钻:容器目录(日期层等)不因自身有 md 而阻断子目录扫描
        walk(sub, depth + 1);
      }
    };
    walk(scanRoot, 0);
    found.sort((a, b) => b.mtime - a.mtime);
    return { articles: found.slice(0, 30) };
  });

  app.get("/api/gzh/article", async (req) => {
    const dirRaw = (req.query as { dir?: string }).dir;
    if (!dirRaw) throw err("INVALID_INPUT", "缺少 dir 参数");
    const dir = resolveInside(vaultRoot, dirRaw);
    const mdName = findArticleMd(dir);
    const raw = fs.readFileSync(path.join(dir, mdName), "utf8");
    const imgs = listImages(dir);
    const imgSet = new Set(imgs);
    // 加载方向:imgs/xxx.png -> 签名 URL(仅白名单内文件,防外部 URL 被替换)
    const markdown = raw.replace(MD_REF_PATTERN, (whole, head, ref, tail) => {
      const m = ref.match(/^(?:\.\/)?imgs\/([^/)]+)$/);
      const name = m ? decodeURIComponent(m[1]) : "";
      if (!name || !imgSet.has(name)) return whole;
      return head + signImageUrl(deps.imgSecret, dir, name, TTL) + tail;
    });
    const yaml = readYamlFields(dir);
    const yamlPath = path.join(dir, "article.yaml");
    return {
      dir,
      mdName,
      markdown,
      mdHash: sha256Hex(raw),
      style: yaml.style,
      styleHash: fs.existsSync(yamlPath) ? sha256Hex(fs.readFileSync(yamlPath)) : "",
      yaml: { title: yaml.title, digest: yaml.digest, author: yaml.author, contentSource: yaml.contentSource },
      images: imgs.map((f) => ({ name: f, url: signImageUrl(deps.imgSecret, dir, f, TTL) })),
    };
  });

  app.post("/api/gzh/article/save", {
    schema: {
      body: {
        type: "object",
        required: ["dir"],
        properties: {
          dir: { type: "string" },
          markdown: { type: "string" },
          style: { type: "string" },
          baseMdHash: { type: "string" },
          baseStyleHash: { type: "string" },
          runId: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    handler: async (req) => {
      const body = req.body as {
        dir: string;
        markdown?: string;
        style?: string;
        baseMdHash?: string;
        baseStyleHash?: string;
        runId?: string;
      };
      const dir = resolveInside(vaultRoot, body.dir);
      if (body.markdown === undefined && body.style === undefined) {
        throw err("INVALID_INPUT", "没有可保存的字段(markdown/style 至少一项)");
      }
      const mdName = findArticleMd(dir);
      const mdPath = path.join(dir, mdName);
      const yamlPath = path.join(dir, "article.yaml");

      acquireArticleLock(dir, body.runId ?? `gzh-preview-${process.pid}`);
      try {
        const saved: string[] = [];
        let newMdHash: string | undefined;
        let newStyleHash: string | undefined;
        // —— 正文:baseHash 校验 + 签名 URL 还原 + 原子替换 ——
        const oldMd = fs.readFileSync(mdPath, "utf8");
        if (body.markdown !== undefined) {
          if (body.baseMdHash !== undefined && sha256Hex(oldMd) !== body.baseMdHash) {
            throw err("CONFLICT", "正文已被其他进程修改,拒绝覆盖(请重新加载)", { field: "markdown" });
          }
          const { markdown } = restoreImageRefs(body.markdown);
          atomicWrite(mdPath, markdown);
          saved.push("markdown");
          newMdHash = sha256Hex(markdown);
        }
        // —— 主题:只动 yaml 的 style 行,md 字节级不变 ——
        if (body.style !== undefined) {
          const oldYaml = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, "utf8") : "";
          try {
            if (body.baseStyleHash !== undefined && fs.existsSync(yamlPath)) {
              if (sha256Hex(oldYaml) !== body.baseStyleHash) {
                throw err("CONFLICT", "article.yaml 已被其他进程修改,拒绝覆盖(请重新加载)", { field: "style" });
              }
            }
            writeYamlStyle(dir, body.style);
            saved.push("style");
            newStyleHash = sha256Hex(fs.readFileSync(yamlPath, "utf8"));
          } catch (e) {
            // 双文件一致性:md 已写而 yaml 失败 -> 用内存中的旧内容回滚 md,显式报错
            if (saved.includes("markdown")) {
              atomicWrite(mdPath, oldMd);
            }
            throw e;
          }
        }
        return { dir, saved, mdHash: newMdHash, styleHash: newStyleHash };
      } finally {
        releaseArticleLock(dir);
      }
    },
  });

  app.post("/api/gzh/article/export", {
    schema: {
      body: {
        type: "object",
        required: ["dir", "html"],
        properties: {
          dir: { type: "string" },
          html: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    handler: async (req) => {
      const body = req.body as { dir: string; html: string };
      const dir = resolveInside(vaultRoot, body.dir);
      if (body.html.trim().length < 100) {
        throw err("INVALID_INPUT", "渲染 HTML 过短,疑似空内容");
      }
      // 签名 URL 还原为 imgs/ 相对路径(publish --html-file 的 [4] replace 依赖相对引用)
      const { markdown: html } = restoreImageRefs(body.html);
      const out = path.join(dir, "layout.html");
      atomicWrite(out, html);
      return { file: out, size: Buffer.byteLength(html, "utf8") };
    },
  });

  // ---------- 签名图片(免 Bearer;HMAC + 有效期 + imgs 白名单三重校验) ----------
  app.get("/gzh-img", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const { d, f, e, s } = q;
    if (!d || !f || !e || !s) {
      return reply.code(403).send({ code: "FORBIDDEN", message: "缺少签名参数" });
    }
    const exp = Number(e);
    if (!Number.isFinite(exp) || exp < Date.now()) {
      return reply.code(403).send({ code: "FORBIDDEN", message: "签名已过期" });
    }
    const mac = crypto.createHmac("sha256", deps.imgSecret).update(`${d}\n${f}\n${e}`).digest("hex");
    if (mac.length !== s.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(s))) {
      return reply.code(403).send({ code: "FORBIDDEN", message: "签名不匹配" });
    }
    let dir: string;
    try {
      dir = resolveInside(vaultRoot, d);
    } catch {
      return reply.code(403).send({ code: "FORBIDDEN", message: "目录越界" });
    }
    if (f.includes("/") || f.includes("\\") || f.includes("..")) {
      return reply.code(403).send({ code: "FORBIDDEN", message: "非法文件名" });
    }
    const filePath = path.join(dir, "imgs", f);
    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "图片不存在" });
    }
    const ext = path.extname(f).toLowerCase();
    const mime =
      ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : ext === ".svg" ? "image/svg+xml" : "image/jpeg";
    reply.header("content-type", mime);
    reply.header("cache-control", "private, max-age=3600");
    return reply.send(fs.readFileSync(filePath));
  });
}

/** vault root 解析:GZH_PREVIEW_VAULT_ROOT 环境变量 > .aws-article/config.json(自 cwd 向上找,与 Python 侧一致) */
export function resolveVaultRoot(cwd: string): string | undefined {
  const env = process.env.GZH_PREVIEW_VAULT_ROOT;
  if (env) return path.resolve(env);
  let dir = path.resolve(cwd);
  for (let i = 0; i < 6; i += 1) {
    const cfg = path.join(dir, ".aws-article", "config.json");
    if (fs.existsSync(cfg)) {
      try {
        const vault = (JSON.parse(fs.readFileSync(cfg, "utf8")) as { vault_root?: string }).vault_root;
        if (vault) return path.resolve(vault);
      } catch {
        /* 配置损坏则继续向上找 */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** 图片签名密钥:由 Web token 派生(token 随会话随机,签名自然随会话失效) */
export function deriveImgSecret(token: string): string {
  return crypto.createHash("sha256").update(`${token}:gzh-img`).digest("hex");
}

/** 错误码 → HTTP 状态(gzh 专用补充;供 app.ts 统一映射外的小集合) */
export const GZH_ERROR_STATUS: Record<string, number> = {
  FORBIDDEN_PATH: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_INPUT: 400,
};
