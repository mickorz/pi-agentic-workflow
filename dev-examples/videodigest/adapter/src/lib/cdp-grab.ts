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
  + " const au = urls.filter(u => u.includes('media-audio') || u.includes('douyinvod')).pop() || '';"

  + " const vi = urls.filter(u => u.includes('media-video') || u.includes('douyinvod')).pop() || '';"
  + " const v = document.querySelector('video');"
  + " const authorEl = document.querySelector(`[data-e2e='video-author-name']`) || null;" // 反引号+单引号：Windows 经 cmd 包装传参，参数内不得含双引号（proc.ts cmdQuote）
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

/**
 * CDP 网络层收集器：监听 Network.requestWillBeSent 抓 media-audio 请求 URL。
 * Windows 实测：抖音页面 Service Worker 会拦截媒体分片请求，被拦请求不进 performance
 * resource timing，也不进 page 会话的 Network 域，必须额外挂 SW target（/json 里
 * type=service_worker 且同域）才能看到，故同时挂 page + SW 会话合并监听。
 */
async function openNetworkCollector(
  port: number,
  pageId: string,
): Promise<{ takeAudioUrl: () => string; takeVideoUrl: () => string; refreshSws: () => Promise<void>; close: () => void }> {
  const res = await fetch(`${cdpBaseUrl(port)}/json`);
  const targets = (await res.json()) as Array<{ id: string; url?: string; type: string; webSocketDebuggerUrl?: string }>;
  const page = targets.find((p) => p.id === pageId);
  if (!page?.webSocketDebuggerUrl) throw new CliError('未找到页面 webSocketDebuggerUrl', 'CDP 抓取');
  const pageUrl = page.url ?? '';
  let audioUrl = '';
  let videoUrl = '';
  const sockets: WebSocket[] = [];
  const attachedUrls = new Set<string>();
  const listen = (ws: WebSocket) => {
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let msg: { method?: string; params?: { request?: { url?: string } } };
      try {
        msg = JSON.parse(raw) as typeof msg;
      } catch {
        return;
      }
      if (msg.method === 'Network.requestWillBeSent') {
        const u = msg.params?.request?.url ?? '';
        if (isBetterAudioUrl(u, audioUrl)) audioUrl = u; // douyinvod 取最低码率 = 当前视频
        if (u.includes('media-video')) videoUrl = u;
      }
    };
    ws.send(JSON.stringify({ id: 1, method: 'Network.enable', params: {} }));
    // 绕过 Service Worker：SW 缓存全命中时媒体请求不过网络（两通道都看不到，抓取随机失败）；
    // bypass 后请求直连网络，page 会话 Network 域与 performance 记录均可见。旧版 Chrome 不支持则静默忽略（响应无 pending 处理器）
    ws.send(JSON.stringify({ id: 2, method: 'Network.setBypassServiceWorker', params: { bypass: true } }));
    sockets.push(ws);
  };
  const attach = async (wsUrl: string, required = false) => {
    if (attachedUrls.has(wsUrl)) return;
    const ws = new WebSocket(wsUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new CliError('CDP WebSocket 连接失败', 'CDP 抓取'));
      });
    } catch (e) {
      if (required) throw e; // page 会话是必需的，失败即败
      return; // best-effort：SW 会话失败降级 performance 通道，refreshSws 下轮重试（idle SW 会被 Chrome 随时回收，连接竞态正常）
    }
    attachedUrls.add(wsUrl); // 成功才登记，失败的下轮可重试
    listen(ws);
  };
  await attach(page.webSocketDebuggerUrl, true);
  await attachSws();
  /** 补挂后出现的同域 SW target（首次访问时 SW 晚于收集器注册，媒体请求会全部漏掉） */
  async function attachSws(): Promise<void> {
    const res2 = await fetch(`${cdpBaseUrl(port)}/json`);
    const now = (await res2.json()) as Array<{ url?: string; type: string; webSocketDebuggerUrl?: string }>;
    for (const t of now) {
      if (t.type === 'service_worker' && t.webSocketDebuggerUrl && t.url && pageUrl && sameOrigin(t.url, pageUrl)) {
        await attach(t.webSocketDebuggerUrl);
      }
    }
  }
  return {
    takeAudioUrl: () => audioUrl,
    takeVideoUrl: () => videoUrl,
    refreshSws: () => attachSws().catch(() => undefined), // 补挂失败不阻断流程
    close: () => {
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {
          // best effort
        }
      }
    },
  };
}

