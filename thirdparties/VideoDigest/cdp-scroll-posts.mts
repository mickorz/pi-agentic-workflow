/**
 * 滚动代理抓取抖音用户作品（被动监听版）：
 * 打开博主主页，模拟用户滚动加载，CDP Network 域被动收集页面自身
 * aweme/post XHR 的响应体（完全真实请求指纹，无自造请求）。
 * 用法: npx tsx cdp-scroll-posts.mts <sec_user_id> <输出json路径>
 */
import fs from 'node:fs';
import path from 'node:path';

const SEC = process.argv[2] ?? '';
const OUT = process.argv[3] ?? '';
const PORT = 9223;
if (!SEC || !OUT) {
  console.error('用法: npx tsx cdp-scroll-posts.mts <sec_user_id> <输出json>');
  process.exit(1);
}

const base = `http://localhost:${PORT}`;

async function openTab(url: string): Promise<{ id: string; webSocketDebuggerUrl: string }> {
  const res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`/json/new HTTP ${res.status}`);
  return (await res.json()) as { id: string; webSocketDebuggerUrl: string };
}

function connect(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const handlers: Array<(m: Record<string, unknown>) => void> = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
    if (msg.id !== undefined && pending.has(msg.id as number)) {
      const h = pending.get(msg.id as number)!;
      pending.delete(msg.id as number);
      (msg as { error?: { message?: string } }).error
        ? h.reject(new Error((msg as { error: { message: string } }).error.message))
        : h.resolve(msg.result);
      return;
    }
    for (const h of handlers) h(msg);
  };
  const ready = new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('WS 连接失败')); });
  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  return { ws, ready, send, onEvent: (h: (m: Record<string, unknown>) => void) => handlers.push(h) };
}

async function main() {
  const probe = await fetch(`${base}/json/version`).then((r) => r.ok).catch(() => false);
  if (!probe) throw new Error(`调试 Chrome 未运行（端口 ${PORT}）`);

  const tab = await openTab(`https://www.douyin.com/user/${SEC}`);
  const c = connect(tab.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable', {});
  await c.send('Network.enable', {});

  // 被动收集：URL 含 aweme/post 的响应体（页面自己发的请求）
  const respBodies = new Map<string, string>(); // requestId -> body
  const postUrls = new Set<string>();
  c.onEvent((m) => {
    const method = m.method as string;
    if (method === 'Network.responseReceived') {
      const r = m.params as { response?: { url?: string }; requestId?: string };
      if (r.response?.url?.includes('/aweme/v1/web/aweme/post/') && r.requestId) {
        postUrls.add(r.requestId);
      }
    }
    if (method === 'Network.loadingFinished' && postUrls.has(m.params as unknown as string)) {
      const p = m.params as { requestId?: string };
      if (p.requestId) postUrls.add(p.requestId); // 已在集合，占位
    }
  });

  // 等首屏加载
  await new Promise((r) => setTimeout(r, 10000));

  // 滚动加载循环：滚一屏 -> 给页面时间发 XHR -> 抓新响应体
  const all = new Map<string, Record<string, unknown>>();
  let author: string | null = null;
  let lastHasMore: unknown = 1;
  let idleRounds = 0;
  for (let round = 0; round < 600; round++) {
    // 取本次新增的响应体
    for (const reqId of [...postUrls]) {
      if (respBodies.has(reqId)) continue;
      try {
        const r = (await c.send('Network.getResponseBody', { requestId: reqId })) as { body?: string; base64Encoded?: boolean };
        const body = r.body ?? '';
        respBodies.set(reqId, body);
        try {
          const j = JSON.parse(body) as {
            aweme_list?: Array<{ aweme_id?: string | number; author?: { nickname?: string } }>;
            has_more?: number;
          };
          for (const a of j.aweme_list ?? []) {
            const key = String(a.aweme_id ?? '');
            if (key && !all.has(key)) {
              all.set(key, a);
              if (!author && a.author?.nickname) author = a.author.nickname;
            }
          }
          lastHasMore = j.has_more;
        } catch { /* 非JSON响应体忽略 */ }
      } catch { /* 响应体已不可取，跳过 */ }
    }
    console.log(`轮次 ${round}: 累计 ${all.size} 条 has_more=${lastHasMore}`);
    if (lastHasMore !== 1 && all.size > 0) break; // 没有更多了
    // 滚动一屏（真实滚动触发加载更多；每5轮回滚一屏再下滚，重新触发无限滚动 sentinel）
    const expr = round % 5 === 4 ? 'window.scrollBy(0, -1600); setTimeout(() => window.scrollBy(0, 3200), 800)' : 'window.scrollBy(0, 1600)';
    await c.send('Runtime.evaluate', { expression: expr });
    await new Promise((r) => setTimeout(r, 2500));
    // 连续 8 轮无新增且请求队列清空 -> 结束
    const prev = all.size;
    if (prev === all.size && postUrls.size === respBodies.size) idleRounds++;
    else idleRounds = 0;
    if (idleRounds >= 8) break;
  }

  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ secUserId: SEC, author, count: all.size, aweme_list: [...all.values()] }, null, 2), 'utf-8');
  console.log(`完成: ${all.size} 条 -> ${OUT} (作者: ${author ?? '未知'})`);
  await fetch(`${base}/json/close/${tab.id}`).catch(() => {});
  c.ws.close();
}

main().catch((e) => { console.error('失败:', e instanceof Error ? e.message : e); process.exit(1); });
