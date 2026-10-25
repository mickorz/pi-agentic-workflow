/**
 * URL 确定性前置路由（设计V2 §3，修订点①；2026-10-24 修订：含链即触发）
 *
 * 原则：URL 检测与平台识别是确定性代码的活，不交给 LLM 猜。
 * 消息中「带有」命中某 workflow 声明域名（含子域）的链接——无论消息里还有多少其它文字、
 * 其它域名的链接、是否带 https:// 前缀——→ 直接产出候选 {workflowId, args:{url}}，
 * 与 IntentRouter 产出同一形态，统一进 RunApplicationService（argsSchema 服务端强校验与授权链路原样生效）。
 *
 * 2026-10-24 语义修订（用户需求：消息里带有 douyin 链接就触发）：
 * - 旧：消息必须恰好含 1 个 URL 且命中声明域名，其它域名链接会拦截整条路由。
 * - 新：按 workflow 维度匹配——其它域名链接不再拦截；无 scheme 裸域名链接（v.douyin.com/xxx）
 *   也识别（归一补 https://）；同一 workflow 命中多条不同链接（选哪条歧义）仍回落。
 *
 * 兜底：无命中 URL / 无 workflow 声明该域名 / 同 workflow 多链接 / 多 workflow 同时命中
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

/** 无 scheme 裸域名链接（如 v.douyin.com/xxx）：host 命中声明域名才收，归一补 https://。
 *  后顾断言排除 scheme 内/token 内的域名（防 evildouyin.com 部分命中）；要求带路径（裸域名提及不触发）。 */
const BARE_HOST_RE = /(?<![\w@./:\-])([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)(\/[^\s<>"'`\u0080-\uffff]*)/g;

export function extractBareUrls(text: string, domains: string[]): string[] {
  if (!text || domains.length === 0) return [];
  const out: string[] = [];
  for (const m of text.matchAll(BARE_HOST_RE)) {
    const host = m[1]!.toLowerCase();
    const pathPart = m[2]!;
    if (!domains.some((d) => hostMatchesDomain(host, d))) continue;
    if (pathPart.replace(TRAILING_NOISE, "").length <= 1) continue; // 仅 "/" 视为无路径提及
    out.push(`https://${host}${pathPart}`.replace(TRAILING_NOISE, ""));
  }
  return out;
}

/**
 * 确定性前置路由（含链即触发）：消息里带有命中声明域名的链接 → hit；
 * 同一 workflow 命中多条不同链接（选哪条歧义）或多个 workflow 同时命中 → null；
 * 未声明域名的其它链接不再拦截（按 workflow 维度各自匹配）。
 */
export function routeByUrlDirect(text: string, registry: UrlRouteRegistry): UrlRouteHit | null {
  const declared = registry.all().filter((r) => Array.isArray(r.urlDomains) && r.urlDomains.length > 0);
  const domains = [...new Set(declared.flatMap((r) => r.urlDomains ?? []))];
  const urls = [...new Set([...extractUrls(text), ...extractBareUrls(text, domains)])];
  if (urls.length === 0) return null;

  const hits: UrlRouteHit[] = [];
  for (const reg of declared) {
    const matched = urls.filter((u) => {
      const host = hostOf(u);
      return host !== null && (reg.urlDomains ?? []).some((d) => hostMatchesDomain(host, d));
    });
    if (matched.length > 1) return null; // 同 workflow 多链接：选哪条有歧义，回落 Agent/人工
    if (matched.length === 1) hits.push({ workflowId: reg.workflowId, argName: reg.urlArg ?? "url", url: matched[0]! });
  }
  if (hits.length !== 1) return null; // 零命中：可能有其他 workflow 未来声明；多命中：歧义不猜
  return hits[0]!;
}
