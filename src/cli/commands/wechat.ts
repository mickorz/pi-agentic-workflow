/**
 * pi-workflow wechat start —— wechat-dispatch 长驻装配（WX-P1 T7 + WX-P2 可靠性）
 *
 * 装配核心见 WechatApp：Inbox 幂等 → 限频 → Dispatcher/TaskControl → RunApplicationService
 *   → Outbox（完成≠送达）→ RunMonitor（审批卡/终态通知）→ AuditLog 全链路审计。
 * 前置：WX-P0 真机 SOP 已扫码（credentials.json 存在）。
 * 用法：pi-workflow wechat login                                    —— 扫码登录/复用已有凭证（免记 wxid）
 *      pi-workflow wechat start --registry dev-examples/am-p0/registry.json \
 *        --scripts dev-examples [--rate-max 20] [--budget-tokens 200000] [--data .pi-wechat]
 *        [--routing-mode legacy|agent]（缺省 legacy；agent = Conversational Agent 模式，AM-P0）
 * 用户绑定（免记 wxid）：--allow-user 指定 > .pi-wechat/bound-user.json 已绑定 > 首条消息发送者自动绑定；
 *        --allow-all 接收所有用户（仅 AM-12 双账号用例，测完务必去掉）
 * WG-007：Ctrl-C 只停 Bot；运行中任务不取消，可 `pi-workflow resume <runId>` 续跑。
 */

import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkflowRegistry } from "../../dispatch/registry.js";
import { WechatBotAdapter } from "../../gateway/wechat/bot-adapter.js";
import { WechatApp } from "../../gateway/wechat-app.js";
import { createRunApplicationService } from "../../application/run-service.js";
import { PiAgentAdapter } from "../../adapters/pi/pi-agent-adapter.js";
import type { RoutingLLM } from "../../dispatch/intent-router.js";
import { wechatLogin } from "./wechat-login.js";

export interface WechatCommandOptions {
  /**
   * thirdparties/pi-wechat-assistant 为纯 TS 源码包（内部 .js 后缀引用只有 tsx 能解析），
   * plain-node（pi-workflow bin）下自动用 tsx 重执行本命令族；已处于 tsx 时直接执行。
   */
  reexecTsx?: boolean;
}

/** 已在 tsx 运行时或重执行环境时返回 true */
function underTsx(): boolean {
  if (process.env.PI_WORKFLOW_TSX === "1") return true;
  return process.execArgv.some((a) => a.includes("tsx"));
}

/** 用 tsx 重执行当前 wechat 命令（交互式 stdio 透传；仓库根需有 node_modules/tsx） */
function reexecUnderTsx(argv: string[]): number {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/cli/commands/
  const repoRoot = path.resolve(here, "../../.."); // 仓库根（dist/cli/commands → 根）
  const entry = path.join(repoRoot, "src/cli/index.ts");
  if (!existsSync(entry)) {
    process.stderr.write(`ts 源入口不存在：${entry}（需在仓库内运行）\n`);
    return 1;
  }
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", entry, "wechat", ...argv],
    { stdio: "inherit", env: { ...process.env, PI_WORKFLOW_TSX: "1" }, cwd: process.cwd() },
  );
  if (result.error) {
    process.stderr.write(
      `tsx 重执行失败（${result.error.message}）；确认仓库内 npm install 过（tsx 为 devDependency）\n`,
    );
    return 1;
  }
  return result.status ?? 1;
}

export async function wechat(argv: string[], options: WechatCommandOptions = {}): Promise<number> {
  if (options.reexecTsx && !underTsx()) return reexecUnderTsx(argv);
  const sub = argv[0];
  if (sub === "login") return wechatLogin();
  if (sub !== "start") {
    process.stderr.write("用法：pi-workflow wechat <login|start> […flags]\n");
    return 2;
  }
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
  const allowAll = argv.includes("--allow-all"); // 接收所有用户（仅 AM-12 双账号用例；测试后务必移除）
  // --agent-limits llm,tools,ms（CSV；缺省 12,20,300000；仅 agent 模式生效，AM-11 用）
  let agentLimits: { maxLlmRequests: number; maxToolCalls: number; maxDurationMs: number } | undefined;
  const limitsRaw = flag("--agent-limits");
  if (limitsRaw) {
    const parts = limitsRaw.split(",").map((v) => Number(v.trim()));
    if (parts.length === 3 && parts.every((v) => Number.isFinite(v) && v > 0)) {
      agentLimits = { maxLlmRequests: parts[0]!, maxToolCalls: parts[1]!, maxDurationMs: parts[2]! };
    } else {
      process.stderr.write(`--agent-limits 格式非法：${limitsRaw}（应为 llm,tools,ms，如 12,20,300000）\n`);
      return 2;
    }
  }

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
  // 用户绑定（免记 wxid）：--allow-user > 已绑定文件 > 首消息自动绑定；--allow-all 关闭过滤（危险）
  const boundFile = path.join(dataDir, "bound-user.json");
  let boundNotice = "未绑定（首条消息发送者将自动绑定为唯一授权用户）";
  let botOptions: ConstructorParameters<typeof WechatBotAdapter>[0] = {};
  if (allowUser) {
    botOptions = { allowedUserIds: [allowUser] };
    boundNotice = `已绑定用户（--allow-user）：${allowUser}`;
  } else if (allowAll) {
    botOptions = {};
    boundNotice = "⚠️ 接收所有用户（--allow-all，仅双账号测试用，测完务必去掉）";
  } else if (fs.existsSync(boundFile)) {
    const bound = JSON.parse(fs.readFileSync(boundFile, "utf8")) as { userId?: string };
    if (bound.userId) {
      botOptions = { allowedUserIds: [bound.userId] };
      boundNotice = `已绑定用户（${boundFile}）：${bound.userId}（换人可删除该文件）`;
    }
  }
  if (!allowUser && !allowAll && !botOptions.allowedUserIds) {
    botOptions = {
      autoBindFirstUser: true,
      onUserBound: (userId) => {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(boundFile, JSON.stringify({ userId, boundAt: new Date().toISOString() }, null, 2));
        process.stdout.write(`\n🔔 已自动绑定用户：${userId}（写入 ${boundFile}；后续重启免重新绑定，换人可删除该文件）\n`);
      },
    };
  }
  const bot = new WechatBotAdapter(botOptions);
  const app = new WechatApp({
    bot,
    registry,
    llm,
    service,
    scriptsRoot,
    dataDir,
    routingMode,
    ...(agentLimits ? { agentLimits } : {}),
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
      `用户绑定：${boundNotice}`,
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
