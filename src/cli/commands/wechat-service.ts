/**
 * pi-workflow wechat service —— 后台服务生命周期（P0-B T2；需求 §4 F1/F2/F4、§4.1）
 *
 * PM2 封装（部署层，不嵌业务；设计 §5 分层）：
 *   service start    生成 ecosystem 配置（<data>/ecosystem.config.cjs）→ pm2 start
 *   service stop     pm2 stop + delete（shutdown_with_message 优雅停止，kill_timeout 兜底强杀）
 *   service status   聚合：PM2 进程态 + 单实例锁持有者（Bot 连接态 P0-C 接入）
 *   service restart  pm2 restart（用现有配置重启；未注册则提示先 start）
 *
 * 关键约定：
 *   - 托管形态单进程：node --import tsx src/cli/index.ts wechat start …（P0-A 定型，无 wrapper）
 *   - 锁在前台/后台共享 Bot 启动层——service start 前先查锁，持有者存活即拒绝（混跑互斥）
 *   - 服务进程 env PI_WECHAT_SERVICE=1：shutdown message 优雅停止后 exit(0)（T1）
 *   - 日志锚定 <data>/logs/（F3 落盘；pm2-logrotate 滚动属 P0-C）
 *   - pm2 经 shell 调用（Windows 下 pm2 是 .cmd，Node 安全限制必须 shell；Unix 同样兼容）
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { readServiceLock } from "../../gateway/service-lock.js";
import { readBotStatus, aggregateServiceStatus, type BotStatusFile } from "../../gateway/bot-status.js";
import { readBotStats } from "../../gateway/bot-stats.js";
import { listRuns } from "../../persistence/run-store.js";

const PM2_APP_NAME = "wechat-bot";

/** pm2 调用结果（runner 可注入，单测用 fake） */
export interface Pm2Result {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

export type Pm2Runner = (args: string[]) => Pm2Result;

/** 默认 runner：spawnSync pm2（Windows 必须走 shell 才能执行 pm2.cmd） */
export function createShellPm2Runner(): Pm2Runner {
  return (args: string[]) => {
    // cmd.exe 下含空格参数需手工加引号；unix shell 对简单引号也兼容
    const quoted = args.map((a) => (a.includes(" ") ? `"${a}"` : a));
    // shell 模式传整条命令字符串（DEP0190：args 数组与 shell:true 组合已废弃）
    const line = ["pm2", ...quoted].join(" ");
    const r = spawnSync(line, {
      shell: true,
      encoding: "utf8",
      timeout: 120_000,
    });
    return {
      ok: r.status === 0,
      stdout: r.stdout ?? "",
      stderr: (r.stderr ?? "") + (r.error ? r.error.message : ""),
      status: r.status,
    };
  };
}

/** 仓库根：dist/cli/commands 或 src/cli/commands 均为三级向上 */
function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}

/** tsx 绝对 file URL（与 wechat.ts reexec 同款解析；仓库根 node_modules 内） */
function tsxImportArg(root: string): string | null {
  try {
    const tsx = createRequire(path.join(root, "package.json")).resolve("tsx");
    return pathToFileURL(tsx).href;
  } catch {
    return null;
  }
}

