/**
 * pi-workflow wechat start —— wechat-dispatch 长驻装配（WX-P1 T7 + WX-P2 可靠性）
 *
 * 装配核心见 WechatApp：Inbox 幂等 → 限频 → Dispatcher/TaskControl → RunApplicationService
 *   → Outbox（完成≠送达）→ RunMonitor（审批卡/终态通知）→ AuditLog 全链路审计。
 * 前置：WX-P0 真机 SOP 已扫码（credentials.json 存在）。
 * 用法：pi-workflow wechat login                                    —— 扫码登录/复用已有凭证（免记 wxid）
 *      pi-workflow wechat rebind                                   —— 清除旧凭据并重新扫码（换机接管/凭据失效重登）
 *      pi-workflow wechat start --registry dev-examples/am-p0/registry.json \
 *        --scripts dev-examples [--rate-max 20] [--budget-tokens 200000] [--data .pi-wechat]
 *        [--routing-mode legacy|agent]（缺省 agent = Conversational Agent 模式，AM-P0；legacy 需显式指定）
 * 用户绑定（免记 wxid）：--allow-user 指定 > .pi-wechat/bound-user.json 已绑定 > 首条消息发送者自动绑定；
 *        --allow-all 接收所有用户（仅 AM-12 双账号用例，测完务必去掉）
 * WG-007：Ctrl-C 只停 Bot；运行中任务不取消，可 `pi-workflow resume <runId>` 续跑。
 */

