import type { PlatformInfo, PlatformKind } from './types.js';

/** 各已知平台的识别信息（移植自 Vcli platform.ts，整表保留） */
export const TABLE: Record<Exclude<PlatformKind, 'other'>, PlatformInfo> = {
  bilibili: { kind: 'bilibili', displayName: 'B站', needsCookie: false, domainKeyword: 'bilibili', siteUrl: 'https://www.bilibili.com', loginCookieNames: [] },
  douyin: { kind: 'douyin', displayName: '抖音', needsCookie: true, domainKeyword: 'douyin', siteUrl: 'https://www.douyin.com', loginCookieNames: ['sessionid'] },
  youtube: { kind: 'youtube', displayName: 'YouTube', needsCookie: false, domainKeyword: 'youtube', siteUrl: 'https://www.youtube.com', loginCookieNames: [] },
  xiaohongshu: { kind: 'xiaohongshu', displayName: '小红书', needsCookie: true, domainKeyword: 'xiaohongshu', siteUrl: 'https://www.xiaohongshu.com', loginCookieNames: ['web_session'] },
};

/**
 * 由 URL 识别平台（V1 只保障抖音链路；其余平台识别仅作提示）。
 * 未命中已知平台时返回 other。
 */
export function detectPlatform(url: string): PlatformInfo {
  const u = url.toLowerCase();
  const list = Object.values(TABLE) as PlatformInfo[];
  const hit = list.find(
    (p) =>
      u.includes(p.domainKeyword) ||
      (p.kind === 'bilibili' && u.includes('b23.tv')) ||
      (p.kind === 'xiaohongshu' && u.includes('xhslink')),
  );
  if (hit) return hit;
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = url;
  }
  return { kind: 'other', displayName: '其它', needsCookie: false, domainKeyword: '', siteUrl: origin, loginCookieNames: [] };
}