/** pm2 jlist 解析：返回该应用的进程条目（未注册返回 null） */
export function findPm2App(runner: Pm2Runner, name = PM2_APP_NAME): Pm2AppInfo | null {
  const r = runner(["jlist"]);
  if (!r.ok) return null;
  // 杂音容忍：从每个 [ 起点与每个 ] 终点尝试解析（[PM2] 日志前缀也含中括号），首个成功即用
  let list: Array<Record<string, unknown>> | null = null;
  outer: for (let begin = r.stdout.indexOf("["); begin >= 0; begin = r.stdout.indexOf("[", begin + 1)) {
    for (let end = r.stdout.lastIndexOf("]"); end > begin; end = r.stdout.lastIndexOf("]", end - 1)) {
      try {
        const parsed = JSON.parse(r.stdout.slice(begin, end + 1)) as unknown;
        if (Array.isArray(parsed)) {
          list = parsed as Array<Record<string, unknown>>;
          break outer;
        }
      } catch {
        // 该区间不是 JSON 数组，试下一组
      }
    }
  }
  if (!list) return null;
  const app = list.find((a) => a.name === name);
  if (!app) return null;
  const env = (app.pm2_env ?? {}) as Record<string, unknown>;
  const rawArgs = (env.args ?? []) as unknown;
  return {
    name,
    pid: typeof app.pid === "number" ? app.pid : 0,
    status: typeof env.status === "string" ? env.status : "unknown",
    restarts: typeof env.restart_time === "number" ? env.restart_time : 0,
    unstableRestarts: typeof env.unstable_restarts === "number" ? env.unstable_restarts : 0,
    startedAt: typeof env.pm_uptime === "number" ? new Date(env.pm_uptime).toISOString() : "",
    args: Array.isArray(rawArgs) ? rawArgs.map(String) : [],
  };
}

export interface Pm2AppInfo {
  name: string;
  pid: number;
  status: string; // online / stopped / errored / unknown
  restarts: number;
  unstableRestarts: number;
  startedAt: string;
  /** PM2 进程启动参数（ecosystem args 数组；从中提取 --data/--registry 锚定真实路径） */
  args: string[];
}

/** 从 PM2 注册信息提取 --data（服务真实 data 目录；无则用默认） */
function dataDirFromApp(app: Pm2AppInfo): string {
  const v = flagValue(app.args, "--data");
  return v ? path.resolve(v) : path.resolve(".pi-wechat");
}

