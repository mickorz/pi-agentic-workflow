#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { CliError } from './lib/proc.js';
import { detectPlatform } from './lib/platform.js';
import { awemeIdFromUrl, canonicalizeUrl, firstUrlFromText, inspectDouyinCookie, sourceKeyFor } from './lib/douyin.js';
import { dumpMetadata, fetchAudio } from './lib/download.js';
import { resolveTool } from './lib/tools.js';
import { cdpLaunch, exportDomainCookies, hasOwnedChrome, ownedChromePorts } from './lib/cookies.js';
import { cdpInfoToMetadata, downloadAudioFile, ffmpegToWav, grabMediaViaCdp } from './lib/cdp-grab.js';
import { resolveDashscopeApiKey } from './lib/bailian.js';
import { transcribeAudio } from './lib/transcribe.js';
import { killDebugChrome } from './lib/cleanup.js';
import type { ExtractFailure, ExtractResult, ResolveResult, StepTimings, VideoMetadata } from './lib/types.js';

/**
 * video-extract-adapter CLI（V2 设计 §5.2 契约）：
 *   cli.js resolve --url <u>            → { ok, platform, videoId, sourceKey, canonicalUrl }
 *   cli.js extract --url <u> [--workdir <dir>] [--cookies <file>] …
 *                                       → { ok, sourceKey, metadata, transcriptPath, timings, … }
 * stdout 只输出单个 JSON 对象（exit 0 成功 / 1 失败）；进度日志走 stderr。
 */

const USAGE = `用法：
  cli.js resolve --url <分享链接或文案>
  cli.js extract --url <分享链接或文案> [选项]
选项：
  --workdir <dir>       工作目录（默认 ./work/<sourceKey>；中间产物与 cookie 缓存落于此）
  --cookies <file>      直接使用 Netscape cookies.txt，跳过 cdp-cli 取 cookie
  --ytdlp <path>        yt-dlp 路径（默认 VD_YTDLP 或 PATH）
  --ffmpeg <path>       ffmpeg 路径（默认 VD_FFMPEG 或 PATH）
  --cdp-cli <path>      cdp-cli 路径（默认 VD_CDP_CLI 或 PATH）
  --lang <lang>         转写语言提示 zh/en/auto（默认 auto）
  --downloader <mode>   音频获取通道 auto|cdp|ytdlp（默认 auto：douyin 走 CDP 方案B，其它 yt-dlp；P0 实证 yt-dlp 对抖音 403）
  --fresh               忽略本地缓存强制全量重提（默认：同 sourceKey 已有 transcript.json 直接复用，不重复百炼转写）
  --login-timeout <sec> 等待扫码登录超时秒数（默认 120）
  --keep-chrome         结束后不关闭本进程启动的调试 Chrome（便于连续处理多条）`;

function log(msg: string): void {
  process.stderr.write(`[adapter] ${msg}\n`);
}

/** 简单 argv 解析：--flag <value> 与 --bool；剩余第一个非 flag 位置参数视作 --url */
function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string | boolean> } {
  const [cmd, ...rest] = argv;
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    } else if (!('url' in opts)) {
      opts.url = a;
    }
  }
  return { cmd: cmd ?? '', opts };
}

function out(json: unknown, exitCode: number): void {
  // 只设 exitCode 不显式 exit：直接 process.exit 会截断管道 stdout（异步 flush 未完成）
  process.stdout.write(JSON.stringify(json, null, 2) + '\n');
  process.exitCode = exitCode;
}

function fail(e: unknown, url?: string, sourceKey?: string): void {
  const ce = e instanceof CliError ? e : new CliError(e instanceof Error ? e.message : String(e), '处理链接');
  const payload: ExtractFailure = {
    ok: false,
    ...(url ? { url } : {}),
    ...(sourceKey ? { sourceKey } : {}),
    error: {
      message: ce.message,
      ...(ce.step ? { step: ce.step } : {}),
      ...(ce.details ? { details: ce.details } : {}),
    },
  };
  log(`失败 [${ce.step ?? '处理链接'}] ${ce.message}${ce.details ? ` | ${ce.details}` : ''}`);
  out(payload, 1);
}
async function cmdResolve(rawUrl: string): Promise<ResolveResult> {
  const url = firstUrlFromText(rawUrl) ?? rawUrl.trim();
  if (!url) throw new CliError('未在输入中找到链接', '抖音解析');
  const platform = detectPlatform(url);
  const canonicalUrl = await canonicalizeUrl(url);
  const videoId = platform.kind === 'douyin' ? awemeIdFromUrl(canonicalUrl) ?? null : null;
  if (platform.kind === 'douyin' && !videoId) {
    throw new CliError(`抖音链接未包含视频 ID（可能是首页/用户页/图文，V1 仅支持视频）：${canonicalUrl}`, '抖音解析');
  }
  return {
    ok: true,
    platform: platform.kind,
    platformName: platform.displayName,
    videoId,
    sourceKey: sourceKeyFor(platform.kind, videoId, canonicalUrl),
    canonicalUrl,
  };
}

