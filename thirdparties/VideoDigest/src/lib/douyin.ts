import { CliError } from '@clibase/core';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import abogusPkg from '@moonr/abogus';
import { DOUYIN_PUBLIC_COOKIE } from './douyin-cookie.js';
import type { HybridVideoData } from './types.js';

/**
 * 抖音 Web 端解析：移植自 thirdparties/Douyin_TikTok_Download_API 的 DouyinWebCrawler。
 *
 * 实施结论（2025-09-10，详见 Docs/DouyinTikTok下载API/09_阶段一实施记录.md）：
 * 1. 无 a_bogus 直连存在短暂容忍窗口，随后被风控静默拦截（200 空 body）；
 * 2. 因此固定携带 a_bogus 签名（@moonr/abogus，与 DDA abogus.py 同源算法）；
 * 3. 同 URL 用 Node fetch（undici）返回 200 空 body（TLS 指纹被风控识别），
 *    curl 指纹放行，因此固定走 curl 子进程（VD_CURL 环境变量可覆盖路径）；
 * 4. 公开 Cookie 可能整体过期或被限流，优先用 cdp-cli 导出的登录 Cookie。
 */

/** curl 可执行文件（Windows 系统自带，WSL 自带） */
const CURL = process.env.VD_CURL?.trim() || 'curl';
/** a_bogus 生成函数（CJS 包，default 导入后解构，避开 ESM named import 互操作问题） */
const { generate_a_bogus } = abogusPkg as unknown as { generate_a_bogus: (params: string, ua: string) => string };

/** 固定 UA：与 Cookie 及签名体系绑定，勿修改（DDA config 同源） */
const DOUYIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36';

const DETAIL_ENDPOINT = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';
const USER_POST_ENDPOINT = 'https://www.douyin.com/aweme/v1/web/aweme/post/';

/** 设备参数：DDA BaseRequestModel（crawlers/douyin/web/models.py）的固定值 */
const BASE_PARAMS: Record<string, string> = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  pc_client_type: '1',
  version_code: '290100',
  version_name: '29.1.0',
  cookie_enabled: 'true',
  screen_width: '1920',
  screen_height: '1080',
  browser_language: 'zh-CN',
  browser_platform: 'Win32',
  browser_name: 'Chrome',
  browser_version: '130.0.0.0',
  browser_online: 'true',
  engine_name: 'Blink',
  engine_version: '130.0.0.0',
  os_name: 'Windows',
  os_version: '10',
  cpu_core_num: '12',
  device_memory: '8',
  platform: 'PC',
  downlink: '10',
  effective_type: '4g',
  from_user_page: '1',
  locate_query: 'false',
  need_time_list: '1',
  pc_libra_divert: 'Windows',
  publish_video_strategy_type: '2',
  round_trip_time: '0',
  show_live_replay_strategy: '1',
  time_list_query: '0',
  whale_cut_token: '',
  update_version_code: '170400',
  msToken: '',
};

/** aweme_type 到内容类型的映射（对齐 DDA hybrid_crawler.py url_type_code_dict） */
const AWAEME_TYPE_VIDEO = new Set([0, 4, 51, 55, 58, 61]);
export function awemeTypeKind(code: number | undefined): 'video' | 'image' {
  return code != null && AWAEME_TYPE_VIDEO.has(code) ? 'video' : 'image';
}

/** 从（已重定向的）URL 提取 aweme_id */
export function awemeIdFromUrl(url: string): string | undefined {
  const m =
    url.match(/\/(?:video|note|slides)\/(\d{6,})/) ?? url.match(/[?&]modal_id=(\d{6,})/);
  return m?.[1];
}

/** 从分享文案中提取第一个 URL */
export function firstUrlFromText(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s，。！？、]+/)?.[0];
}

/**
 * 从分享链接或文案提取 aweme_id。
 * v.douyin.com 短链自动跟随重定向（DDA AwemeIdFetcher 同源逻辑）。
 */