/** 音频流 URL 甄别：legacy media-audio 特征，或新版 douyinvod.com 媒体 URL（取更低码率，更小的音视混合流） */
function isBetterAudioUrl(u: string, current: string): boolean {
  const audioish = u.includes('media-audio') || u.includes('douyinvod.com');
  if (!audioish) return false;
  if (!current) return true;
  const br = (s: string) => Number(/[?&]br=(\d+)/.exec(s)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return br(u) < br(current);
}

/** 判断两个 URL 是否同源（SW 归属判断用） */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** 抓媒体信息：开页 → 等加载 → play → 等资源累计 → eval 抓取。每次 attempt 换新 tab：
 * 抖音风控会间歇性下发降级壳页（title 空、播放器恒 ready=0），坏页上重试无意义，
 * 换新页 = 独立重掷（实测同 tab 三连败、新 tab 即中） */
export async function grabMediaViaCdp(opts: {
  cdpPath: string;
  pageUrl: string;
  loadWaitMs?: number;
  playWaitMs?: number;
  attempts?: number;
  logger?: { info?: (m: string) => void };
}): Promise<{ port: number; pageId: string; info: CdpMediaInfo }> {
  const port = await cdpLaunch(opts.cdpPath);
  const loadWaitMs = opts.loadWaitMs ?? 5000;
  const playWaitMs = opts.playWaitMs ?? 7000;
  const attempts = opts.attempts ?? 3;

  let lastErr = '';
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 4000)); // 风控冷却：连开同视频页易命中降级页
    // 直接使用 cdpOpenTabId 返回的新页 id：按 URL 搜 /json 会命中之前遗留的同 URL 旧页（实测踩坑），
    // 旧页 media 资源已过期/未加载，导致抓取恒失败
    const pageId = await waitForPageId(port, cdpOpenTabId(opts.cdpPath, port, opts.pageUrl), 15000);
    opts.logger?.info?.(`视频页已打开（page=${pageId.slice(0, 8)}…，第 ${i + 1} 次）`);
    // 页面一可用就尽早接网络层收集器：media 请求可能早于 PLAY_JS 触发（预加载）
    const net = await openNetworkCollector(port, pageId);
    try {
      // 页面一可用就扩容 resource 缓冲（比首次 play 更早，防早期打满）
      try {
        evalJs(opts.cdpPath, port, pageId, PLAY_JS);
      } catch {
        // 页面尚未可执行 JS，下面会再试
      }
      await net.refreshSws(); // SW 可能晚于收集器注册（首次访问），补挂
      await new Promise((r) => setTimeout(r, loadWaitMs));
      try {
        evalJs(opts.cdpPath, port, pageId, PLAY_JS);
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        continue; // video 元素未就绪，换新页重试
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
        audioUrl: wire.au || net.takeAudioUrl(), // 优先页内 performance，回落 CDP 网络层（Windows SW 拦截场景）
        videoUrl: wire.vi || net.takeVideoUrl(),
        durationSeconds: typeof wire.dur === 'number' ? wire.dur : null,
        title: wire.title || '',
        author: wire.author || '',
      };
      if (info.audioUrl) {
        return { port, pageId, info };
      }
      lastErr = '未抓到媒体资源（疑似风控降级页：title 空、播放器不初始化）';
    } finally {
      // best-effort 关页与收集器（失败不影响结果）
      net.close();
      runSyncArgs(opts.cdpPath, ['--cdp-url', cdpBaseUrl(port), 'close', pageId]);
    }
  }
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
