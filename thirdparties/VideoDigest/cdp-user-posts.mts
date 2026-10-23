/**
 * 页面代理抓取抖音用户作品：
 * 复用 vcli 调试 Chrome（9223，固定 profile 带登录态），在页面上下文执行同源 fetch
 * 分页拉取用户作品接口，绕过 curl/undici 的 TLS 指纹与签名风控。
 * 用法: npx tsx cdp-user-posts.mts <sec_user_id> <输出json路径>
 */
import fs from 'node:fs';
import path from 'node:path';

const SEC = process.argv[2] ?? '';
const OUT = process.argv[3] ?? '';
const PORT = 9223;
if (!SEC || !OUT) {
  console.error('用法: npx tsx cdp-user-posts.mts <sec_user_id> <输出json>');
  process.exit(1);
}

const base = `http://localhost:${PORT}`;

interface PageTarget { type: string; url: string; webSocketDebuggerUrl: string }

async function openTab(url: string): Promise<PageTarget> {
  // CDP 新开 tab：PUT /json/new
  const res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`/json/new HTTP ${res.status}`);
  return (await res.json()) as PageTarget;
}

// --- 极简 CDP 客户端 ---
function connect(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; error?: { message?: string }; result?: unknown };
    if (msg.id !== undefined && pending.has(msg.id)) {
      const h = pending.get(msg.id)!;
      pending.delete(msg.id);
      msg.error ? h.reject(new Error(msg.error.message)) : h.resolve(msg.result);
    }
  };
  const ready = new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('WS 连接失败')); });
  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  return { ws, ready, send };
}

async function main() {
  // 0) 探测调试 Chrome
  const probe = await fetch(`${base}/json/version`).then((r) => r.ok).catch(() => false);
  if (!probe) throw new Error(`调试 Chrome 未运行（端口 ${PORT}）。请先运行: vcli download 任意任务或手动启动`);

  // 1) 新开 tab 到博主主页（建立 douyin.com 同源环境）
  const tab = await openTab(`https://www.douyin.com/user/${SEC}`);
  const c = connect(tab.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable', {});
  // 等页面初步加载
  await new Promise((r) => setTimeout(r, 8000));

  // 2) 页面内分页 fetch（同源自动带 cookie；先不带 a_bogus 验证可行性）
  interface PageResult { ok: boolean; body: string; error?: string }
  const fetchPage = async (cursor: number): Promise<PageResult> => {
    const expr = `(async () => {
      try {
        const qs = new URLSearchParams({
          device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1',
          version_code: '290100', version_name: '29.1.0', cookie_enabled: 'true',
          screen_width: '1920', screen_height: '1080', browser_language: 'zh-CN', browser_platform: 'Win32',
          browser_name: 'Chrome', browser_version: '130.0.0.0', browser_online: 'true',
          engine_name: 'Blink', engine_version: '130.0.0.0', os_name: 'Windows', os_version: '10',
          cpu_core_num: '12', device_memory: '8', platform: 'PC', downlink: '10', effective_type: '4g',
          from_user_page: '1', locate_query: 'false', need_time_list: '1', pc_libra_divert: 'Windows',
          publish_video_strategy_type: '2', round_trip_time: '0', show_live_replay_strategy: '1',
          time_list_query: '0', whale_cut_token: '', update_version_code: '170400',
          sec_user_id: ${JSON.stringify(SEC)}, max_cursor: '${cursor}', count: '20',
        });
        const r = await fetch('/aweme/v1/web/aweme/post/?' + qs.toString(), { headers: { accept: 'application/json, text/plain, */*' } });
        return { ok: r.ok, body: await r.text() };
      } catch (e) { return { ok: false, body: '', error: String(e) }; }
    })()`;
    const r = (await c.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    })) as { result?: { value?: PageResult } };
    return r.result?.value ?? { ok: false, body: '', error: 'evaluate 无返回' };
  };

  const fetchPageRetry = async (cursor: number): Promise<PageResult> => {
    let last: PageResult = { ok: false, body: '', error: '未执行' };
    for (let attempt = 1; attempt <= 3; attempt++) {
      last = await fetchPage(cursor);
      if (last.ok && last.body.trim() !== '') return last;
      console.error(`  尝试${attempt}: ok=${last.ok} 响应=${(last.error ?? last.body).slice(0, 80)}`);
      if (attempt < 3) await new Promise((r2) => setTimeout(r2, 30000));
    }
    return last;
  };

  // 3) 循环翻页
  const all: Record<string, unknown>[] = [];
  let author: string | null = null;
  let cursor = 0;
  let hasMore = true;
  let page = 0;
  while (hasMore && page < 100) {
    page++;
    const r = await fetchPageRetry(cursor);
    if (!r.ok) {
      console.error(`第 ${page} 页失败: ${(r.error ?? r.body).slice(0, 100)}`);
      break;
    }
    let j: { aweme_list?: Record<string, unknown>[]; has_more?: number; max_cursor?: number; author?: { nickname?: string }; status_code?: number };
    try {
      j = JSON.parse(r.body);
    } catch {
      console.error(`第 ${page} 页非JSON: ${r.body.slice(0, 100)}`);
      break;
    }
    const list = j.aweme_list ?? [];
    if (!author) {
      const first = list[0] as { author?: { nickname?: string } } | undefined;
      if (first?.author?.nickname) author = first.author.nickname;
    }
    all.push(...list);
    console.log(`第 ${page} 页: +${list.length} 条，累计 ${all.length}，has_more=${j.has_more}`);
    hasMore = j.has_more === 1;
    if (list.length === 0) break;
    cursor = Number(j.max_cursor ?? cursor);
    await new Promise((r2) => setTimeout(r2, 10000)); // 翻页间隔防风控
  }

  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ secUserId: SEC, author, count: all.length, aweme_list: all }, null, 2), 'utf-8');
  console.log(`完成: ${all.length} 条 -> ${OUT} (作者: ${author ?? '未知'})`);
  // 关闭 tab
  await fetch(`${base}/json/close/${tab.id}`).catch(() => {});
  c.ws.close();
}

main().catch((e) => { console.error('失败:', e instanceof Error ? e.message : e); process.exit(1); });
