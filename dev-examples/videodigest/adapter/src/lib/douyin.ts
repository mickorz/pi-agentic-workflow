import crypto from 'node:crypto';
import { CliError } from './proc.js';

/**
 * 抖音链接确定性解析（移植自 Vcli douyin.ts，仅保留单视频链路所需；
 * fetchUserPostPage/listUserVideos 等用户列表能力依赖 @moonr/abogus 签名，不移植）。
 */

/** 从（已重定向的）URL 提取 aweme_id */
export function awemeIdFromUrl(url: string): string | undefined {
  const m = url.match(/\/(?:video|note|slides)\/(\d{6,})/) ?? url.match(/[?&]modal_id=(\d{6,})/);
  return m?.[1];
}

/** 从分享文案中提取第一个 URL（容忍中文标点结尾） */
export function firstUrlFromText(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s，。！？、]+/)?.[0];
}

/**
 * 从分享链接或文案提取 aweme_id。
 * v.douyin.com 短链自动跟随重定向（fetch redirect:'follow'，Vcli 同源逻辑）。
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

/** 短链跟随 302 后的规范化 URL（非短链原样返回） */
export async function canonicalizeUrl(shareText: string): Promise<string> {
  const raw = firstUrlFromText(shareText) ?? shareText.trim();
  if (!raw) throw new CliError('未在输入中找到链接', '抖音解析');
  if (raw.includes('v.douyin.com')) {
    try {
      const res = await fetch(raw, { redirect: 'follow' });
      return res.url;
    } catch (e) {
      throw new CliError(`抖音短链重定向失败：${raw}`, '抖音解析', e instanceof Error ? e.message : String(e));
    }
  }
  return raw;
}

/**
 * 幂等键（V2 设计 §4）：抖音 = douyin:<videoId>；
 * 其它平台 = other:<规范化 URL 的 sha1 前 16 位>（确定性，URL 稳定则键稳定）。
 */
export function sourceKeyFor(platform: string, videoId: string | null, canonicalUrl: string): string {
  if (videoId) return `${platform}:${videoId}`;
  const h = crypto.createHash('sha1').update(canonicalUrl).digest('hex').slice(0, 16);
  return `other:${h}`;
}

/** Netscape cookies.txt 转 Cookie 请求头格式（忽略注释与过期项） */
export function netscapeToCookieHeader(netscape: string): string {
  const pairs: string[] = [];
  for (const rawLine of netscape.split(/\r?\n/)) {
    const t = rawLine.trim().startsWith('#HttpOnly_') ? rawLine.trim().slice('#HttpOnly_'.length) : rawLine.trim();
    if (!t || t.startsWith('#')) continue;
    const cols = t.split('\t');
    if (cols.length < 7) continue;
    const expiry = Number(cols[4]);
    if (Number.isFinite(expiry) && expiry > 0 && expiry * 1000 < Date.now()) continue;
    pairs.push(`${cols[5]}=${cols[6]}`);
  }
  return pairs.join('; ');
}

/** cookie 文件体检结果 */
export interface DouyinCookieHealth {
  total: number;
  hasSessionId: boolean;
  sessionIdExpired: boolean;
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
    // 先记 sessionid 状态再跳过过期条目（原 Vcli 实现先 continue 导致 sessionIdExpired 恒 false，属潜在 bug，此处修正）
    if (cols[5] === 'sessionid' || cols[5] === 'sessionid_ss') {
      health.hasSessionId = true;
      health.sessionIdExpiry = Number.isFinite(expiry) ? expiry : null;
      health.sessionIdExpired = expired;
    }
    if (expired) continue; // 已过期条目不计入 total
    health.total++;
  }
  return health;
}
