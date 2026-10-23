import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { runAsync, runSyncArgs, CliError } from '@clibase/core';

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
  /** 写出的 Netscape cookies.txt 路径 */
  cookiesFile: string;
  /** 实际导出的 cookie 条数 */
  count: number;
}


interface LoggerLike {
  info?: (m: string) => void;
  step?: (m: string) => void;
  warn?: (m: string) => void;
}

/**
 * Windows 下 cdp-cli 是 .cmd，而 core 的 run* 不开 shell，直接 spawn .cmd 会失败。
 * 用 cmd /d /s /c 把整条命令行包成一个字符串执行。
 */
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

/** Windows 下定位 chrome.exe（Edge 作为备选，需带远程调试能力的 Chromium 内核） */
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

/** Windows 下自启动带远程调试端口的 Chrome（cdp-cli launch 仅 macOS，Windows 不可用） */
async function launchChromeWindows(port: number): Promise<void> {
  const exe = findChromeExe();
  // 固定 profile：保留登录态，下次启动免扫码（不同平台 cookie 域不冲突，可共用一个 profile）
  const profileDir = path.join(os.homedir(), '.vcli', 'chrome-profile');
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
 *   - 目标端口已有调试 Chrome 在跑：直接复用（不重复启动，也不在批末杀）
 *   - Windows：cdp-cli launch 不可用（仅 macOS），直接启动 chrome.exe 带 --remote-debugging-port
 *   - macOS/Linux：用 cdp-cli launch，从输出 JSON 读 data.port
 */
export async function cdpLaunch(cdpPath: string): Promise<number> {
  const port = DEFAULT_CDP_PORT;
  // 复用已有调试 Chrome，避免重复启动（也不会在批末误杀用户的 Chrome）
  if (await probeCdp(port, 1500)) return port;
  if (process.platform === 'win32') {
    await launchChromeWindows(port);
    return port;
  }
  // macOS/Linux：cdp-cli launch
  const r = runSyncArgs(cdpPath, ['launch', '--minimized']);
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
export async function cdpOpenTab(cdpPath: string, port: number, targetUrl: string): Promise<void> {
  const w = wrap(cdpPath, ['--cdp-url', `http://localhost:${port}`, 'new', targetUrl]);
  const code = await runAsync(w.file, w.args);
  if (code !== 0) throw new CliError(`cdp-cli new 打开站点失败 退出码 ${code}`, '获取 cookie', `target=${targetUrl}`);
}

/** 取页面列表 → 连 webSocketDebuggerUrl → Network.getAllCookies，按域过滤 */
async function getAllCookies(port: number, domainKeyword: string): Promise<CdpCookie[]> {
  const base = `http://localhost:${port}`;
  const res = await fetch(`${base}/json`);
  if (!res.ok) throw new CliError(`无法连接 CDP ${base}/json HTTP ${res.status}`, '获取 cookie');
  const pages = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
  const page =
    pages.find((p) => p.type === 'page' && (!domainKeyword || p.url.includes(domainKeyword))) ??
    pages.find((p) => p.type === 'page');
  if (!page) {
    throw new CliError('未找到可用 CDP page target，请确认已用 cdp-cli new 打开目标站点', '获取 cookie');
  }

  // 用 Node 22+ 全局 WebSocket（无需 ws 包）
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

/** 组装 Netscape cookies.txt：每行 domain SUBDOMAINS path SECURE expires name value（制表符分隔） */
function toNetscape(cookies: CdpCookie[]): string {
  let out = '# Netscape HTTP Cookie File\n# Generated by vcli\n';
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

/**
 * 轮询等待登录态出现：每隔几秒取一次 cookie，检测到登录态立即返回；
 * 超时则返回最后一次取到的 cookie（可能仍无登录态，由调用方决定是否继续）。
 * 用轮询而非等回车，兼容 opencode 等无法交互输入的终端。
 */
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
 *   new 站点首页 -> 等页面加载 -> 检测登录态 ->
 *     已登录：直接导出；未登录：提示扫码并等终端回车确认后重取 -> 写 cookies-<域>.txt
 * 固定 profile 保留登录态，已登录过的平台下次免扫码。
 * 只负责导出，不负责 Chrome 的启动与关闭（生命周期归调用方，批末统一清理），
 * 因此任何失败都只抛 CliError，绝不杀掉复用中的 Chrome。
 */
export async function exportDomainCookies(opts: {
  cdpPath: string;
  /** 已启动调试 Chrome 的 CDP 端口（由调用方 cdpLaunch 获取） */
  port: number;
  /** cookie 落盘目录（批次根目录） */
  outDir: string;
  domainKeyword: string;
  siteUrl: string;
  logger?: LoggerLike;
  /** 登录态 cookie 名：存在且非空视为已登录；空数组/缺省则不判断（直接导出） */
  loginCookieNames?: readonly string[];
  /** 等待扫码登录的超时毫秒，默认 120000（2 分钟） */
  loginTimeoutMs?: number;
}): Promise<DomainCookiesResult> {
  await cdpOpenTab(opts.cdpPath, opts.port, opts.siteUrl);
  await new Promise<void>((r) => setTimeout(r, 6000)); // 等页面加载与访客 cookie
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
      opts.logger?.info?.(`已检测到登录态，继续导出 cookie`);
    } else {
      opts.logger?.warn?.(`超时仍未检测到登录态，使用当前 cookie 继续（下载可能仍失败）`);
    }
  }
  if (cookies.length === 0) {
    throw new CliError(`CDP 未取到 ${opts.domainKeyword} 域的 cookie`, '获取 cookie');
  }
  // 文件名带域关键词，多平台（douyin / xiaohongshu）互不覆盖
  const cookiesFile = path.join(opts.outDir, `cookies-${opts.domainKeyword}.txt`);
  fs.writeFileSync(cookiesFile, toNetscape(cookies), 'utf-8');
  opts.logger?.info?.(`已导出 ${cookies.length} 条 ${opts.domainKeyword} cookie -> ${cookiesFile}`);
  return { cookiesFile, count: cookies.length };
}