/** status/stop/restart 的 data 目录解析：--data flag > PM2 注册参数 > 默认 .pi-wechat */
function resolveDataDir(flags: string[], app: Pm2AppInfo | null): string {
  const v = flagValue(flags, "--data");
  if (v) return path.resolve(v);
  return app ? dataDirFromApp(app) : path.resolve(".pi-wechat");
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 生成 ecosystem 配置（锚定仓库根 + 显式绝对路径：registry/scripts/data，重启后一致） */
export function writeEcosystemConfig(
  dataDir: string,
  flags: string[],
  root = repoRoot(),
): { configPath: string; entryMissing?: string } {
  const rootAbs = path.resolve(root);
  const dataAbs = path.resolve(dataDir);
  const entry = path.join(rootAbs, "src", "cli", "index.ts");
  const tsx = tsxImportArg(rootAbs);
  if (!fs.existsSync(entry)) return { configPath: "", entryMissing: entry };
  if (!tsx) return { configPath: "", entryMissing: `tsx（仓库根 node_modules 内，先 npm install）` };

  const registry = flagValue(flags, "--registry") ?? path.join(rootAbs, "dev-examples", "am-p0", "registry.json");
  const scripts = flagValue(flags, "--scripts") ?? path.join(rootAbs, "dev-examples");
  const args = [
    "wechat",
    "start",
    "--registry",
    path.resolve(registry),
    "--scripts",
    path.resolve(scripts),
    "--data",
    dataAbs,
    ...flags.filter((f, i) => !isConsumedFlag(flags, i)),
  ];

  fs.mkdirSync(path.join(dataAbs, "logs"), { recursive: true });
  const logOut = path.join(dataAbs, "logs", `${PM2_APP_NAME}-out.log`);
  const logErr = path.join(dataAbs, "logs", `${PM2_APP_NAME}-err.log`);
  const configPath = path.join(dataAbs, "ecosystem.config.cjs");
  const config = `/**
 * pi-workflow wechat service 自动生成（service start；请勿手工编辑，重启 service start 会重写）
 * 形态：单进程 node --import tsx（P0-A 定型）；停止走 shutdown message 优雅停止
 */
const path = require("node:path");
module.exports = {
  apps: [
    {
      name: ${JSON.stringify(PM2_APP_NAME)},
      script: ${JSON.stringify(entry)},
      interpreter: "node", // PM2 7 对 .ts 默认选 bun（无 bun 时静默起不来，online 假象零日志），强制 node
      node_args: "--import " + ${JSON.stringify(tsx)},
      // 参数保持数组形态：含空格路径由 PM2 自行处理边界（拼接字符串会在 Windows/空格路径下拆错）
      args: ${JSON.stringify(args)},
      cwd: ${JSON.stringify(rootAbs)},
      exec_mode: "fork",
      instances: 1,
      shutdown_with_message: true,
      kill_timeout: 10000,
      exp_backoff_restart_delay: 1000,
      min_uptime: "30s",
      max_restarts: 10,
      env: { PI_WECHAT_SERVICE: "1" },
      out_file: ${JSON.stringify(logOut)},
      error_file: ${JSON.stringify(logErr)},
      merge_logs: true,
      time: true,
    },
  ],
};
`;
  fs.writeFileSync(configPath, config, "utf8");
  return { configPath };
}

/** --flag 值提取（与 wechat.ts flag 同语义，作用于数组） */
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** 该位置是否为已被显式消费的 flag 值/flag 本体（--registry/--scripts/--data 会被重写为绝对路径） */
function isConsumedFlag(argv: string[], i: number): boolean {
  const names = ["--registry", "--scripts", "--data"];
  for (let j = 0; j < argv.length; j++) {
    if (argv[j] !== undefined && names.includes(argv[j]!)) {
      if (j === i) return true; // flag 本体
      if (j + 1 === i) return true; // flag 的值
    }
  }
  return false;
}

export async function wechatService(argv: string[], runner: Pm2Runner = createShellPm2Runner()): Promise<number> {
  const sub = argv[0];
  const flags = argv.slice(1);
  if (sub === "start") return serviceStart(flags, runner);
  if (sub === "stop") return serviceStop(flags, runner);
  if (sub === "status") return serviceStatus(flags, runner);
  if (sub === "restart") return serviceRestart(flags, runner);
  process.stderr.write(
    [
      "用法：pi-workflow wechat service <start|stop|status|restart>",
      "  start [wechat start 同款 flags：--registry/--scripts/--data/--routing-mode/--model/--rate-max/--budget-tokens/--agent-limits/--allow-user/--allow-all]",
      "  stop [--data <dir>] [--force]   优雅停止（活跃 workflow 在跑时需 --force）",
      "  status [--data <dir>]           PM2 进程态 + 单实例锁 + 版本指纹（非 healthy 退出码 1）",
      "  restart [--data <dir>] [--force] 用现有配置重启（活跃 workflow 在跑时需 --force）",
    ].join("\n") + "\n",
  );
  return 2;
}

async function serviceStart(flags: string[], runner: Pm2Runner): Promise<number> {
  // 0) pm2 可用性
  const probe = runner(["--version"]);
  if (!probe.ok) {
    process.stderr.write("未找到可用的 pm2（后台托管依赖）。安装：npm i -g pm2\n");
    return 1;
  }
  const dataDir = path.resolve(flagValue(flags, "--data") ?? path.join(".pi-wechat"));

  // 1) 混跑互斥（锁在共享启动层；前台在跑也要拦——设计 §7 门禁「前台+后台混跑」）
  const lock = readServiceLock(dataDir);
  if (lock && pidAlive(lock.pid)) {
    const viaService = findPm2App(runner) !== null; // 服务形态→一步 restart；前台形态→两步指引
    process.stderr.write(
      [
        `微信服务已在运行（pid=${lock.pid}，startedAt=${lock.startedAt}，cwd=${lock.cwd}）`,
        `data 目录：${dataDir}`,
        viaService
          ? `如需重启：pi-workflow wechat service restart；查看状态：pi-workflow wechat service status`
          : `如需重启：停掉现有进程（前台 Ctrl-C / 后台 wechat service stop）后再启动`,
      ].join("\n") + "\n",
    );
    return 2;
  }

  // 2) 清理 PM2 内同名残留（stopped/errored 条目会让 pm2 start 报已存在）
  const existing = findPm2App(runner);
  if (existing) {
    runner(["delete", PM2_APP_NAME]);
  }

  // 3) 生成配置并启动
  const { configPath, entryMissing } = writeEcosystemConfig(dataDir, flags);
  if (!configPath) {
    process.stderr.write(`启动入口缺失：${entryMissing}\n`);
    return 1;
  }
  const start = runner(["start", configPath]);
  if (!start.ok) {
    process.stderr.write(`pm2 start 失败：${start.stderr || start.stdout}\n`);
    return 1;
  }
  runner(["save"]); // 同步自启快照（F6：resurrect 恢复的是 save 时刻进程表；不刷则登录时旧状态复活/新启动丢失）
  process.stdout.write(
    [
      `服务已提交 PM2 托管（app=${PM2_APP_NAME}，data=${dataDir}）`,
      `配置：${configPath}`,
      `日志：${path.join(dataDir, "logs")}`,
      `状态：pi-workflow wechat service status（进程冷启动需数秒）`,
      `停止：pi-workflow wechat service stop`,
    ].join("\n") + "\n",
  );
  return 0;
}

/** 服务进程 cwd（ecosystem 锚定仓库根）即 RunApplicationService baseDir——活跃 run 从这里扫 */
function activeWorkflowRuns(): { runId: string; name: string }[] {
  try {
    return listRuns(repoRoot())
      .filter((r) => r.effectiveStatus === "running")
      .map((r) => ({ runId: r.runId, name: r.name }));
  } catch {
    return []; // runs 目录不存在/不可读 → 不阻断生命周期命令
  }
}

/** 活跃 workflow 守卫：在跑且无 --force → 返回提示文案；可停返回 null */
function activeRunGuard(flags: string[]): string | null {
  if (flags.includes("--force")) return null;
  const active = activeWorkflowRuns();
  if (active.length === 0) return null;
  const head = active.slice(0, 5).map((r) => `  - ${r.runId}（${r.name}）`).join("\n");
  const more = active.length > 5 ? `\n  …共 ${active.length} 个` : "";
  return [
    `有 ${active.length} 个 workflow 正在运行，停止/重启会中断它们：`,
    head + more,
    `确认中断请加 --force；或等任务完成 / pi-workflow status 查看进度。`,
  ].join("\n");
}

/** git HEAD 短指纹（识别“跑的是哪个版本”；非 git 环境返回 ?） */
function gitHead(root: string): string {
  try {
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" });
    return r.status === 0 ? (r.stdout ?? "").trim() : "?";
  } catch {
    return "?";
  }
}

/** registry 指纹：条数 + sha256 前 8 位（识别“加载的是哪份注册表”） */
function registryFingerprint(file: string): string {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const count = Array.isArray(parsed) ? parsed.length : -1;
    const sha8 = createHash("sha256").update(raw).digest("hex").slice(0, 8);
    return `${file}（${count} 条，sha ${sha8}）`;
  } catch {
    return `${file}（不可读）`;
  }
}

