/**
 * pi-workflow wechat start —— wechat-dispatch 长驻装配（WX-P1 T7）
 *
 * 装配链：WechatBotAdapter（LK-01 路径 B）→ MessageInbox 幂等 → Dispatcher（plan/execute）
 *        → RunApplicationService（唯一启动入口）→ Notifier 回执。
 * 前置：WX-P0 真机 SOP 已扫码（credentials.json 存在）。
 * 用法：pi-workflow wechat start --registry dev-examples/wx-p1/registry.json \
 *        --scripts dev-examples/wx-p1 [--allow-user wxid_xxx] [--model <spec>]
 */

import path from "node:path";
import { WorkflowRegistry } from "../../dispatch/registry.js";
import { IntentRouter } from "../../dispatch/intent-router.js";
import { ConversationStore } from "../../dispatch/conversation.js";
import { TaskStore } from "../../dispatch/task-store.js";
import { Dispatcher } from "../../dispatch/dispatcher.js";
import { MessageInbox } from "../../gateway/message-inbox.js";
import { WechatBotAdapter } from "../../gateway/wechat/bot-adapter.js";
import { Notifier } from "../../notify/notifier.js";
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

  const { registry, issues } = WorkflowRegistry.loadFromFile(registryFile);
  if (issues.length > 0) console.warn(`registry 问题条目：${issues.join("; ")}`);
  if (registry.all().length === 0) {
    process.stderr.write(`注册表为空：${registryFile}\n`);
    return 2;
  }

  // 真实路由 LLM（单轮 prompt → JSON）；ModelRouter run 默认模型（LK-02 抽取路径，tier 池由配置注入）
  const adapter = new PiAgentAdapter({ ...(model ? { defaultModel: model } : {}) });
  const llm: RoutingLLM = {
    route: async (prompt) => {
      const started = Date.now();
      const out = await adapter.run(prompt, { label: "intent-router" });
      return { text: out.type === "text" ? out.value : JSON.stringify(out.value), latencyMs: Date.now() - started };
    },
  };

  const service = createRunApplicationService({ baseDir: process.cwd() });
  const router = new IntentRouter({ llm, registry });
  const tasks = new TaskStore(dataDir);
  const conversation = new ConversationStore(dataDir);
  const dispatcher = new Dispatcher({
    registry,
    router,
    tasks,
    service,
    scriptsRoot,
    ...(model ? { defaultModel: model } : {}),
  });
  const inbox = new MessageInbox();
  const bot = new WechatBotAdapter(allowUser ? { allowedUserIds: [allowUser] } : {});
  const notifier = new Notifier(bot);

  bot.onMessage(async (message) => {
    const receipt = inbox.accept(message);
    if (receipt.status === "duplicate") return; // WG-003 幂等
    try {
      const out = await dispatcher.handleMessage(message, conversation);
      await notifier.send(message.userId, out.reply);
      if (out.executeResult) {
        // P2 换 Outbox 异步通知；P1 同步回执即可
        tasks.update(out.executeResult.runId, { status: "running" });
      }
    } catch (error) {
      await notifier.send(message.userId, `❌ 处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  try {
    await bot.start();
  } catch (error) {
    process.stderr.write(`微信启动失败：${error instanceof Error ? error.message : String(error)}\n（先完成真机 SOP：npx tsx dev-examples/wx-m0/standalone-adapter.ts --qr）\n`);
    return 1;
  }
  process.stdout.write(`wechat-dispatch 已启动（registry=${registry.all().length} 个流程，scripts=${scriptsRoot}）\nCtrl-C 退出\n`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      void bot.stop().finally(resolve);
    });
  });
  return 0;
}
