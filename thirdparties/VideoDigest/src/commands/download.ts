import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { defineCommand, CliError, ensureDir, runAsync } from '@clibase/core';
import type { DownloadOptions, DownloadResult, LinkFailure, PlatformInfo } from '../lib/types.js';
import { detectPlatform } from '../lib/platform.js';
import { resolveTool, dirOf } from '../lib/tools.js';
import { dumpMetadata } from '../lib/download.js';
import { cdpLaunch, exportDomainCookies } from '../lib/cookies.js';
import { killDebugChrome, removeWorkDir } from '../lib/cleanup.js';

/** 支持的音频格式 */
export const FORMATS = ['wav', 'mp3', 'm4a', 'best'] as const;
type AudioFormat = (typeof FORMATS)[number];

/** 清单表格中提取的一条待下载项 */
export interface ListEntry {
  url: string;
  /** 下载重命名（序号.短名），已清理非法字符 */
  name: string;
  /** 清单中的原始行（用于状态回写定位） */
  rawLine: string;
}

/**
 * 解析 douyin-user 产出的清单 markdown 表格：提取 链接 与 下载重命名 列。
 * 有「下载状态」列时只取非已下载的行；无状态列时全取。
 */
export function parseListMarkdown(content: string): ListEntry[] {
  const lines = content.split(/\r?\n/);
  // 表头列定位（宽容：找不到表头时按 8 列模板的第 6 链接 第 8 重命名）
  let urlIdx = 5;
  let statusIdx = 6;
  let nameIdx = 7;
  const header = lines.find((l) => /^\|.*链接.*\|/.test(l) && /---/.test(String(lines[lines.indexOf(l) + 1] ?? '')));
  if (header) {
    const cols = header.split('|').map((c) => c.trim());
    const find = (kw: string) => cols.findIndex((c) => c.includes(kw));
    if (find('链接') >= 0) urlIdx = find('链接');
    if (find('下载状态') >= 0) statusIdx = find('下载状态');
    if (find('下载重命名') >= 0) nameIdx = find('下载重命名');
  }
  const entries: ListEntry[] = [];
  for (const l of lines) {
    if (!/^\|\s*\d+\s*\|/.test(l)) continue;
    const cols = l.split('|').map((c) => c.trim());
    const url = (cols[urlIdx] ?? '').match(/https?:\/\/\S+/)?.[0];
    if (!url) continue;
    const status = statusIdx >= 0 ? (cols[statusIdx] ?? '') : '';
    if (status.includes('已下载')) continue;
    const name = sanitizeFilename((cols[nameIdx] ?? '').replace(/^\d+\./, '').trim()) || 'video';
    const seq = (cols[1] ?? '').trim() || String(entries.length + 1);
    entries.push({ url, name: `${seq}.${name}`, rawLine: l });
  }
  return entries;
}

/** 把清单中某条目的下载状态改为已下载（按原始行精确匹配替换，返回新内容） */
export function markListDownloaded(content: string, entry: ListEntry): string {
  const cols = entry.rawLine.split('|');
  const statusIdx = cols.findIndex((c, i) => i > 1 && c.trim() === '待下载');
  if (statusIdx < 0) return content;
  cols[statusIdx] = ' 已下载 ';
  return content.replace(entry.rawLine, cols.join('|'));
}

/** 文件名非法字符集：保留中文与空白（空白由 \s+ 统一压缩为单空格） */
const ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x08\x0e-\x1f]/g;

/** 清理文件名非法字符，空标题兜底为 audio */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/\s+/g, ' ').replace(ILLEGAL_CHARS, '_').trim();
  return cleaned || 'audio';
}

/** 扩展名校验：形如 .wav / .m4a / .opus 等 */
function looksLikeExt(ext: string): boolean {
  return ext.length > 0 && /^\.[A-Za-z0-9]{1,5}$/.test(ext);
}

/**
 * 解析 -o 输出意图：
 *   - 不传：outDir=cwd，outName 为空
 *   - 已存在目录 或 以路径分隔符结尾：当作目录
 *   - 单链接且 basename 含扩展名：当作文件名（outDir=dirname）
 *   - 单链接其它：当作目录
 *   - 多链接：一律当作目录
 */