/** cookie 文件决策：--cookies 显式 > workdir 缓存（含登录态体检）> cdp-cli 导出 */
async function ensureCookieFile(opts: {
  needsCookie: boolean;
  domainKeyword: string;
  siteUrl: string;
  loginCookieNames: readonly string[];
  userCookies?: string;
  workdir: string;
  cdpCliPath?: string;
  loginTimeoutSec: number;
}): Promise<{ cookiesFile?: string; via: 'user' | 'cache' | 'cdp' | 'none' }> {
  if (opts.userCookies) {
    const p = path.resolve(opts.userCookies);
    if (!fs.existsSync(p)) throw new CliError(`--cookies 指定的文件不存在：${p}`, '参数校验');
    return { cookiesFile: p, via: 'user' };
  }
  if (!opts.needsCookie) return { via: 'none' };

  // workdir 持久缓存（跨运行复用，对齐 Vcli 批内缓存但更持久）
  const cached = path.join(opts.workdir, `cookies-${opts.domainKeyword}.txt`);
  if (fs.existsSync(cached)) {
    const health = inspectDouyinCookie(fs.readFileSync(cached, 'utf-8'));
    if (health.total > 0 && !health.sessionIdExpired) {
      log(`使用缓存 cookie（${health.total} 条，登录态=${health.hasSessionId}）: ${cached}`);
      return { cookiesFile: cached, via: 'cache' };
    }
    log(`缓存 cookie 已失效（${health.total} 条，sessionid 过期=${health.sessionIdExpired}），重新导出`);
  }

  const cdpPath = resolveTool('cdp-cli', { optionPath: opts.cdpCliPath });
  const port = await cdpLaunch(cdpPath);
  const r = await exportDomainCookies({
    cdpPath,
    port,
    outDir: opts.workdir,
    domainKeyword: opts.domainKeyword,
    siteUrl: opts.siteUrl,
    loginCookieNames: opts.loginCookieNames,
    loginTimeoutMs: opts.loginTimeoutSec * 1000,
    logger: { info: log, step: log, warn: log },
  });
  return { cookiesFile: r.cookiesFile, via: 'cdp' };
}

/** 缓存命中时的元数据回填：metadata.json > 同目录/同级 *-cdp-grab.json（P0 手动产物，自愈写回 metadata.json）> 最小元数据 */
function loadCachedMetadata(workdir: string, canonicalUrl: string): VideoMetadata {
  const mp = path.join(workdir, 'metadata.json');
  if (fs.existsSync(mp)) {
    return JSON.parse(fs.readFileSync(mp, 'utf-8')) as VideoMetadata;
  }
  const grabCandidates = [path.join(workdir, 'cdp-grab.json'), path.join(path.dirname(workdir), path.basename(workdir) + '-cdp-grab.json')];
  for (const g of grabCandidates) {
    if (!fs.existsSync(g)) continue;
    try {
      const info = JSON.parse(fs.readFileSync(g, 'utf-8')) as { title?: string; author?: string; dur?: number | null };
      const meta: VideoMetadata = {
        title: info.title?.split(' - 抖音')[0]?.trim() || canonicalUrl,
        uploader: info.author || '',
        durationSeconds: typeof info.dur === 'number' && info.dur > 0 ? info.dur : null,
        webpageUrl: canonicalUrl,
      };
      fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n', 'utf-8'); // 自愈：下次直接读 metadata.json
      return meta;
    } catch {
      // 非法 json，试下一个
    }
  }
  return { title: canonicalUrl, uploader: '', durationSeconds: null, webpageUrl: canonicalUrl };
}

