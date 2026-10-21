/**
 * pi-workflow wechat start —— wechat-dispatch 长驻装配（WX-P1 T7 + WX-P2 可靠性）
 *
 * 装配核心见 WechatApp：Inbox 幂等 → 限频 → Dispatcher/TaskControl → RunApplicationService
 *   → Outbox（完成≠送达）→ RunMonitor（审批卡/终态通知）→ AuditLog 全链路审计。
 * 前置：WX-P0 真机 SOP 已扫码（credentials.json 存在）。
 * 用法：pi-workflow wechat start --registry dev-examples/wx-p1/registry.json \
 *        --scripts dev-examples/wx-p1 [--allow-user wxid_xxx]
 *        [--rate-max 20] [--budget-tokens 200000] [--data .pi-wechat]
 *        [--routing-mode legacy|agent]（缺省 legacy；agent = Conversational Agent 模式，AM-P0）
 * WG-007：Ctrl-C 只停 Bot；运行中任务不取消，可 `pi-workflow resume <runId>` 续跑。
 */

import path from "node:path";
import { WorkflowRegistry } from "../../dispatch/registry.js";
import { WechatBotAdapter } from "../../gateway/wechat/bot-adapter.js";
import { WechatApp } from "../../gateway/wechat-app.js";
import { createRunApplicationService } from "../../application/run-service.js";
import { PiAgentAdapter } from "../../adapters/pi/pi-agent-adapter.js";
import type { RoutingLLM } from "../../dispatch/intent-router.js";

export async function wechat(argv: string[]): Promise<number> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const registryFile = flag("--registry") ?? path.join(".pi-wechat", "workflows.json");
  const scriptsRoot = flag("--scripts") ?? path.dirname(path.resolve(registryFile));
  const model = flag("--model");
  const allowUser = flag("--allow-user");
  const dataDir = flag("--data") ?? path.join(".pi-wechat");
  const rateMax = flag("--rate-max") ? Number(flag("--rate-max")) : undefined;
  const budgetTokens = flag("--budget-tokens") ? Number(flag("--budget-tokens")) : undefined;
  const routingModeRaw = flag("--routing-mode");
  const routingMode = routingModeRaw === "agent" ? "agent" : "legacy"; // 缺省 legacy（§2.4 Feature Flag）

  const { registry, issues } = WorkflowRegistry.loadFromFile(registryFile);
  if (issues.length > 0) console.warn(`registry 问题条目：${issues.join("; ")}`);
  if (registry.all().length === 0) {
    process.stderr.write(`注册表为空：${registryFile}\n`);
    return 2;
  }

  // 真实路由 LLM（单轮 prompt → JSON）；模型走默认配置（settings.json），显式 --model 才覆盖
  const adapter = new PiAgentAdapter({ ...(model ? { defaultModel: model } : {}) });
  const llm: RoutingLLM = {
    route: async (prompt) => {
      const started = Date.now();
      let tokens = 0;
      const out = await adapter.run(prompt, {
        label: "intent-router",
        onUsage: (usage) => {
          tokens += usage.total ?? 0;
        },
      });
      return {
        text: out.type === "text" ? out.value : JSON.stringify(out.value),
        latencyMs: Date.now() - started,
        ...(tokens > 0 ? { tokens } : {}),
      };
    },
  };

  const service = createRunApplicationService({ baseDir: process.cwd() });
  const bot = new WechatBotAdapter(
    allowUser ? { allowedUserIds: [allowUser] } : {},
  );
  const app = new WechatApp({
    bot,
    registry,
    llm,
    service,
    scriptsRoot,
    dataDir,
    routingMode,
    ...(model ? { defaultModel: model } : {}),
    limits: {
      ...(rateMax !== undefined && !Number.isNaN(rateMax) ? { rateMax } : {}),
      ...(budgetTokens !== undefined && !Number.isNaN(budgetTokens) ? { maxTokensPerUser: budgetTokens } : {}),
    },
  });

  try {
    await app.start();
  } catch (error) {
    process.stderr.write(`微信启动失败：${error instanceof Error ? error.message : String(error)}\n（先完成真机 SOP：npx tsx dev-examples/wx-m0/standalone-adapter.ts --qr）\n`);
    return 1;
  }
  process.stdout.write(
    [
      `wechat-dispatch 已启动（routing-mode=${routingMode}，registry=${registry.all().length} 个流程，scripts=${scriptsRoot}，data=${dataDir}）`,
      ...(routingMode === "agent"
        ? [
            `agent 模式：Conversational Agent（持久会话+五工具；高风险需「批准」确认；同用户消息排队串行）`,
            `会话目录：${path.resolve(dataDir, "..", ".pi-agent-host", "sessions")}`,
          ]
        : []),
      `任务指令：任务列表 / 进度如何 / 取消任务 / 恢复任务 / 批准 / 拒绝`,
      `Ctrl-C 仅停止 Bot（运行中任务不受影响，可用 pi-workflow resume <runId> 恢复）`,
    ].join("\n") + "\n",
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      void app.stop().finally(resolve);
    });
  });
  return 0;
}
