import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { runAsync, runSyncArgs, CliError } from './proc.js';

/**
 * cdp-cli 调试 Chrome cookie 导出（移植自 Vcli cookies.ts，整文件保留：
 * cdpLaunch 复用探测 / Windows chrome.exe 自启动 / Network.getAllCookies 按域过滤 /
 * 登录态轮询等待（非交互终端兼容）/ Netscape cookies.txt 组装）。
 */

/** CDP Network.getAllCookies 返回的单条 cookie 结构 */
interface CdpCookie {
  domain: string;
  path?: string;
  secure?: boolean;
  expires?: number;
  name: string;
  value: string;
}

/** 单平台 cookie 导出结果 */
export interface DomainCookiesResult {
  cookiesFile: string;
  count: number;
}

interface LoggerLike {
  info?: (m: string) => void;
  step?: (m: string) => void;
  warn?: (m: string) => void;
}

/** Windows 下 cdp-cli 是 .cmd，直接 spawn 会失败，用 cmd /d /s /c 包装 */
function wrap(file: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'cmd', args: ['/d', '/s', '/c', [file, ...args].join(' ')] };
  }
  return { file, args };
}

/** 默认 CDP 端口（与 cdp-cli 默认一致） */
const DEFAULT_CDP_PORT = 9223;

/** 本进程自己启动的调试 Chrome 端口（复用已有 Chrome 不入集合，杀进程只杀自己启的） */
const ownedPorts = new Set<number>();

/** 探测 CDP /json/version 是否就绪 */
async function probeCdp(port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://localhost:${port}/json/version`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** 轮询等待 CDP 就绪，最多 waitMs 毫秒 */
async function waitForCdp(port: number, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await probeCdp(port, 1500)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Windows 下定位 chrome.exe（Edge 备选） */
function findChromeExe(): string {
  const env = process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean) as string[];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new CliError(
    '未找到 Chrome 可执行文件',
    '获取 cookie',
    '请设置环境变量 CHROME_PATH 指向 chrome.exe（或 msedge.exe）',
  );
}

/** Windows 下自启动带远程调试端口的 Chrome（固定 profile 保留登录态） */
async function launchChromeWindows(port: number): Promise<void> {
  const exe = findChromeExe();
  const profileDir = path.join(os.homedir(), '.videodigest-adapter', 'chrome-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,ChromeWhatsNewUI',
    '--start-minimized',
  ];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  const ok = await waitForCdp(port, 30000);
  if (!ok) {
    try {
      child.kill();
    } catch {
      // best effort
    }
    throw new CliError(
      `调试 Chrome 启动超时（端口 ${port} 未就绪）`,
      '获取 cookie',
      '检查 Chrome 是否可正常启动或端口被占用',
    );
  }
  ownedPorts.add(port);
}

/**
 * 启动调试 Chrome 并返回 CDP 端口：
 *   - 目标端口已有调试 Chrome 在跑：直接复用
 *   - Windows：自启动 chrome.exe；macOS/Linux：cdp-cli launch（输出 JSON 读 data.port）
 */
export async function cdpLaunch(cdpPath: string): Promise<number> {
  const port = DEFAULT_CDP_PORT;
  if (await probeCdp(port, 1500)) return port;
  if (process.platform === 'win32') {
    await launchChromeWindows(port);
    return port;
  }
  const r = runSyncArgs(cdpPath, ['launch']);
  if (r.exitCode !== 0) {
    throw new CliError(`cdp-cli launch 失败 退出码 ${r.exitCode}`, '获取 cookie', (r.stderr || r.stdout).slice(0, 500));
  }
  const m = r.stdout.match(/\{[\s\S]*\}/);
  if (!m) throw new CliError('cdp-cli launch 未返回端口 JSON', '获取 cookie', r.stdout.slice(0, 500));
  let obj: { data?: { port?: number } };
  try {
    obj = JSON.parse(m[0]) as { data?: { port?: number } };
  } catch {
    throw new CliError('cdp-cli launch 输出非合法 JSON', '获取 cookie', m[0].slice(0, 500));
  }
  const launchPort = obj.data?.port;
  if (!launchPort) throw new CliError('cdp-cli launch 输出缺少 data.port', '获取 cookie');
  await waitForCdp(launchPort, 15000);
  ownedPorts.add(launchPort);
  return launchPort;
}

/** 在调试 Chrome 打开站点首页，让浏览器生成访客 cookie */
/** 打开新页并返回该页的 target id（防遗留同 URL 旧页被误选中） */
export function cdpOpenTabId(cdpPath: string, port: number, targetUrl: string): string {
  const r = runSyncArgs(cdpPath, ['--cdp-url', `http://localhost:${port}`, 'new', targetUrl]);
  if (r.exitCode !== 0) {
    throw new CliError(`cdp-cli new 打开站点失败 退出码 ${r.exitCode}`, '获取 cookie', `target=${targetUrl}`);
  }
  const m = r.stdout.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const env = JSON.parse(m[0]) as { success?: boolean; data?: { id?: string } };
      if (env.success && env.data?.id) return env.data.id;
    } catch {
      // 落到下面的报错
    }
  }
  throw new CliError('cdp-cli new 未返回页面 id', '获取 cookie', r.stdout.slice(0, 200));
}