export function resolveOutput(
  output: string | undefined,
  isBatch: boolean,
  cwd: string = process.cwd(),
): { outDir: string; outName?: string } {
  if (!output) return { outDir: cwd };
  const raw = output.trim();
  const endsWithSep = /[\\/]$/.test(raw);
  const abs = path.resolve(cwd, raw);
  let isDir = false;
  try {
    isDir = fs.statSync(abs).isDirectory();
  } catch {
    // 不存在
  }
  if (isDir) return { outDir: abs };
  if (isBatch || endsWithSep) {
    return { outDir: endsWithSep ? abs.replace(/[\\/]+$/, '') : abs };
  }
  // 单链接：basename 含扩展名才当文件名
  const base = path.basename(abs);
  const ext = path.extname(base);
  if (looksLikeExt(ext) && base.length > ext.length) {
    return { outDir: path.dirname(abs), outName: base };
  }
  return { outDir: abs };
}

/**
 * 构造 yt-dlp 输出模板：
 *   - 用户指定文件名且已有扩展名 -> 原样使用
 *   - 用户指定文件名但无扩展名 -> 按格式补（best 用 %(ext)s 占位）
 *   - 未指定文件名 -> 用 sanitize 后的标题 + 扩展名
 */
export function buildOutTemplate(
  outDir: string,
  outName: string | undefined,
  safeTitle: string,
  fmt: AudioFormat,
): string {
  const extPart = fmt === 'best' ? '%(ext)s' : fmt;
  if (outName) {
    const hasExt = looksLikeExt(path.extname(outName));
    const base = hasExt ? outName : `${outName}.${extPart}`;
    return path.join(outDir, base);
  }
  return path.join(outDir, `${safeTitle}.${extPart}`);
}

/**
 * 从输出模板解析实际落盘文件。
 * 模板含 %(ext)s 时：按候选扩展名枚举 + 目录前缀匹配兜底。
 * 模板无占位时：直接取模板路径。
 */
