/**
 * RouteStubLlm（WX-MOCK P1）：deterministic 模式的 Stub 路由 LLM。
 *
 * IntentRouter 每条消息都经 LLM 路由（无关键词快路径），确定性回归的正确注入点是
 * RoutingLLM 本身：规则命中即返回预录路由计划（消息→路由→授权→执行全链真实，
 * 仅路由决策被固定）。规则文件由 mock 驱动引擎按场景渲染（支持 {var} 占位符）。
 *
 * 规则格式（--route-stub <file>）：
 *   { "rules": [ { "ifPromptContains": ["子串1", "子串2"], "reply": "<IntentRouter JSON>" } ] }
 * 全部子串命中 → 返回 reply；无命中 → unsupported（confidence 0，服务端拒答）。
 * 命中/未命中都打 stderr 一行（可观测，进 mock-service.log）。
 */
import fs from "node:fs";
import type { RoutingLLM } from "../../dispatch/intent-router.js";

interface RouteStubRule {
  ifPromptContains: string[];
  reply: string;
}

const UNSUPPORTED = JSON.stringify({
  intent: "unsupported",
  action: "refuse",
  reason: "route-stub 无命中规则",
  confidence: 0,
});

export function createRouteStubLlm(file: string): RoutingLLM {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { rules?: RouteStubRule[] };
  const rules = parsed.rules ?? [];
  return {
    route: async (prompt) => {
      for (const rule of rules) {
        if (rule.ifPromptContains.every((s) => prompt.includes(s))) {
          process.stderr.write(`[route-stub] 命中规则: ${rule.ifPromptContains.join(" & ")}\n`);
          return { text: rule.reply, latencyMs: 0, tokens: 0 };
        }
      }
      process.stderr.write("[route-stub] 无命中规则 → unsupported\n");
      return { text: UNSUPPORTED, latencyMs: 0, tokens: 0 };
    },
  };
}