export async function getAwemeId(shareText: string): Promise<string> {
  const raw = firstUrlFromText(shareText) ?? shareText.trim();
  if (!raw) throw new CliError('未在输入中找到链接', '抖音解析');
  let url = raw;
  if (url.includes('v.douyin.com')) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      url = res.url;
    } catch (e) {
      throw new CliError(`抖音短链重定向失败：${raw}`, '抖音解析', e instanceof Error ? e.message : String(e));
    }
  }
  const id = awemeIdFromUrl(url);
  if (!id) throw new CliError(`无法从链接提取抖音视频 ID：${url}`, '抖音解析');
  return id;
}

/** 抖音 aweme detail 接口的宽松原始结构（仅声明用到的字段） */
export interface DouyinAwemeDetailPayload {
  aweme_detail: {
    aweme_id?: string | number;
    aweme_type?: number;
    desc?: string;
    create_time?: number;
    author?: { nickname?: string };
    video?: {
      duration?: number; // 毫秒
      play_addr?: { url_list?: string[] };
    };
    images?: Array<{ url_list?: string[] } | null>;
    statistics?: {
      digg_count?: number;
      comment_count?: number;
      share_count?: number;
    };
  } | null;
  status_code?: number;
}

/** 从（已重定向的）URL 提取 sec_user_id（用户主页路径） */
export function secUserIdFromUrl(url: string): string | undefined {
  const m = url.match(/\/user\/([A-Za-z0-9_-]+)/);
  return m?.[1] && m[1] !== 'profile' ? m[1] : undefined;
}

/**
 * 从分享链接或文案提取 sec_user_id（用户主页）。
 * v.douyin.com 短链自动跟随重定向。
 */
export async function getSecUserId(shareText: string): Promise<string> {
  const raw = firstUrlFromText(shareText) ?? shareText.trim();
  if (!raw) throw new CliError('未在输入中找到链接', '抖音解析');
  let url = raw;
  if (url.includes('v.douyin.com')) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      url = res.url;
    } catch (e) {
      throw new CliError(`抖音短链重定向失败：${raw}`, '抖音解析', e instanceof Error ? e.message : String(e));
    }
  }
  const id = secUserIdFromUrl(url);
  if (!id) throw new CliError(`无法从链接提取用户主页 ID：${url}`, '抖音解析');
  return id;
}

/** 用户单页作品接口的宽松原始结构 */
export interface DouyinUserPostPayload {
  aweme_list?: Array<{
    aweme_id?: string | number;
    desc?: string;
    create_time?: number;
    video?: { duration?: number };
    statistics?: { digg_count?: number; comment_count?: number };
    author?: { nickname?: string };
  }> | null;
  has_more?: number | boolean;
  max_cursor?: number;
  status_code?: number;
}

/** 抽象的统一 curl + a_bogus 请求：params 为业务参数，自动叠加设备参数与签名。
 *  响应写临时文件再读：用户作品一页可达 1MB+，spawnSync 默认 stdout buffer 1MB 会爆。 */
function douyinGet(endpoint: string, bizParams: Record<string, string>, cookie?: string): unknown {
  const qs = new URLSearchParams({ ...BASE_PARAMS, ...bizParams });
  const aBogus = generate_a_bogus(qs.toString(), DOUYIN_UA);
  const url = `${endpoint}?${qs.toString()}&a_bogus=${encodeURIComponent(aBogus)}`;
  const tmp = path.join(os.tmpdir(), `vcli-douyin-${process.pid}-${Date.now()}.json`);
  const result = spawnSync(CURL, [
    '-s', '--max-time', '20',
    '-H', `User-Agent: ${DOUYIN_UA}`,
    '-H', 'Accept: application/json, text/plain, */*',
    '-H', 'Referer: https://www.douyin.com/',
    '-H', 'Accept-Language: zh-CN,zh;q=0.8',
    '-H', `Cookie: ${cookie?.trim() || DOUYIN_PUBLIC_COOKIE}`,
    '-o', tmp,
    url,
  ], { encoding: 'utf-8' });
  try {
    if (result.error || result.status !== 0) {
      const detail = result.error ? String(result.error) : `curl 退出码 ${result.status}`;
      throw new CliError(`抖音接口请求失败（${detail}）`, '抖音解析', url.slice(0, 120));
    }
    if (!fs.existsSync(tmp)) {
      throw new CliError('抖音接口无响应体（可能被风控拦截，可稍后重试或改用登录 Cookie）', '抖音解析');
    }
    const body = fs.readFileSync(tmp, 'utf-8');
    try {
      return JSON.parse(body);
    } catch {
      throw new CliError('抖音接口返回的不是有效 JSON（可能被风控拦截，可稍后重试或改用登录 Cookie）', '抖音解析', body.slice(0, 120));
    }
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 临时文件清理失败不影响主流程 */ }
  }
}

