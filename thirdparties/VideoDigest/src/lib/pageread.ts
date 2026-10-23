import { CliError } from '@clibase/core';
import { cdpLaunch, cdpOpenTab } from './cookies.js';
import { killDebugChrome } from './cleanup.js';

/** 提取到的图文页面内容 */
export interface PageContent {
  title: string;
  content: string;
  imageUrls: string[];
}

/** 判断两个 URL 的 host 是否相同（比较失败时返回 false 走回退逻辑） */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

/** 注入页面执行的提取脚本：标题 + 正文 + 图片列表（适配小红书与抖音图文笔记） */
const EXTRACT_JS = `JSON.stringify((() => {
  let el = null;
  let scope = document;
  // 抖音图文：以"发布时间"文本为锚点，向上找包含正文的最近容器。
  // 正文与发布时间是兄弟节点：父容器必须同时比时间文本长（即含正文），且不含评论/推荐流。
  const all = Array.from(document.querySelectorAll('div,p,span'));
  const timeEl = all.find(e => e.children.length === 0 && /发布时间[:：]/.test(e.innerText || ''));
  if (timeEl) {
    const timeLen = (timeEl.parentElement?.innerText || '').length;
    let box = timeEl.parentElement;
    for (let i = 0; i < 5 && box; i++) {
      const t = box.innerText || '';
      // 目标容器：比纯发布时间明显更长（正文几十到几百字）、不含评论区特征、不含导航
      if (t.length > timeLen + 20 && t.length < 800 && !/评论\\(|条回复|相关推荐/.test(t)) { el = box; break; }
      box = box.parentElement;
    }
    // 图片取笔记详情区内的（排除侧栏推荐流封面）
    const nd = document.querySelector('[data-e2e="note-detail"]');
    if (nd) {
      const sidebar = nd.querySelector('[class*=noteSideBarContainer]');
      if (sidebar) sidebar.remove();
      scope = nd;
    }
  } else {
    // 小红书图文
    el = document.querySelector('.note-text,#detail-desc,[class*=desc]');
  }
  const content = el ? el.innerText : '';
  return {
    // 标题兜底：SPA 页面 document.title 可能异步更新，为空时取正文首行（截 60 字）
    title: (document.title.replace(/\\s*-\\s*(小红书|抖音)$/, '') || content.split('\\n')[0] || '').slice(0, 60),
    content,
    imageUrls: Array.from(scope.querySelectorAll('img'))
      .map(i => i.src)
      .filter(s => s && s.indexOf('http') === 0
        && s.indexOf('avatar') < 0 && s.indexOf('emoji') < 0 && s.indexOf('.svg') < 0
        && s.indexOf('douyinstatic') < 0 && s.indexOf('image-cut-tos') < 0)
  };
})())`;

/** 连页面 WebSocket 执行 Runtime.evaluate，返回字符串结果 */
async function evalPage(port: number, expression: string, targetUrl?: string): Promise<string> {
  const base = `http://localhost:${port}`;
  const res = await fetch(`${base}/json`);
  if (!res.ok) throw new CliError(`无法连接 CDP ${base}/json HTTP ${res.status}`, '提取内容');
  const pages = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
  // 短链会重定向：目标页 URL 与原链接 host 不同（如 v.douyin.com -> www.douyin.com/note/...）。
  // cdp-cli new 每次开新标签页，多个链接时 /json 里会积累多个候选页；
  // 数组末尾是最新打开的，优先取最新内容页（路径含 /note/ /discovery/ /explore/）。
  const contentPages = pages.filter((p) => p.type === 'page' && /\/(note|discovery|explore)\//.test(p.url));
  const page =
    (targetUrl ? [...contentPages].reverse().find((p) => sameHost(p.url, targetUrl)) : undefined) ??
    contentPages[contentPages.length - 1] ??
    (targetUrl ? [...pages].reverse().find((p) => p.type === 'page' && sameHost(p.url, targetUrl)) : undefined) ??
    [...pages].reverse().find((p) => p.type === 'page') ??
    pages[0];
  if (!page) throw new CliError('未找到可用 CDP page target', '提取内容');

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
    ws.onerror = () => reject(new CliError('CDP WebSocket 连接失败', '提取内容'));
  });
  try {
    const r = (await send('Runtime.evaluate', { expression, returnByValue: true })) as {
      result?: { value?: unknown };
    };
    const value = r?.result?.value;
    if (typeof value !== 'string') throw new CliError('页面提取未返回结果', '提取内容');
    return value;
  } finally {
    ws.close();
  }
}

/**
 * 解析短链的最终 URL（如 v.douyin.com/xxx -> www.douyin.com/note/<id>）。
 * 短链在标签页内跳转依赖页面 JS，后台标签页可能被节流卡在 about:blank，
 * 改为 Node 侧直接跟 HTTP 重定向（302），拿到最终地址再交给浏览器打开。
 * 解析失败时原样返回（回退浏览器跳转路径）。
 */
async function resolveShortLink(url: string): Promise<string> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    // redirect: 'follow' 后 res.url 即最终 URL；未跳转时等于原 URL
    if (res.url && res.url !== 'about:blank' && /^https?:/.test(res.url)) return res.url;
    return url;
  } catch {
    return url;
  }
}

/**
 * 在已启动的调试 Chrome 上打开图文笔记页面并提取 标题/正文/图片列表。
 * 只负责提取，不负责 Chrome 的启动与关闭（生命周期归调用方，批末统一清理）。
 */
export async function extractNoteOnChrome(opts: {
  cdpPath: string;
  port: number;
  url: string;
  waitMs?: number;
}): Promise<PageContent> {
  const finalUrl = await resolveShortLink(opts.url);
  await cdpOpenTab(opts.cdpPath, opts.port, finalUrl);
  await new Promise<void>((r) => setTimeout(r, opts.waitMs ?? 10000));
  const raw = await evalPage(opts.port, EXTRACT_JS, finalUrl);
  let page: PageContent;
  try {
    page = JSON.parse(raw) as PageContent;
  } catch {
    throw new CliError('页面提取结果不是合法 JSON', '提取内容', raw.slice(0, 300));
  }
  if (!page.content || page.content.trim() === '') {
    throw new CliError(
      '未提取到正文（可能是视频笔记、页面未加载完或需要登录），可用 --wait 15000 加长等待后重试',
      '提取内容',
    );
  }
  return page;
}

/**
 * 独立打开图文笔记页面并提取（note 命令专用）：
 * 自行 launch 调试 Chrome，失败时自动清理，成功时返回 chromePort 由调用方清理。
 */
export async function readNotePage(opts: {
  cdpPath: string;
  url: string;
  waitMs?: number;
}): Promise<{ page: PageContent; chromePort: number }> {
  const port = await cdpLaunch(opts.cdpPath);
  try {
    const page = await extractNoteOnChrome({ cdpPath: opts.cdpPath, port, url: opts.url, waitMs: opts.waitMs });
    return { page, chromePort: port };
  } catch (e) {
    killDebugChrome(port);
    const msg = e instanceof Error ? e.message : String(e);
    const step = e instanceof CliError ? (e.step ?? '提取内容') : '提取内容';
    throw new CliError(msg, step, `调试 chrome 端口 ${port}（已清理）`);
  }
}