/** extract：resolve → 缓存检查 → cookie → 元数据 → 下载 → 转写（每步计时，增量落盘） */
async function cmdExtract(opts: Record<string, string | boolean>): Promise<ExtractResult> {
  const rawUrl = typeof opts.url === 'string' ? opts.url : '';
  if (!rawUrl) throw new CliError('缺少 --url', '参数校验');
  const totalStart = Date.now();

  // 1) 链接解析
  log(`链接解析：${rawUrl}`);
  const t = Date.now();
  const resolved = await cmdResolve(rawUrl);
  const resolveMs = Date.now() - t;
  log(`平台=${resolved.platformName} sourceKey=${resolved.sourceKey}`);

  const workdir = typeof opts.workdir === 'string' && opts.workdir.trim()
    ? path.resolve(opts.workdir)
    : path.resolve(process.cwd(), 'work', resolved.sourceKey.replace(/[:/]/g, '_'));
  fs.mkdirSync(workdir, { recursive: true });
  log(`工作目录：${workdir}`);

  const platform = detectPlatform(resolved.canonicalUrl);

  // 1.5) 缓存命中：同 sourceKey 已提炼过（transcript.json 存在）→ 直接复用，不重复下载/百炼转写（用户要求：开发阶段复用已提炼产物，省 API 费用）
  const transcriptCache = path.join(workdir, 'transcript.json');
  if (!opts.fresh && fs.existsSync(transcriptCache)) {
    log('缓存命中：transcript.json 已存在，跳过下载与百炼转写（--fresh 可强制全量重提）');
    const segments = JSON.parse(fs.readFileSync(transcriptCache, 'utf-8')) as Array<{ text?: string }>;
    const cachedText = segments.map((sg) => sg.text ?? '').join('');
    const cachedMetadata = loadCachedMetadata(workdir, resolved.canonicalUrl);
    const cachedAudio = fs.existsSync(path.join(workdir, 'audio.wav')) ? path.join(workdir, 'audio.wav') : '';
    const cachedResult: ExtractResult = {
      ok: true,
      sourceKey: resolved.sourceKey,
      platform: resolved.platform,
      url: resolved.canonicalUrl,
      metadata: cachedMetadata,
      transcriptPath: transcriptCache,
      transcriptText: cachedText,
      audioPath: cachedAudio,
      cookiesUsed: false,
      cached: true,
      timings: {
        resolveMs,
        cookieMs: 0,
        metadataMs: 0,
        downloadMs: 0,
        transcribeMs: 0,
        totalMs: Date.now() - totalStart,
      },
    };
    fs.writeFileSync(path.join(workdir, 'extract.json'), JSON.stringify(cachedResult, null, 2) + '\n', 'utf-8');
    return cachedResult;
  }

  let chromeToKill: number[] = [];
  try {
    // 2) cookie —— 惰性获取：CDP 通道（douyin 生产通道）签名 URL + Referer 即可下载，无需 cookie；
    // 仅 yt-dlp 通道（其它平台 / 回落）才导出，避免每次提取都多开一个 cookie tab
    const tC = Date.now();
    const ytdlp = resolveTool('yt-dlp', { optionPath: typeof opts.ytdlp === 'string' ? opts.ytdlp : undefined });
    const ffmpeg = resolveTool('ffmpeg', { optionPath: typeof opts.ffmpeg === 'string' ? opts.ffmpeg : undefined });
    const cdpCli = resolveTool('cdp-cli', { optionPath: typeof opts['cdp-cli'] === 'string' ? opts['cdp-cli'] : undefined });
    const downloader = typeof opts.downloader === 'string' ? opts.downloader : 'auto';
    if (!['auto', 'cdp', 'ytdlp'].includes(downloader)) {
      throw new CliError(`非法 --downloader ${downloader}（auto|cdp|ytdlp）`, '参数校验');
    }
    const useCdp = downloader === 'cdp' || (downloader === 'auto' && resolved.platform === 'douyin');
    let cookie: Awaited<ReturnType<typeof ensureCookieFile>> | undefined;
    const getCookie = async () => {
      if (!cookie) {
        cookie = await ensureCookieFile({
          needsCookie: platform.needsCookie,
          domainKeyword: platform.domainKeyword,
          siteUrl: platform.siteUrl,
          loginCookieNames: platform.loginCookieNames,
          userCookies: typeof opts.cookies === 'string' ? opts.cookies : undefined,
          workdir,
          cdpCliPath: typeof opts['cdp-cli'] === 'string' ? opts['cdp-cli'] : undefined,
          loginTimeoutSec: Number(opts['login-timeout'] ?? 120),
        });
        log(`cookie 通道：${cookie.via}${cookie.cookiesFile ? `（${cookie.cookiesFile}）` : ''}`);
      }
      return cookie;
    };
    const cookieMs = 0; // 惰性后不再单独计量，计入各通道耗时

    let metadata: import('./lib/types.js').VideoMetadata | undefined;
    let audioPath: string | undefined;
    let metadataMs = 0;
    let downloadMs = 0;

    const extractViaYtdlp = async (): Promise<void> => {
      const ck = await getCookie();
      const tM = Date.now();
      log('获取元数据（yt-dlp --dump-single-json）');
      metadata = dumpMetadata({ ytdlp, url: resolved.canonicalUrl, cookiesFile: ck.cookiesFile });
      metadataMs = Date.now() - tM;
      fs.writeFileSync(path.join(workdir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
      if (!metadata.durationSeconds || metadata.durationSeconds <= 0) {
        throw new CliError(
          `未取到视频时长（疑似图文笔记，V1 仅支持视频）：${metadata.title}`,
          '获取元数据',
          resolved.canonicalUrl,
        );
      }
      const tD = Date.now();
      log('下载音频并转码（yt-dlp + ffmpeg，可能耗时）');
      audioPath = await fetchAudio({ ytdlp, ffmpeg, url: resolved.canonicalUrl, workdir, cookiesFile: (await getCookie()).cookiesFile });
      downloadMs = Date.now() - tD;
    };

    const extractViaCdp = async (): Promise<void> => {
      const t0 = Date.now();
      log('CDP 方案 B：打开视频页播放抓取签名音频 URL（P0 实证通道，yt-dlp 对抖音 403）');
      const { info } = await grabMediaViaCdp({
        cdpPath: cdpCli,
        pageUrl: resolved.canonicalUrl,
        logger: { info: log },
      });
      metadata = cdpInfoToMetadata(info, resolved.canonicalUrl);
      metadataMs = Date.now() - t0;
      fs.writeFileSync(path.join(workdir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
      log(`元数据：${metadata.title} / ${metadata.uploader || '佚名'} / ${metadata.durationSeconds ?? '?'}s`);
      if (!metadata.durationSeconds || metadata.durationSeconds <= 0) {
        throw new CliError(
          `未取到视频时长（疑似图文笔记，V1 仅支持视频）：${metadata.title}`,
          '获取元数据',
          resolved.canonicalUrl,
        );
      }
      const tD = Date.now();
      const m4a = path.join(workdir, 'audio.m4a');
      await downloadAudioFile({
        url: info.audioUrl,
        outPath: m4a,
        referer: 'https://www.douyin.com/',
        cookiesFile: cookie?.cookiesFile,
        logger: { info: log },
      });
      audioPath = ffmpegToWav(ffmpeg, m4a, path.join(workdir, 'audio.wav'));
      downloadMs = Date.now() - tD;
    };

    if (useCdp) {
      try {
        await extractViaCdp();
      } catch (e) {
        if (downloader === 'cdp') throw e;
        const msg = e instanceof Error ? e.message : String(e);
        log(`CDP 通道失败，回落 yt-dlp：${msg}`);
        await extractViaYtdlp();
      }
    } else {
      await extractViaYtdlp();
    }
    const finalMetadata = metadata as import('./lib/types.js').VideoMetadata;
    const finalAudioPath = audioPath as string;
    log(`元数据与音频就绪：${finalMetadata.title}`);

    // 5) 百炼转写
    const apiKey = resolveDashscopeApiKey();
    if (!apiKey) {
      throw new CliError(
        '未找到 DASHSCOPE_API_KEY',
        '百炼转写',
        '请设置环境变量 DASHSCOPE_API_KEY，或创建 ~/.config/oil-subtitle/dashscope_api_key',
      );
    }
    const lang = typeof opts.lang === 'string' ? opts.lang : 'auto';
    const tT = Date.now();
    log(`百炼转写中（lang=${lang}，轮询上限 30 分钟）`);
    const transcript = await transcribeAudio({
      audioPath: finalAudioPath,
      workdir,
      lang,
      apiKey,
      onProgress: log,
    });
    const transcribeMs = Date.now() - tT;
    log(`转写完成：${transcript.text.length} 字，${transcript.segments.length} 段`);

    const timings: StepTimings = {
      resolveMs,
      cookieMs,
      metadataMs,
      downloadMs,
      transcribeMs,
      totalMs: Date.now() - totalStart,
    };
    const result: ExtractResult = {
      ok: true,
      sourceKey: resolved.sourceKey,
      platform: resolved.platform,
      url: resolved.canonicalUrl,
      metadata: finalMetadata,
      transcriptPath: path.join(workdir, 'transcript.json'),
      transcriptText: transcript.text,
      audioPath: finalAudioPath,
      cookiesUsed: cookie?.cookiesFile !== undefined,
      timings,
    };
    fs.writeFileSync(path.join(workdir, 'extract.json'), JSON.stringify(result, null, 2) + '\n', 'utf-8');
    return result;
  } finally {
    // 只清理本进程启动的调试 Chrome（复用中的不杀）；--keep-chrome 跳过
    if (!opts['keep-chrome'] && hasOwnedChrome()) {
      chromeToKill = ownedChromePorts();
      for (const p of chromeToKill) killDebugChrome(p);
    }
  }
}

async function main(): Promise<void> {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (opts.help || (cmd !== 'resolve' && cmd !== 'extract')) {
    process.stderr.write(USAGE + '\n');
    process.exitCode = cmd === 'resolve' || cmd === 'extract' ? 0 : 1;
    return;
  }
  const rawUrl = typeof opts.url === 'string' ? opts.url : '';
  if (cmd === 'resolve') {
    try {
      out(await cmdResolve(rawUrl), 0);
    } catch (e) {
      fail(e, rawUrl);
    }
    return;
  }
  try {
    out(await cmdExtract(opts), 0);
  } catch (e) {
    fail(e, rawUrl);
  }
}

main().catch((e) => fail(e));