/** 拉取单页用户作品（每页默认 20 条，max_cursor 从 0 开始） */
export function fetchUserPostPage(
  secUserId: string,
  cursor = 0,
  count = 20,
  cookie?: string,
): DouyinUserPostPayload {
  return douyinGet(USER_POST_ENDPOINT, {
    sec_user_id: secUserId,
    max_cursor: String(cursor),
    count: String(count),
  }, cookie) as DouyinUserPostPayload;
}

/** 用户作品的归一化条目 */
export interface DouyinUserVideoItem {
  videoId: string;
  title: string;
  publishTime: string | null;
  publishTimestamp: number | null;
  durationSeconds: number | null;
  like: number;
  comment: number;
}

/** 翻页拉取用户全部作品（按发布时间倒序）；空页安全终止，默认最多 100 页防死循环 */
export async function listUserVideos(
  secUserId: string,
  opts?: { cookie?: string; maxPages?: number; onProgress?: (msg: string) => void },
): Promise<{ items: DouyinUserVideoItem[]; author: string | null }> {
  const maxPages = opts?.maxPages ?? 100;
  const items: DouyinUserVideoItem[] = [];
  let author: string | null = null;
  let cursor = 0;
  for (let page = 1; page <= maxPages; page++) {
    const payload = fetchUserPostPage(secUserId, cursor, 20, opts?.cookie);
    const list = payload.aweme_list ?? [];
    for (const a of list) {
      if (!author && a.author?.nickname) author = a.author.nickname;
      items.push({
        videoId: String(a.aweme_id ?? ''),
        title: (a.desc ?? '').trim(),
        publishTime: a.create_time ? formatDouyinTime(a.create_time) : null,
        publishTimestamp: a.create_time ?? null,
        durationSeconds: a.video?.duration ? a.video.duration / 1000 : null,
        like: a.statistics?.digg_count ?? 0,
        comment: a.statistics?.comment_count ?? 0,
      });
    }
    opts?.onProgress?.(`已获取 ${items.length} 条（第 ${page} 页）`);
    const hasMore = payload.has_more === 1 || payload.has_more === true;
    if (!hasMore || list.length === 0) break;
    cursor = Number(payload.max_cursor ?? cursor);
  }
  return { items, author };
}

/** Netscape cookies.txt 转 Cookie 请求头格式（忽略注释与过期项，取 name=value 用分号连接） */
export function netscapeToCookieHeader(netscape: string): string {
  const pairs: string[] = [];
  for (const rawLine of netscape.split(/\r?\n/)) {
    // #HttpOnly_ 前缀行是有效条目（curl 惯例），剥离前缀后按正常行解析
    const t = rawLine.trim().startsWith('#HttpOnly_') ? rawLine.trim().slice('#HttpOnly_'.length) : rawLine.trim();
    if (!t || t.startsWith('#')) continue;
    const cols = t.split('\t');
    // Netscape 格式：domain include_subdomains path secure expiry name value
    if (cols.length < 7) continue;
    const expiry = Number(cols[4]);
    if (Number.isFinite(expiry) && expiry > 0 && expiry * 1000 < Date.now()) continue; // 已过期
    pairs.push(`${cols[5]}=${cols[6]}`);
  }
  return pairs.join('; ');
}

