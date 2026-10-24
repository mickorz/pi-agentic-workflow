/**
 * URL 确定性前置路由（设计V2 §3，修订点①）
 *
 * 原则：URL 检测与平台识别是确定性代码的活，不交给 LLM 猜。
 * 消息中「恰好一个」URL 的 host 命中某 workflow 声明的 urlDomains（含子域）
 * → 直接产出候选 {workflowId, args:{url}}，与 IntentRouter 产出同一形态，
 * 统一进 RunApplicationService（argsSchema 服务端强校验与授权链路原样生效）。
 *
 * 兜底：无 URL / 多 URL（>1）/ 无 workflow 声明该域名 / 多 workflow 同时命中
 * → 返回 null，调用方回落 IntentRouter（LLM）或 Agent 通道。
 */

import type { WorkflowRegistration } from "../contracts/wx.js";

/** 设计V2 §3.1：消息文本 URL 抽取正则。
 *  排除空白/包裹符号与全部非 ASCII（中文紧跟 URL 无空格时截断，如「https://x/，还有这个」） */
const URL_RE = /(https?:\/\/[^\s<>"'`\u0080-\uffff]+)/g;

/** URL 尾部需剥离的包裹/标点（中文引号、括号、逗号句号等闭合符号） */
const TRAILING_NOISE = /[）)〉>》」』】\]}",，。！？；：、'’”]+$/;

/** 抽取消息文本中的全部 URL（尾部中文标点剥离） */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[1];
    if (!raw) continue;
    out.push(raw.replace(TRAILING_NOISE, ""));
  }
  return out;
}

/** host 是否命中声明域名：集合精确匹配 + endsWith('.'+domain) 子域规则（防 evildouyin.com 误命中） */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith("." + d);
}

/** 取 URL 的 host（小写）；非法 URL 返回 null */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export interface UrlRouteHit {
  workflowId: string;
  /** 注入参数名（registry 条目 urlArg ?? "url"） */
  argName: string;
  url: string;
}

/** Registry 最小接口（生产=WorkflowRegistry.all()；测试可注入 fake） */
export interface UrlRouteRegistry {
  all(enabledOnly?: boolean): WorkflowRegistration[];
}

/**
 * 确定性前置路由：恰好一个 URL 且恰好一个启用中的 workflow 域名声明命中 → hit；
 * 其余情况（0 个/多个 URL、无命中、多 workflow 同时命中）→ null（回落 LLM/Agent）。
 */
export function routeByUrlDirect(text: string, registry: UrlRouteRegistry): UrlRouteHit | null {
  const urls = extractUrls(text);
  if (urls.length !== 1) return null; // 多 URL 不猜（LLM 兜底/反问），零 URL 无从谈起
  const url = urls[0]!;
  const host = hostOf(url);
  if (!host) return null;

  const hits: UrlRouteHit[] = [];
  for (const reg of registry.all()) {
    if (!Array.isArray(reg.urlDomains) || reg.urlDomains.length === 0) continue;
    const matched = reg.urlDomains.some((d) => hostMatchesDomain(host, d));
    if (matched) hits.push({ workflowId: reg.workflowId, argName: reg.urlArg ?? "url", url });
  }
  if (hits.length !== 1) return null; // 零命中：可能有其他 workflow 未来声明；多命中：歧义不猜
  return hits[0]!;
}