export function resolveActualOutput(template: string, outDir: string, fmt: AudioFormat): string | undefined {
  if (!template.includes('%(ext)s')) {
    return fs.existsSync(template) ? template : undefined;
  }
  const candidates =
    fmt === 'best'
      ? ['webm', 'm4a', 'mp4', 'opus', 'mp3', 'wav', 'ogg', 'aac', 'flac']
      : [fmt];
  for (const ext of candidates) {
    const p = template.replace('%(ext)s', ext);
    if (fs.existsSync(p)) return p;
  }
  // 目录枚举兜底：basename 去掉 .%(ext)s 作为前缀，取最近修改的匹配项
  try {
    const prefix = path.basename(template).replace(/\.%(ext)s$/, '');
    const files = fs
      .readdirSync(outDir)
      .filter((f) => f.startsWith(prefix) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
    if (files.length > 0) {
      files.sort(
        (a, b) =>
          fs.statSync(path.join(outDir, b)).mtimeMs - fs.statSync(path.join(outDir, a)).mtimeMs,
      );
      return path.join(outDir, files[files.length - 1]!);
    }
  } catch {
    // best effort
  }
  return undefined;
}

/**
 * download 命令：视频链接 -> 下载音频文件（保存到磁盘，不删除）
 *
 * 与 digest 的区别：
 *   - digest 下音频只为转录（16kHz 单声道 WAV，用完即删）；
 *   - download 保留可用质量（best 不转码保留原始流；wav/mp3/m4a 用原采样率转码），
 *     文件落盘不删，默认输出当前目录、默认 wav 格式。
 *   - 抖音/小红书自动走 cdp-cli 取 cookie（复用 digest 的批级 Chrome + cookie 缓存）。
 *
 * download 命令流程
 *
 * 解析输入与参数
 *     ├─> 校验 format / urls / --cookies 文件存在
 *     ├─> 解析 yt-dlp ffmpeg best 格式不需要 ffmpeg
 *     └─> resolveOutput 解析 -o 为 outDir 与可选 outName
 *
 * 批级 Chrome 与 cookie 缓存
 *     ├─> ensureChrome 首个需 cookie 平台时启动一次
 *     └─> cookieFileFor 每平台导出一次 cookie 并缓存
 *
 * 逐链接处理
 *     ├─> detectPlatform
 *     ├─> cookieFileFor
 *     ├─> dumpMetadata 拿标题用于文件名
 *     ├─> buildOutTemplate 构造 -o 模板
 *     ├─> runAsync yt-dlp 下载 best 不转码 其他转码
 *     └─> resolveActualOutput 找到实际文件并打印
 *
 * finally 统一清理
 *     ├─> killDebugChrome 杀调试 Chrome
 *     └─> removeWorkDir 删 cookie 临时目录不动用户输出目录
 */
export const downloadCommand = defineCommand({
  name: 'download',
  description: '视频链接 -> 下载音频或视频文件（支持 --from-list 读取清单 markdown 按下载重命名命名）',
  args: { name: 'url', description: '一个或多个视频链接（或用 --from-list 提供清单文件）', variadic: true },
  options: [
    {
      flags: '--format <fmt>',
      description: '音频格式：wav(默认)/mp3/m4a/best(原始流不转码)',
      default: 'wav',
      choices: [...FORMATS],
    },
    { flags: '--from-list <file>', description: '读取清单 markdown（douyin-user 产出），按下载重命名列命名，成功后回写状态为已下载' },
    { flags: '--limit <n>', description: '本批最多处理条数（配合 --from-list 分批下载，断点续传）', default: 0 },
    { flags: '--video', description: '下载视频 MP4（默认下音频；清单模式建议配合使用）' },
    { flags: '-o, --output <path>', description: '输出路径：单链接可指文件名，多链接须为目录（默认当前目录）' },
    { flags: '--ytdlp <path>', description: 'yt-dlp 可执行文件路径（默认 VD_YTDLP 或 PATH）' },
    { flags: '--ffmpeg <path>', description: 'ffmpeg 可执行文件路径（默认 VD_FFMPEG 或 PATH，best 格式不需要）' },
    { flags: '--cdp-cli <path>', description: 'cdp-cli 可执行文件路径（默认 VD_CDP_CLI 或 PATH，仅需 cookie 时解析）' },
    { flags: '--cookies <file>', description: '直接使用现成 Netscape cookies.txt，跳过 cdp-cli 取 cookie' },
    { flags: '--cookie-domain <kw>', description: '覆盖 cookie 域过滤词（高级，通常自动）' },
    { flags: '--login-timeout <sec>', description: '等待扫码登录的超时秒数（默认 120）', default: 120 },
  ],
  action: async (ctx) => {
    const o = ctx.options as DownloadOptions;
    const fmt = String(o.format) as AudioFormat;
    if (!FORMATS.includes(fmt)) {
      throw new CliError(`不支持的格式：${o.format}`, '参数校验', `可选：${FORMATS.join('/')}`);
    }
    const wantVideo = !!o.video;

    // 清单模式：解析 markdown 表格（链接 + 下载重命名 + 状态），与直接 URL 二选一
    let listFile: string | undefined;
    let listEntries: ListEntry[] = [];
    if (o.fromList) {
      listFile = path.resolve(String(o.fromList).trim());
      if (!fs.existsSync(listFile)) throw new CliError(`--from-list 指定的文件不存在：${listFile}`, '参数校验');
      listEntries = parseListMarkdown(fs.readFileSync(listFile, 'utf-8'));
      if (listEntries.length === 0) throw new CliError('清单中没有待下载条目（全部已下载或格式不匹配）', '参数校验');
      const limit = Number(o.limit ?? 0);
      if (limit > 0 && listEntries.length > limit) {
        listEntries = listEntries.slice(0, limit);
      }
      ctx.logger.info(`清单模式：${listEntries.length} 条待下载（跳过已下载${limit > 0 ? `，本批限 ${limit} 条` : ''}）`);
    }
    const urls = [...new Set(ctx.args.map((a) => String(a).trim()).filter(Boolean))];
    if (urls.length === 0 && listEntries.length === 0) {
      throw new CliError('请提供视频链接或 --from-list 清单文件', '参数校验');
    }
    const isBatch = urls.length + listEntries.length > 1;

    // 用户显式 cookies 文件：fail fast，并跳过 cdp-cli 全流程
    let userCookies: string | undefined;
    if (o.cookies) {
      userCookies = path.resolve(String(o.cookies).trim());
      if (!fs.existsSync(userCookies)) {
        throw new CliError(`--cookies 指定的文件不存在：${userCookies}`, '参数校验');
      }
    }

    // 工具解析（cdp-cli 延迟到首个需 cookie 平台时懒解析）；best 音频与视频合并模式不需要转码 ffmpeg 但合并要
    const ytdlp = resolveTool('yt-dlp', { optionPath: o.ytdlp });
    let ffmpegDir = '';
    if (fmt !== 'best' || wantVideo) {
      const ffmpeg = resolveTool('ffmpeg', { optionPath: o.ffmpeg });
      ffmpegDir = dirOf(ffmpeg);
    }

    // 多链接 -o 校验：看起来像文件名时 fail fast（避免把文件名当目录创建）
    if (isBatch && o.output) {
      const rawTrim = String(o.output).trim();
      const endsWithSep = /[\\/]$/.test(rawTrim);
      const abs = path.resolve(rawTrim);
      let isDir = false;
      try {
        isDir = fs.statSync(abs).isDirectory();
      } catch {
        // 不存在
      }
      if (!endsWithSep && !isDir && looksLikeExt(path.extname(abs))) {
        throw new CliError(
          `多链接下载请用 -o 指定目录而非文件名：${o.output}`,
          '参数校验',
          '多链接各自用视频标题命名，输出到同一目录',
        );
      }
    }

    const { outDir: rawOutDir, outName } = resolveOutput(o.output, isBatch);
    // 清单模式按分类子目录保存：视频/ 或 音频/（对齐用户目录规范）；直链模式保持原样
    const outDir = o.fromList ? path.join(rawOutDir, wantVideo ? '视频' : '音频') : rawOutDir;
    ensureDir(outDir);

    // 批次根目录：仅落 cookie 文件，不存音频（音频直接下到用户 outDir）
    const batchDir = path.join(os.tmpdir(), `vcli-download-${crypto.randomUUID()}`);
    ensureDir(batchDir);

    // 批级状态：全批唯一调试 Chrome + 平台 cookie 缓存
    let chromePort = 0;
    let cdpCli: string | undefined;
    const cookieCache = new Map<string, string>();
    const results: DownloadResult[] = [];
    const failures: LinkFailure[] = [];

    const ensureChrome = async (): Promise<number> => {
      if (!chromePort) {
        ctx.logger.step('启动调试 Chrome（本批一次）');
        chromePort = await cdpLaunch(cdpCli ?? resolveTool('cdp-cli', { optionPath: o.cdpCli }));
      }
      return chromePort;
    };

    const cookieFileFor = async (platform: PlatformInfo): Promise<string | undefined> => {
      if (userCookies) return userCookies;
      if (!platform.needsCookie) return undefined;
      const kw = (o.cookieDomain ? String(o.cookieDomain).trim() : '') || platform.domainKeyword;
      const cached = cookieCache.get(kw);
      if (cached) return cached;
      cdpCli = resolveTool('cdp-cli', { optionPath: o.cdpCli });
      const port = await ensureChrome();
      const r = await exportDomainCookies({
        cdpPath: cdpCli,
        port,
        outDir: batchDir,
        domainKeyword: kw,
        siteUrl: platform.siteUrl,
        loginCookieNames: platform.loginCookieNames,
        loginTimeoutMs: Number(o.loginTimeout ?? 120) * 1000,
        logger: ctx.logger,
      });
      cookieCache.set(kw, r.cookiesFile);
      return r.cookiesFile;
    };

    try {
      const totalCount = urls.length + listEntries.length;
      let done = 0;
      const runOne = async (url: string, listName: string | undefined) => {
      done++;
      const tag = totalCount > 1 ? `[${done}/${totalCount}] ` : '';
        const platform = detectPlatform(url);
        ctx.logger.step(
          `${tag}平台识别：${platform.displayName}${platform.needsCookie ? '（需要 cookie，将走 cdp-cli）' : ''}`,
        );

        try {
          // 1) cookie（--cookies / 批内缓存 / 懒启动导出）
          const cookiesFile = await cookieFileFor(platform);

          // 2) 元数据（标题用于文件名）
          ctx.logger.step(`${tag}获取元数据`);
          const metadata = dumpMetadata({ ytdlp, url, cookiesFile });

          // 3) 输出模板：清单模式用重命名列（序号.短名），否则元数据标题
          const safeTitle = sanitizeFilename(metadata.title);
          const baseName = listName ?? (outName && !isBatch ? outName.replace(/\.[^.]+$/, '') : safeTitle);
          const outTemplate = wantVideo
            ? path.join(outDir, `${baseName}.mp4`)
            : listName
              ? path.join(outDir, `${listName}.${fmt === 'best' ? '%(ext)s' : fmt}`)
              : buildOutTemplate(outDir, outName && !isBatch ? outName : undefined, safeTitle, fmt);

          // 4) 下载：视频模式取最佳视频+音频合并 mp4；音频模式 best 不转码，其余转码
          const args: string[] = [];
          if (wantVideo) {
            args.push('-f', 'bv*[height<=1080]+ba/b', '--merge-output-format', 'mp4', '--ffmpeg-location', ffmpegDir);
          } else if (fmt === 'best') {
            args.push('-f', 'bestaudio/best');
          } else {
            args.push('-x', '--audio-format', fmt, '--audio-quality', '0', '--ffmpeg-location', ffmpegDir);
          }
          args.push('-o', outTemplate, '--no-playlist');
          if (cookiesFile) args.push('--cookies', cookiesFile);
          args.push(url);

          ctx.spinner.start(`${tag}下载中（${metadata.title.slice(0, 60)}）...`);
          const code = await runAsync(ytdlp, args);
          if (code !== 0) {
            ctx.spinner.fail(`${tag}下载失败 退出码 ${code}`);
            throw new CliError(`下载失败 退出码 ${code}`, '下载', `格式 ${fmt}，模板 ${outTemplate}`);
          }
          ctx.spinner.succeed(`${tag}下载完成`);

          // 5) 定位实际输出文件（模板含 %(ext)s 时扩展名由 yt-dlp 填充）
          const outputFile = resolveActualOutput(outTemplate, outDir, fmt);
          if (!outputFile || !fs.existsSync(outputFile)) {
            throw new CliError('下载完成后未找到输出文件', '下载', `期望基于 ${outTemplate}`);
          }
          ctx.logger.success(`${tag}已保存 -> ${outputFile}`);
          results.push({ url, platform, metadata, format: wantVideo ? 'mp4' : fmt, outputFile, cookiesUsed: !!cookiesFile });

          // 清单模式：成功后回写状态为已下载（逐条落盘，中断不丢进度）
          if (listName && listFile) {
            const entry = listEntries.find((e) => e.name === listName);
            if (entry) {
              fs.writeFileSync(listFile, markListDownloaded(fs.readFileSync(listFile, 'utf-8'), entry), 'utf-8');
            }
          }
        } catch (e) {
          ctx.spinner.fail(`${tag}处理失败`);
          const ce = e instanceof CliError ? e : new CliError(e instanceof Error ? e.message : String(e), '处理链接');
          ctx.logger.error(`${tag}${ce.step ? `[${ce.step}] ` : ''}${ce.message}`);
          failures.push({ url, error: { message: ce.message, step: ce.step } });
        }
      };

      // 清单条目 + 直接 URL 统一循环（清单条目带命名，直链用标题命名）
      for (const entry of listEntries) await runOne(entry.url, entry.name);
      for (const url of urls) await runOne(url, undefined);

      // 汇总
      if (results.length === 0) {
        const first = failures[0]!.error;
        throw new CliError(
          `${totalCount} 条全部失败`,
          first.step,
          failures.map((f) => `- ${f.url}: ${f.error.message}`).join('\n'),
        );
      }
      const summaryLine =
        failures.length > 0
          ? `批次完成：${results.length}/${totalCount} 条成功，${failures.length} 条失败（见上方各条错误信息）`
          : isBatch
            ? `批次完成：${results.length}/${totalCount} 条`
            : `完成：${results[0]!.metadata.title} -> ${results[0]!.outputFile}`;
      if (failures.length > 0) return { success: true, message: summaryLine };
      return { success: true, message: summaryLine };
    } finally {
      // 清理顺序：先杀 Chrome 再删 cookie 临时目录（不动用户输出目录）
      if (chromePort) killDebugChrome(chromePort);
      removeWorkDir(batchDir);
    }
  },
});
