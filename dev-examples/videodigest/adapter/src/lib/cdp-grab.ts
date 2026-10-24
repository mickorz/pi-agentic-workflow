import fs from 'node:fs';
import path from 'node:path';
import { CliError, runSyncArgs } from './proc.js';
import { cdpLaunch, cdpOpenTabId } from './cookies.js';
import { netscapeToCookieHeader } from './douyin.js';
import type { VideoMetadata } from './types.js';

/**
 * CDP 方案 B 音频抓取（P0 实证生产通道：yt-dlp 对抖音 a_bogus 风控 0/3 全 403）。
 * 流程：cdp-cli new 视频页 → eval video.play() → performance 资源里抓签名 CDN 音频 URL
 * → 带 Referer/UA/cookie 下载 m4a → ffmpeg 转 16kHz 单声道 wav。
 */

/** 与真实 Chrome 一致的 UA（CDN 签名 URL 校验 Referer + UA） */
export const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

/** 页内抓取脚本（与 dev-examples/videodigest/scripts/vd-cdp-grab.py 保持一致） */
const GRAB_JS =
  "(() => { const urls = performance.getEntriesByType('resource').map(e => e.name);"
  + " const au = urls.filter(u => u.includes('media-audio')).pop() || '';"

  + " const vi = urls.filter(u => u.includes('media-video')).pop() || '';"
  + " const v = document.querySelector('video');"
  + " const authorEl = document.querySelector('[data-e2e=\"video-author-name\"]') || null;"
  + ' return JSON.stringify({au, vi, dur: v ? Math.round(v.duration) : null,'
  + " title: document.title.split(' - 抖音')[0],"
  + ' author: authorEl ? authorEl.textContent.trim().slice(0, 50) : \'\' }); })()';

// douyin 页面资源数很快打满 performance 默认 250 条缓冲，后到的 media 资源会被丢弃（实测 total=250 恒满）——
// 尽早扩容，否则 media-audio 记录是否可见取决于竞态，表现为抓取随机失败
const PLAY_JS =
  "(() => { try { performance.setResourceTimingBufferSize(10000); } catch (e) {}"
  + " const v = document.querySelector('video'); if (v) { v.muted = true; v.play(); } return 'ok'; })()";

export interface CdpMediaInfo {
  audioUrl: string;
  videoUrl: string;
  durationSeconds: number | null;
  title: string;
  author: string;
}

/** 从 performance 资源名列表挑音频轨 URL（最后一条=当前视频）。纯函数供单测。 */
export function pickAudioUrl(names: readonly string[]): string {
  const hits = names.filter((u) => u.includes('media-audio'));
  return hits.length > 0 ? (hits[hits.length - 1] as string) : '';
}

function cdpBaseUrl(port: number): string {
  return `http://localhost:${port}`;
}

/** 执行 cdp-cli eval，解 {success, value} 信封返回 value 字符串 */
function evalJs(cdpPath: string, port: number, pageId: string, js: string): string {
  const r = runSyncArgs(cdpPath, ['--cdp-url', cdpBaseUrl(port), 'eval', pageId, js]);
  if (r.exitCode !== 0) {
    throw new CliError(`cdp-cli eval 失败 退出码 ${r.exitCode}`, 'CDP 抓取', (r.stderr || r.stdout).slice(0, 500));
  }
  const m = r.stdout.match(/\{[\s\S]*\}/);
  if (!m) throw new CliError('cdp-cli eval 未返回 JSON 信封', 'CDP 抓取', r.stdout.slice(0, 500));
  let envelope: { success?: boolean; value?: string; error?: unknown };
  try {
    envelope = JSON.parse(m[0]) as typeof envelope;
  } catch {
    throw new CliError('cdp-cli eval 输出非合法 JSON', 'CDP 抓取', m[0].slice(0, 500));
  }
  if (!envelope.success) throw new CliError('cdp-cli eval 返回失败', 'CDP 抓取', m[0].slice(0, 500));
  return typeof envelope.value === 'string' ? envelope.value : JSON.stringify(envelope.value ?? '');
}