/** cookie 文件体检结果（用前检查是否值得信任） */
export interface DouyinCookieHealth {
  /** 有效期内条目总数 */
  total: number;
  /** 是否含 sessionid（登录态标志） */
  hasSessionId: boolean;
  /** sessionid 条目的 expiry 已过（文件层可判断的硬过期） */
  sessionIdExpired: boolean;
  /** sessionid 的 expiry 秒级时间戳（会话 cookie 为 0，无法静态判过期） */
  sessionIdExpiry: number | null;
}

/** 检查抖音 cookies.txt 的登录态与过期情况（纯函数） */
export function inspectDouyinCookie(netscape: string): DouyinCookieHealth {
  const health: DouyinCookieHealth = { total: 0, hasSessionId: false, sessionIdExpired: false, sessionIdExpiry: null };
  const now = Date.now() / 1000;
  for (const rawLine of netscape.split(/\r?\n/)) {
    const t = rawLine.trim().startsWith('#HttpOnly_') ? rawLine.trim().slice('#HttpOnly_'.length) : rawLine.trim();
    if (!t || t.startsWith('#')) continue;
    const cols = t.split('\t');
    if (cols.length < 7) continue;
    const expiry = Number(cols[4]);
    const expired = Number.isFinite(expiry) && expiry > 0 && expiry < now;
    if (expired) continue; // 已过期条目不计入 total
    health.total++;
    if (cols[5] === 'sessionid' || cols[5] === 'sessionid_ss') {
      health.hasSessionId = true;
      health.sessionIdExpiry = Number.isFinite(expiry) ? expiry : null;
      health.sessionIdExpired = expired;
    }
  }
  return health;
}

/** 抖音秒级时间戳转本地时间字符串 YYYY-MM-DD HH:mm */
export function formatDouyinTime(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** markdown 单元格转义：竖线与换行 */
export function escapeMdCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/[\n\r\t]+/g, ' ').trim();
}

/** 按视觉宽度截断：中文/全角计 1，ASCII 计 0.5，英文词不切断（Transformer全貌、FlashAttention 等不残缺） */
export function clipTitleUnits(text: string, maxWidth = 10): string {
  let width = 0;
  let out = '';
  const tokens = text.match(/[A-Za-z0-9]+|[^\n]/g) ?? [];
  for (const tk of tokens) {
    const w = [...tk].reduce((s, ch) => s + (/^[\u0000-\u00ff]$/.test(ch) ? 0.5 : 1), 0);
    if (width + w > maxWidth) break;
    width += w;
    out += tk;
  }
  return out.trim();
}

/** 标题开头的课程编号（如 085、或 1.1、），容忍【栏目前缀】；正文中的编号不算 */
export function lessonNumber(title: string): number | null {
  const m = title.match(/^(?:【[^】]*】|《[^》]*》)?\s*(\d{1,4}(?:\.\d+)?)[、.]/);
  return m ? Number(m[1]) : null;
}

/**
 * 标题转 10 字内短名（下载重命名用）：
 * 去栏目前缀/课程编号/书名号 -> 取冒号、问号、逗号前主题词 -> 主题太短退化取开头 ->
 * 清理文件名非法字符 -> 按视觉宽度截断（英文词不切）。
 */