export async function cdpOpenTab(cdpPath: string, port: number, targetUrl: string): Promise<void> {
  const w = wrap(cdpPath, ['--cdp-url', `http://localhost:${port}`, 'new', targetUrl]);
  const code = await runAsync(w.file, w.args);
  if (code !== 0) throw new CliError(`cdp-cli new 打开站点失败 退出码 ${code}`, '获取 cookie', `target=${targetUrl}`);
}

/** 取页面列表 → 连 webSocketDebuggerUrl → Network.getAllCookies，按域过滤 */
/** 拉取 CDP target 列表 */
async function listTargets(
  port: number,
): Promise<Array<{ type: string; url: string; webSocketDebuggerUrl: string }>> {
  const res = await fetch(`http://localhost:${port}/json`);
  if (!res.ok) throw new CliError(`无法连接 CDP http://localhost:${port}/json HTTP ${res.status}`, '获取 cookie');
  return (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
}

/** 页面 target 可能还在启动/被关闭，重试等待可用页面出现（最多 waitMs） */
async function waitForPageTarget(
  port: number,
  domainKeyword: string,
  waitMs: number,
): Promise<{ type: string; url: string; webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + waitMs;
  let lastPages = 0;
  while (Date.now() < deadline) {
    let pages: Array<{ type: string; url: string; webSocketDebuggerUrl: string }> = [];
    try {
      pages = await listTargets(port);
    } catch {
      // Chrome 短暂无响应，继续轮询
    }
    lastPages = pages.length;
    const page =
      pages.find((p) => p.type === 'page' && (!domainKeyword || p.url.includes(domainKeyword))) ??
      pages.find((p) => p.type === 'page');
    if (page) return page;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new CliError(
    `未找到可用 CDP page target（${lastPages} 个 target，请确认已用 cdp-cli new 打开目标站点）`,
    '获取 cookie',
  );
}

async function getAllCookies(port: number, domainKeyword: string): Promise<CdpCookie[]> {
  const page = await waitForPageTarget(port, domainKeyword, 10000);

  // Node 22+ 全局 WebSocket
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();

  ws.onmessage = (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
    const msg = JSON.parse(raw) as { id?: number; error?: { message?: string }; result?: unknown };
    if (msg.id !== undefined && pending.has(msg.id)) {
      const handler = pending.get(msg.id);
      if (handler) {
        pending.delete(msg.id);
        if (msg.error) handler.reject(new Error(msg.error.message ?? 'CDP error'));
        else handler.resolve(msg.result);
      }
    }
  };

  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new CliError('CDP WebSocket 连接失败', '获取 cookie'));
  });

  try {
    await send('Network.enable', {});
    const result = (await send('Network.getAllCookies', {})) as { cookies?: CdpCookie[] };
    const cookies = result.cookies ?? [];
    return domainKeyword ? cookies.filter((c) => c.domain?.includes(domainKeyword)) : cookies;
  } finally {
    ws.close();
  }
}

/** 组装 Netscape cookies.txt */
function toNetscape(cookies: CdpCookie[]): string {
  let out = '# Netscape HTTP Cookie File\n# Generated by video-extract-adapter\n';
  for (const c of cookies) {
    const subdomains = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const exp = typeof c.expires === 'number' && c.expires > 0 ? c.expires : Math.floor(Date.now() / 1000) + 86400;
    out += `${c.domain}\t${subdomains}\t${c.path || '/'}\t${c.secure ? 'TRUE' : 'FALSE'}\t${exp}\t${c.name}\t${c.value}\n`;
  }
  return out;
}