/** 等待指定 target id 在页面列表中可用（新页注册可能延迟，复用 P0 踩坑结论） */
async function waitForPageId(port: number, pageId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${cdpBaseUrl(port)}/json`);
      if (res.ok) {
        const pages = (await res.json()) as Array<{ id: string; type: string }>;
        if (pages.some((p) => p.id === pageId && p.type === 'page')) return pageId;
      }
    } catch {
      // Chrome 短暂无响应，继续轮询
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new CliError(`新开页面（${pageId.slice(0, 8)}…）未在 ${timeoutMs}ms 内可用`, 'CDP 抓取');
}

/** 抓媒体信息：开页 → 等加载 → play → 等资源累计 → eval 抓取（带重试） */
export async function grabMediaViaCdp(opts: {
  cdpPath: string;
  pageUrl: string;
  loadWaitMs?: number;
  playWaitMs?: number;
  attempts?: number;
  logger?: { info?: (m: string) => void };
}): Promise<{ port: number; pageId: string; info: CdpMediaInfo }> {
  const port = await cdpLaunch(opts.cdpPath);
  // 直接使用 cdpOpenTabId 返回的新页 id：按 URL 搜 /json 会命中之前遗留的同 URL 旧页（实测踩坑），
  // 旧页 media 资源已过期/未加载，导致抓取恒失败
  const pageId = await waitForPageId(port, cdpOpenTabId(opts.cdpPath, port, opts.pageUrl), 15000);
  opts.logger?.info?.(`视频页已打开（page=${pageId.slice(0, 8)}…）`);
  // 页面一可用就扩容 resource 缓冲（比首次 play 更早，防早期打满）
  try {
    evalJs(opts.cdpPath, port, pageId, PLAY_JS);
  } catch {
    // 页面尚未可执行 JS，attempt 循环里会再试
  }

  const loadWaitMs = opts.loadWaitMs ?? 5000;
  const playWaitMs = opts.playWaitMs ?? 7000;
  const attempts = opts.attempts ?? 3;

  let lastErr = '';
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, loadWaitMs));
    try {
      evalJs(opts.cdpPath, port, pageId, PLAY_JS);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      continue; // video 元素未就绪，继续等
    }
    await new Promise((r) => setTimeout(r, playWaitMs));
    let raw: string;
    try {
      raw = evalJs(opts.cdpPath, port, pageId, GRAB_JS);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      continue;
    }
    // 页面返回 {au,vi,dur,title,author}(与 vd-cdp-grab.py 线上格式一致),
    // 映射到 CdpMediaInfo{audioUrl,videoUrl,durationSeconds,...} —— 字段名不一致, 必须显式映射
    let wire: { au?: string; vi?: string; dur?: number | null; title?: string; author?: string };
    try {
      wire = JSON.parse(raw) as typeof wire;
    } catch {
      lastErr = `eval 返回非 JSON：${raw.slice(0, 200)}`;
      continue;
    }
    const info: CdpMediaInfo = {
      audioUrl: wire.au || '',
      videoUrl: wire.vi || '',
      durationSeconds: typeof wire.dur === 'number' ? wire.dur : null,
      title: wire.title || '',
      author: wire.author || '',
    };
    if (info.audioUrl) {
      // best-effort 关页（失败不影响结果）
      runSyncArgs(opts.cdpPath, ['--cdp-url', cdpBaseUrl(port), 'close', pageId]);
      return { port, pageId, info };
    }
    lastErr = '未抓到 media-audio 资源（播放未触发或资源未加载）';
  }
  // best-effort 关页
  runSyncArgs(opts.cdpPath, ['--cdp-url', cdpBaseUrl(port), 'close', pageId]);
  throw new CliError(`CDP 抓取音频 URL 失败（${attempts} 次尝试）：${lastErr}`, 'CDP 抓取');
}

/** 下载签名 CDN 音频文件（Referer + Chrome UA + 可选 cookie） */
export async function downloadAudioFile(opts: {
  url: string;
  outPath: string;
  referer: string;
  cookiesFile?: string;
  minBytes?: number;
  logger?: { info?: (m: string) => void };
}): Promise<string> {
  const headers: Record<string, string> = {
    Referer: opts.referer,
    'User-Agent': CHROME_UA,
  };
  if (opts.cookiesFile && fs.existsSync(opts.cookiesFile)) {
    const cookieHeader = netscapeToCookieHeader(fs.readFileSync(opts.cookiesFile, 'utf-8'));
    if (cookieHeader) headers.Cookie = cookieHeader;
  }
  const res = await fetch(opts.url, { headers });
  if (!res.ok) {
    throw new CliError(`音频下载失败 HTTP ${res.status}`, 'CDP 下载', opts.url.slice(0, 200));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const minBytes = opts.minBytes ?? 1024 * 100; // 100KB 下限防截断/错误页
  if (buf.byteLength < minBytes) {
    throw new CliError(
      `音频文件过小（${buf.byteLength}B < ${minBytes}B，疑似签名失效或错误响应）`,
      'CDP 下载',
      opts.url.slice(0, 200),
    );
  }
  fs.writeFileSync(opts.outPath, buf);
  opts.logger?.info?.(`已下载 ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB -> ${path.basename(opts.outPath)}`);
  return opts.outPath;
}

/** ffmpeg 转 16kHz 单声道 wav */
export function ffmpegToWav(ffmpeg: string, input: string, output: string): string {
  const r = runSyncArgs(ffmpeg, ['-y', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', output]);
  if (r.exitCode !== 0 || !fs.existsSync(output)) {
    throw new CliError(`ffmpeg 转码失败 退出码 ${r.exitCode}`, 'CDP 转码', (r.stderr || r.stdout).slice(0, 500));
  }
  return output;
}

/** CDP 通道组装 VideoMetadata（title 来自页面标题，作者不可得则空——不臆测） */
export function cdpInfoToMetadata(info: CdpMediaInfo, canonicalUrl: string): VideoMetadata {
  return {
    title: info.title?.split(' - 抖音')[0]?.trim() || canonicalUrl,
    uploader: info.author || '',
    durationSeconds: info.durationSeconds ?? null,
    webpageUrl: canonicalUrl,
  };
}