import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { WorkflowRegistry } from "../../dispatch/registry.js";
import { WechatBotAdapter } from "../../gateway/wechat/bot-adapter.js";
import { MockWechatClient } from "../../gateway/wechat/mock-client.js";
import { WechatApp } from "../../gateway/wechat-app.js";
import { createRunApplicationService } from "../../application/run-service.js";
import { PiAgentAdapter } from "../../adapters/pi/pi-agent-adapter.js";
import type { RoutingLLM } from "../../dispatch/intent-router.js";
import { wechatLogin } from "./wechat-login.js";
import { acquireServiceLock, releaseServiceLock } from "../../gateway/service-lock.js";
import { createGracefulShutdown } from "../../gateway/service-shutdown.js";
import { BotStatusMonitor } from "../../gateway/bot-status.js";
import { BotStatsRecorder } from "../../gateway/bot-stats.js";
import { wechatService } from "./wechat-service.js";

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
  // tsx 从仓库根解析为绝对 file URL：相对包名会在 cwd（任意项目目录）下解析失败（ERR_MODULE_NOT_FOUND）
  let tsxSpecifier: string;
  try {
    tsxSpecifier = pathToFileURL(
      createRequire(path.join(repoRoot, "package.json")).resolve("tsx"),
    ).href;
  } catch {
    process.stderr.write(
      `仓库内未找到 tsx：${repoRoot}（需先 npm install，tsx 为 devDependency）\n`,
    );
    return 1;
  }
  const result = spawnSync(
    process.execPath,
    ["--import", tsxSpecifier, entry, "wechat", ...argv],
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
  if (sub === "rebind") return wechatLogin(true);
  if (sub === "service") return wechatService(argv.slice(1)); // PM2 封装，不触 thirdparties，无需 tsx 重执行
  if (sub !== "start") {
    process.stderr.write("用法：pi-workflow wechat <login|rebind|start|service> […flags]\n");
    return 2;
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // 服务模式下 PM2 fork 的 IPC channel 会吊住事件循环：早退路径 return 后进程不退出，
  // PM2 误判 online（假健康）。服务模式冲刷后硬退出；前台模式保持自然退出语义。
  const finish = (rc: number): number => {
    if (process.env.PI_WECHAT_SERVICE === "1") {
      process.stdout.write("", () => process.exit(rc));
    }
    return rc;
  };
  // 缺省场景 = 日常手动测试：am-p0 registry + dev-examples 脚本根（无副本，随仓库走，任何机器 clone 即用）；
  // 显式 --registry 时 scriptsRoot 缺省仍为 registry 所在目录（白名单语义不变）
  const explicitRegistry = flag("--registry");
  const registryFile = explicitRegistry ?? path.join("dev-examples", "am-p0", "registry.json");
  const scriptsRoot = flag("--scripts") ?? (explicitRegistry ? path.dirname(path.resolve(registryFile)) : "dev-examples");
  const model = flag("--model");
  const allowUser = flag("--allow-user");
  const dataDir = flag("--data") ?? path.join(".pi-wechat");
  const rateMax = flag("--rate-max") ? Number(flag("--rate-max")) : undefined;
  const budgetTokens = flag("--budget-tokens") ? Number(flag("--budget-tokens")) : undefined;
  const routingModeRaw = flag("--routing-mode");
  const routingMode = routingModeRaw === "legacy" ? "legacy" : "agent"; // 缺省 agent（AM-P0 目标模式；legacy 需显式指定）
  const allowAll = argv.includes("--allow-all"); // 接收所有用户（仅 AM-12 双账号用例；测试后务必移除）
  const mockClient = argv.includes("--mock-client"); // 测试客户端：消息进出走 mock-inbox/outbox.jsonl（V8-mock，替代真机手动发消息）
  // --auto-approve id1,id2（CSV）：高风险流程跳过审批直接执行（预检照常；服务端声明，LLM 无法自加入）
  const autoApproveRaw = flag("--auto-approve");
  let autoApprove: string[] | undefined;
  if (autoApproveRaw) {
    autoApprove = autoApproveRaw.split(",").map((v) => v.trim()).filter(Boolean);
    if (autoApprove.length === 0) {
      process.stderr.write(`--auto-approve 格式非法：${autoApproveRaw}（应为 workflowId CSV）\n`);
      return finish(2);
    }
  }
  // --agent-limits llm,tools,ms（CSV；缺省 12,20,300000；仅 agent 模式生效，AM-11 用）
  let agentLimits: { maxLlmRequests: number; maxToolCalls: number; maxDurationMs: number } | undefined;
  const limitsRaw = flag("--agent-limits");
  if (limitsRaw) {
    const parts = limitsRaw.split(",").map((v) => Number(v.trim()));
    if (parts.length === 3 && parts.every((v) => Number.isFinite(v) && v > 0)) {
      agentLimits = { maxLlmRequests: parts[0]!, maxToolCalls: parts[1]!, maxDurationMs: parts[2]! };
    } else {
      process.stderr.write(`--agent-limits 格式非法：${limitsRaw}（应为 llm,tools,ms，如 12,20,300000）\n`);
      return finish(2);
    }
  }

  const { registry, issues } = WorkflowRegistry.loadFromFile(registryFile);
  if (issues.length > 0) console.warn(`registry 问题条目：${issues.join("; ")}`);
  if (registry.all().length === 0) {
    process.stderr.write(
      [
        `注册表不存在或为空：${registryFile}`,
        `需显式指定，如：pi-workflow wechat start --registry dev-examples/am-p0/registry.json --scripts dev-examples [--routing-mode agent]`,
      ].join("\n") + "\n",
    );
    return finish(2);
  }
  if (autoApprove) {
    const unknown = autoApprove.filter((id) => !registry.get(id));
    if (unknown.length > 0)
      process.stderr.write(`⚠ --auto-approve 含未知流程：${unknown.join(",")}（照常启动，仅对存在流程生效）\n`);
    else process.stdout.write(`自动批准白名单：${autoApprove.join(",")}（跳过审批直接执行；预检/幂等/排他照常）\n`);
  }

  // F5 单实例锁：前台/后台共享 Bot 启动层互斥（同机同 data 目录）
  const lock = acquireServiceLock(dataDir);
  if (!lock.acquired) {
    process.stderr.write(
      [
        `微信服务已在运行（pid=${lock.holder?.pid ?? "?"}，startedAt=${lock.holder?.startedAt ?? "?"}，cwd=${lock.holder?.cwd ?? "?"}）`,
        `data 目录：${lock.lockDir}`,
        `如需重启：停掉现有进程（前台 Ctrl-C / 后台 wechat service stop）后再启动`,
      ].join("\n") + "\n",
    );
    return finish(2);
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
    boundNotice = "[警告] 接收所有用户（--allow-all，仅双账号测试用，测完务必去掉）";
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
        process.stdout.write(`\n[绑定] 已自动绑定用户：${userId}（写入 ${boundFile}；后续重启免重新绑定，换人可删除该文件）\n`);
      },
    };
  }
  const botStatusMonitor = new BotStatusMonitor(dataDir, process.pid);
  const botStats = new BotStatsRecorder(dataDir);
  const bot = new WechatBotAdapter({
    ...botOptions,
    // --mock-client：注入文件型测试客户端（除微信传输线协议外全链真实；绑定/幂等/授权门照常）
    ...(mockClient ? { clientFactory: async () => new MockWechatClient(dataDir) } : {}),
    onStatus: (status, attempt) => botStatusMonitor.handleAdapterStatus(status, attempt),
    onPollOk: () => botStatusMonitor.handlePollOk(),
  });
  const app = new WechatApp({
    bot,
    registry,
    llm,
    service,
    scriptsRoot,
    dataDir,
    routingMode,
    stats: botStats,
    ...(agentLimits ? { agentLimits } : {}),
    ...(autoApprove ? { autoApprove } : {}),
    ...(model ? { defaultModel: model } : {}),
    limits: {
      ...(rateMax !== undefined && !Number.isNaN(rateMax) ? { rateMax } : {}),
      ...(budgetTokens !== undefined && !Number.isNaN(budgetTokens) ? { maxTokensPerUser: budgetTokens } : {}),
    },
  });

  try {
    await app.start();
  } catch (error) {
    releaseServiceLock(dataDir);
    process.stderr.write(`微信启动失败：${error instanceof Error ? error.message : String(error)}\n（先完成真机 SOP：npx tsx dev-examples/wx-m0/standalone-adapter.ts --qr）\n`);
    return finish(1);
  }
  const serviceMode = process.env.PI_WECHAT_SERVICE === "1";
  process.stdout.write(
    [
      `wechat-dispatch 已启动（routing-mode=${routingMode}，registry=${registry.all().length} 个流程，scripts=${scriptsRoot}，data=${dataDir}${mockClient ? "，client=MOCK" : ""}）`,
      ...(routingMode === "agent"
        ? [
            `agent 模式：Conversational Agent（持久会话+五工具；高风险需「批准」确认；同用户消息排队串行）`,
            `会话目录：${path.resolve(dataDir, "..", ".pi-agent-host", "sessions")}`,
          ]
        : []),
      `用户绑定：${boundNotice}`,
      `任务指令：任务列表 / 进度如何 / 取消任务 / 恢复任务 / 批准 / 拒绝`,
      serviceMode
        ? `服务模式（PM2 托管）：停止用 pi-workflow wechat service stop（shutdown message 优雅停止）`
        : `Ctrl-C 仅停止 Bot（运行中任务不受影响，可用 pi-workflow resume <runId> 恢复）`,
    ].join("\n") + "\n",
  );
  // 优雅停止（P0-B T1）：SIGINT（前台）与 PM2 shutdown message（后台）共用一条路径；
  // 防重复、stop 失败也释放锁；服务模式停完即 exit(0)（PM2 等的是进程退出）
  await new Promise<void>((resolve) => {
    const shutdown = createGracefulShutdown({
      stop: () => app.stop(),
      releaseLock: () => releaseServiceLock(dataDir),
      onStopped: () => resolve(),
      serviceMode,
    });
    process.once("SIGINT", () => shutdown("SIGINT（Ctrl-C）"));
    process.on("message", (msg: unknown) => {
      if (msg === "shutdown") shutdown("PM2 shutdown message");
    });
  });
  return 0;
}