/** 判断 cookie 集是否含登录态（指定名称存在且非空）；无指定名称视为无需登录态 */
function isLoggedIn(cookies: CdpCookie[], names: readonly string[]): boolean {
  if (names.length === 0) return true;
  return cookies.some((c) => names.includes(c.name) && c.value.length > 0);
}

/** 轮询等待登录态出现（每 3 秒取一次；超时返回最后一次结果，由调用方决定） */
async function waitForLogin(opts: {
  port: number;
  domainKeyword: string;
  names: readonly string[];
  timeoutMs: number;
  logger?: LoggerLike;
}): Promise<CdpCookie[]> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastInfo = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    let cookies: CdpCookie[] = [];
    try {
      cookies = await getAllCookies(opts.port, opts.domainKeyword);
    } catch {
      // Chrome 短暂无响应，继续轮询
    }
    if (isLoggedIn(cookies, opts.names)) return cookies;
    if (Date.now() - lastInfo > 15000) {
      const remain = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      opts.logger?.info?.(`仍在等待登录完成，剩余 ${remain} 秒...`);
      lastInfo = Date.now();
    }
  }
  try {
    return await getAllCookies(opts.port, opts.domainKeyword);
  } catch {
    return [];
  }
}

/**
 * 在已启动的调试 Chrome 上导出单个平台的 cookie：
 * new 站点首页 -> 等加载 -> 检测登录态 ->（未登录则等扫码）-> 写 cookies-<域>.txt
 * 只负责导出，不负责 Chrome 生命周期（由调用方批末清理）。
 */
export async function exportDomainCookies(opts: {
  cdpPath: string;
  port: number;
  outDir: string;
  domainKeyword: string;
  siteUrl: string;
  logger?: LoggerLike;
  loginCookieNames?: readonly string[];
  loginTimeoutMs?: number;
}): Promise<DomainCookiesResult> {
  const pageId = cdpOpenTabId(opts.cdpPath, opts.port, opts.siteUrl);
  try {
  await new Promise<void>((r) => setTimeout(r, 6000));
  const names = opts.loginCookieNames ?? [];
  let cookies = await getAllCookies(opts.port, opts.domainKeyword);
  if (!isLoggedIn(cookies, names)) {
    const timeoutMs = opts.loginTimeoutMs ?? 120000;
    const need = names.length > 0 ? `（需登录态 cookie：${names.join(' / ')}）` : '';
    opts.logger?.step?.(
      `未检测到 ${opts.domainKeyword} 登录态${need}，请在 Chrome 窗口扫码登录，${Math.ceil(timeoutMs / 1000)} 秒内完成即可自动继续`,
    );
    cookies = await waitForLogin({
      port: opts.port,
      domainKeyword: opts.domainKeyword,
      names,
      timeoutMs,
      logger: opts.logger,
    });
    if (isLoggedIn(cookies, names)) {
      opts.logger?.info?.('已检测到登录态，继续导出 cookie');
    } else {
      opts.logger?.warn?.('超时仍未检测到登录态，使用当前 cookie 继续（下载可能仍失败）');
    }
  }
  if (cookies.length === 0) {
    throw new CliError(`CDP 未取到 ${opts.domainKeyword} 域的 cookie`, '获取 cookie');
  }
  const cookiesFile = path.join(opts.outDir, `cookies-${opts.domainKeyword}.txt`);
  fs.writeFileSync(cookiesFile, toNetscape(cookies), 'utf-8');
  opts.logger?.info?.(`已导出 ${cookies.length} 条 ${opts.domainKeyword} cookie -> ${cookiesFile}`);
  return { cookiesFile, count: cookies.length };
  } finally {
    // 用完即关：防 cookie 导出 tab 在用户可见的 Chrome 里累积（实测踩坑）
    runSyncArgs(opts.cdpPath, ['--cdp-url', `http://localhost:${opts.port}`, 'close', pageId]);
  }
}

/** 本进程是否启动过调试 Chrome（供调用方决定批末是否清理） */
export function hasOwnedChrome(): boolean {
  return ownedPorts.size > 0;
}

/** 本进程启动过的调试 Chrome 端口列表 */
export function ownedChromePorts(): number[] {
  return [...ownedPorts];
}