export function videoShortName(title: string): string {
  let t = title
    .trim()
    .replace(/^【[^】]*】/, '')
    .replace(/^《[^》]*》/, '')
    .replace(/^\d{1,4}(?:\.\d+)?[、.]\s*/, '')
    .replace(/^\s+/, '');
  let topic = t.split(/[：:？?，,。！!]/)[0] ?? t;
  if (topic.replace(/\s/g, '').length < 2) topic = t; // 主题过短（如单词 KV）退化用全文再截
  topic = topic
    .replace(/[\\/:*?"<>|#]/g, '')
    .replace(/[“”「」『』]/g, '')
    .trim();
  return clipTitleUnits(topic) || '未命名';
}

/** 按课程编号升序排序（无编号的排后面，保持原时间序） */
export function sortByLessonNumber(items: readonly DouyinUserVideoItem[]): DouyinUserVideoItem[] {
  const numbered = items.filter((it) => lessonNumber(it.title) !== null).sort((a, b) => (lessonNumber(a.title) ?? 0) - (lessonNumber(b.title) ?? 0));
  const unnumbered = items.filter((it) => lessonNumber(it.title) === null);
  return [...numbered, ...unnumbered];
}

/**
 * 用户作品列表转 markdown 清单表格（学习顺序模板）：
 * 编号课程在前升序；列含 下载状态（初始待下载）与 下载重命名（序号.10字内短名）。
 */
export function userVideosToMarkdown(
  items: readonly DouyinUserVideoItem[],
  meta: { author: string; secUserId: string },
): string {
  const lines: string[] = [];
  lines.push(`# ${meta.author} 的抖音作品列表`);
  lines.push('');
  lines.push(`- 主页 ID：${meta.secUserId}`);
  lines.push(`- 作品总数：${items.length}（编号课程在前升序，适合从上往下学）`);
  lines.push(`- 导出时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push('');
  lines.push('| # | 标题 | 发布时间 | 点赞 | 时长 | 链接 | 下载状态 | 下载重命名 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  items.forEach((it, i) => {
    const dur = it.durationSeconds != null ? `${Math.round(it.durationSeconds)} 秒` : '-';
    lines.push(
      `| ${i + 1} | ${escapeMdCell(it.title) || '(无文案)'} | ${it.publishTime ?? '-'} | ${it.like} | ${dur} | https://www.douyin.com/video/${it.videoId} | 待下载 | ${i + 1}.${videoShortName(it.title)} |`,
    );
  });
  return lines.join('\n') + '\n';
}

/** 拉取单个抖音作品详情（无签名直连；cookie 缺省用内置公开 Cookie；走 curl 子进程避开 undici TLS 指纹拦截） */
export function fetchDouyinOneVideo(awemeId: string, cookie?: string): DouyinAwemeDetailPayload {
  const data = douyinGet(DETAIL_ENDPOINT, { aweme_id: awemeId }, cookie) as DouyinAwemeDetailPayload;
  if (!data.aweme_detail) {
    const reason = String((data as { filter_detail?: { filter_reason?: string } }).filter_detail?.filter_reason ?? '');
    throw new CliError(
      '抖音接口未返回视频数据（视频可能已删除、设为私密或需要登录 Cookie）',
      '抖音解析',
      reason ? `filter_reason=${reason}` : undefined,
    );
  }
  return data;
}

/** 原始详情转归一化结构（纯函数） */
export function normalizeDouyinVideo(data: DouyinAwemeDetailPayload): HybridVideoData {
  const a = data.aweme_detail!;
  const videoUrl = a.video?.play_addr?.url_list?.[0] ?? '';
  return {
    platform: 'douyin',
    videoId: String(a.aweme_id ?? ''),
    type: awemeTypeKind(a.aweme_type),
    title: (a.desc ?? '').trim(),
    author: a.author?.nickname ?? '',
    publishTime: a.create_time ? new Date(a.create_time * 1000).toISOString() : null,
    durationSeconds: a.video?.duration ? a.video.duration / 1000 : null,
    videoUrls: videoUrl ? [videoUrl] : [],
    imageUrls: (a.images ?? [])
      .map((img) => img?.url_list?.[0])
      .filter((u): u is string => !!u),
    stats: {
      like: a.statistics?.digg_count ?? 0,
      comment: a.statistics?.comment_count ?? 0,
      share: a.statistics?.share_count ?? 0,
    },
  };
}

/** 一步到位：分享链接 -> 归一化结构 */
export async function parseDouyinVideo(shareText: string, cookie?: string): Promise<HybridVideoData> {
  const awemeId = await getAwemeId(shareText);
  const raw = fetchDouyinOneVideo(awemeId, cookie);
  return normalizeDouyinVideo(raw);
}