async function serviceStop(flags: string[], runner: Pm2Runner): Promise<number> {
  const app = findPm2App(runner);
  if (!app) {
    process.stdout.write(`PM2 中无 ${PM2_APP_NAME} 条目（服务未以 service 形态运行）。\n`);
    return 0;
  }
  const guard = activeRunGuard(flags);
  if (guard) {
    process.stderr.write(guard + "\n");
    return 2;
  }
  const stop = runner(["stop", PM2_APP_NAME]);
  if (!stop.ok) {
    process.stderr.write(`pm2 stop 失败：${stop.stderr || stop.stdout}\n`);
    return 1;
  }
  runner(["delete", PM2_APP_NAME]); // 清条目：下次 start 不撞「已存在」
  runner(["save"]); // 同步自启快照：停止意图也落盘，登录时不会把你停掉的服务又拉起来
  process.stdout.write(
    `已停止并注销 ${PM2_APP_NAME}（优雅停止完成；如仍有前台实例，Ctrl-C 退出）。\n`,
  );
  return 0;
}

async function serviceStatus(flags: string[], runner: Pm2Runner): Promise<number> {
  const app = findPm2App(runner);
  const processStatus = app?.status ?? "unregistered";
  const dataDir = resolveDataDir(flags, app);
  const lock = readServiceLock(dataDir);
  const holderPid = lock && pidAlive(lock.pid) ? lock.pid : 0;
  const bot = readBotStatus(dataDir);
  const agg = aggregateServiceStatus({
    processStatus: processStatus === "online" ? "online" : processStatus === "stopped" ? "stopped" : processStatus === "errored" ? "errored" : "unregistered",
    holderPid,
    botStatus: bot as BotStatusFile | null,
  });
  const root = repoRoot();
  const registryFile =
    (app ? flagValue(app.args, "--registry") : undefined) ?? path.join(root, "dev-examples", "am-p0", "registry.json");
  const lines: string[] = [
    `综合状态：${agg.overall}（${agg.detail}）`,
    app
      ? `PM2 进程：${app.status}（pid=${app.pid}，restarts=${app.restarts}，unstable=${app.unstableRestarts}，startedAt=${app.startedAt}）`
      : `PM2 进程：未注册（服务未以 service 形态运行）`,
    `data 目录：${dataDir}`,
    `单实例锁：${lock ? `pid=${lock.pid}（${pidAlive(lock.pid) ? "存活" : "已死（陈锁，下次启动自愈）"}，startedAt=${lock.startedAt}）` : "无锁（服务未运行）"}`,
    bot
      ? `Bot 连接：${agg.bot}（attempt=${bot.attempt}，updatedAt=${bot.updatedAt}，lastPollOkAt=${bot.lastPollOkAt || "无"}）`
      : `Bot 连接：无状态文件`,
    `版本：git ${gitHead(root)}；registry ${registryFingerprint(path.resolve(registryFile))}`,
    (() => {
      const s = readBotStats(dataDir);
      if (!s || s.pid !== holderPid) return `运营统计：无（本代未记录）`;
      const fmt = (iso: string) => (iso ? new Date(iso).toLocaleString() : "无");
      return `运营统计：最近收 ${fmt(s.lastInboundAt)} / 发 ${fmt(s.lastOutboundAt)}；累计 ${s.turnsCount} 轮 / ${s.totalTokens} tokens`;
    })(),
    (() => {
      // 最近崩溃线索：restarts>0 时取 err 日志尾行（非权威 crash 栈，定位起点用）
      if (!app || app.restarts <= 0) return `崩溃：无重启记录`;
      const errLog = path.join(dataDir, "logs", "wechat-bot-err.log");
      try {
        const tail = fs
          .readFileSync(errLog, "utf8")
          .trim()
          .split(/\r?\n/)
          .slice(-2)
          .join(" | ");
        return `崩溃：restarts=${app.restarts}，err 尾行：${tail.slice(-160)}`;
      } catch {
        return `崩溃：restarts=${app.restarts}（err 日志不可读）`;
      }
    })(),
    `日志：${path.join(dataDir, "logs")}（pm2-logrotate 按天滚动）`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
  // 退出码：查询本身总能完成；非 healthy（未注册/停止/启动中/凭据失效/心跳超时/errored）→ 1，
  // 供脚本/巡检直接判定“服务就绪与否”（2026-10-24 复审：unregistered/stopped 此前误归 0）
  return agg.overall === "healthy" ? 0 : 1;
}

async function serviceRestart(flags: string[], runner: Pm2Runner): Promise<number> {
  const app = findPm2App(runner);
  if (!app) {
    process.stderr.write(`PM2 中无 ${PM2_APP_NAME} 条目；首次启动请用 service start（可带参数）。\n`);
    return 2;
  }
  const guard = activeRunGuard(flags);
  if (guard) {
    process.stderr.write(guard + "\n");
    return 2;
  }
  const r = runner(["restart", PM2_APP_NAME]);
  if (!r.ok) {
    process.stderr.write(`pm2 restart 失败：${r.stderr || r.stdout}\n`);
    return 1;
  }
  process.stdout.write(`已重启 ${PM2_APP_NAME}（沿用现有配置；改参数请 stop 后重新 start）。\n`);
  return 0;
}
