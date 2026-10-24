/**
 * P0-B T2 单测：wechat service 命令族（PM2 封装，fake runner 注入）
 *  - findPm2App：jlist JSON 解析（正常/带杂音/坏 JSON）
 *  - service start：混跑互斥（锁持有者存活拒绝）、配置生成契约（绝对路径/env/优雅停止项）、pm2 缺失提示
 *  - service stop：命令序列 stop → delete；未注册直接 0
 *  - service restart：未注册拒绝
 *  - service status：dataDir 解析（--data flag > PM2 注册 args > 默认）+ 版本指纹 + 非 healthy 退出码 1
 *  - service stop/restart：活跃 workflow 守卫（--force 覆盖）
 *  - ecosystem args 数组形态（含空格路径由 PM2 处理边界）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wechatService, findPm2App, writeEcosystemConfig, type Pm2Result, type Pm2Runner } from "../../src/cli/commands/wechat-service.js";
import { listRuns } from "../../src/persistence/run-store.js";

function mkRunner(handler: (args: string[]) => Pm2Result | "record"): { runner: Pm2Runner; commands: string[][] } {
  const commands: string[][] = [];
  const runner: Pm2Runner = (args) => {
    commands.push(args);
    const out = handler(args);
    if (out === "record") return { ok: true, stdout: "[]", stderr: "", status: 0 };
    return out;
  };
  return { runner, commands };
}

const VERSION_OK: Pm2Result = { ok: true, stdout: "7.1.0\n", stderr: "", status: 0 };
const JLIST_EMPTY: Pm2Result = { ok: true, stdout: "[]\n", stderr: "", status: 0 };

const APP_ONLINE = [
  {
    name: "wechat-bot",
    pid: 4321,
    pm2_env: {
      status: "online",
      restart_time: 2,
      unstable_restarts: 0,
      pm_uptime: 1792600000000,
      args: ["wechat", "start", "--registry", "/repo/dev-examples/am-p0/registry.json", "--data", ".pi-wechat"],
    },
  },
];

// ── findPm2App ──

test("findPm2App：正常 jlist 解析", () => {
  const { runner } = mkRunner(() => ({ ok: true, stdout: JSON.stringify(APP_ONLINE), stderr: "", status: 0 }));
  const app = findPm2App(runner);
  assert.ok(app);
  assert.equal(app.status, "online");
  assert.equal(app.pid, 4321);
  assert.equal(app.restarts, 2);
  assert.deepEqual(app.args?.slice(0, 2), ["wechat", "start"], "启动参数数组透出（dataDir 解析依据）");
});

test("findPm2App：jlist 前后带日志杂音仍可解析；坏 JSON / 未注册返回 null", () => {
  const noisy = `[PM2] some noise\n${JSON.stringify(APP_ONLINE)}\n[PM2] done`;
  const { runner: r1 } = mkRunner(() => ({ ok: true, stdout: noisy, stderr: "", status: 0 }));
  assert.equal(findPm2App(r1)?.status, "online", "杂音中提取 JSON 数组");
  const { runner: r2 } = mkRunner(() => ({ ok: true, stdout: "not json at all", stderr: "", status: 0 }));
  assert.equal(findPm2App(r2), null, "坏 JSON → null");
  const { runner: r3 } = mkRunner(() => JLIST_EMPTY);
  assert.equal(findPm2App(r3), null, "未注册 → null");
});

// ── service start ──

test("service start：pm2 不可用 → 安装提示退出 1", async () => {
  const { runner, commands } = mkRunner(() => ({ ok: false, stdout: "", stderr: "not found", status: 127 }));
  const rc = await wechatService(["start"], runner);
  assert.equal(rc, 1);
  assert.deepEqual(commands[0], ["--version"]);
});

test("service start：锁持有者存活（前台/后台在跑）→ 混跑互斥退出 2，不触 pm2 start", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p0b-lock-"));
  fs.writeFileSync(path.join(tmp, "service.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), cwd: process.cwd() }), "utf8");
  const { runner, commands } = mkRunner(() => "record");
  const rc = await wechatService(["start", "--data", tmp], runner);
  assert.equal(rc, 2, "持有者存活即拒绝");
  assert.ok(!commands.some((c) => c[0] === "start"), "未执行 pm2 start");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("service start：无锁 → 生成配置并 pm2 start；配置契约（绝对路径/env/优雅停止）", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p0b-cfg-"));
  const { runner, commands } = mkRunner(() => "record");
  const rc = await wechatService(["start", "--data", tmp, "--routing-mode", "agent"], runner);
  assert.equal(rc, 0);
  const startCmd = commands.find((c) => c[0] === "start");
  assert.ok(startCmd, "执行了 pm2 start");
  const cfgPath = path.join(tmp, "ecosystem.config.cjs");
  assert.ok(fs.existsSync(cfgPath), "配置写入 data 目录");
  const cfg = fs.readFileSync(cfgPath, "utf8");
  assert.match(cfg, /shutdown_with_message: true/, "优雅停止开关");
  assert.match(cfg, /PI_WECHAT_SERVICE: "1"/, "服务模式标记");
  assert.match(cfg, /kill_timeout: 10000/, "强杀兜底超时");
  assert.match(cfg, /max_restarts: 10/, "重启上限");
  assert.match(cfg, /--routing-mode","agent"/, "透传业务 flags（数组形态，空格路径安全）");
  assert.match(cfg, new RegExp(tmp.replace(/\\/g, "\\\\\\\\")), "--data 被重写为绝对路径");
  assert.doesNotMatch(cfg, /--data "\.pi-wechat"/, "缺省相对 --data 不残留");
  assert.ok(fs.existsSync(path.join(tmp, "logs")), "日志目录创建");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("service start：PM2 已有同名残留（stopped）→ 先 delete 再 start", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p0b-stale-"));
  const { runner, commands } = mkRunner((args) =>
    args[0] === "jlist"
      ? { ok: true, stdout: JSON.stringify([{ name: "wechat-bot", pid: 0, pm2_env: { status: "stopped", restart_time: 5, unstable_restarts: 0, pm_uptime: 0 } }]), stderr: "", status: 0 }
      : "record",
  );
  const rc = await wechatService(["start", "--data", tmp], runner);
  assert.equal(rc, 0);
  const idxDelete = commands.findIndex((c) => c[0] === "delete");
  const idxStart = commands.findIndex((c) => c[0] === "start");
  assert.ok(idxDelete >= 0 && idxStart > idxDelete, "先 delete 残留再 start");
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── service stop / restart / status ──

test("service stop：已注册 → stop 后 delete（优雅停止 + 清条目）", async () => {
  const { runner, commands } = mkRunner((args) =>
    args[0] === "jlist" ? { ok: true, stdout: JSON.stringify(APP_ONLINE), stderr: "", status: 0 } : "record",
  );
  const rc = await wechatService(["stop"], runner);
  assert.equal(rc, 0);
  const idxStop = commands.findIndex((c) => c[0] === "stop");
  const idxDelete = commands.findIndex((c) => c[0] === "delete");
  assert.ok(idxStop >= 0, "执行 pm2 stop");
  assert.ok(idxDelete > idxStop, "stop 后 delete 清条目");
});

test("service stop：未注册 → 提示并 0（幂等）", async () => {
  const { runner } = mkRunner(() => JLIST_EMPTY);
  assert.equal(await wechatService(["stop"], runner), 0);
});

test("service restart：未注册 → 退出 2 提示先 start", async () => {
  const { runner } = mkRunner(() => JLIST_EMPTY);
  assert.equal(await wechatService(["restart"], runner), 2);
});

test("无子命令 → 用法提示退出 2", async () => {
  const { runner } = mkRunner(() => "record");
  assert.equal(await wechatService([], runner), 2);
});

// ── writeEcosystemConfig 直测（注入 root） ──

test("writeEcosystemConfig：--registry/--scripts 显式值被归一为绝对路径且不重复", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p0b-wcfg-"));
  const { configPath } = writeEcosystemConfig(
    tmp,
    ["--registry", "dev-examples/wx-article/registry.json", "--data", tmp, "--rate-max", "10"],
    path.resolve("."),
  );
  assert.ok(configPath);
  const cfg = fs.readFileSync(configPath, "utf8");
  assert.match(cfg, /--rate-max","10"/, "其它 flags 原样透传");
  const registryMatches = cfg.match(/--registry/g) ?? [];
  assert.equal(registryMatches.length, 1, "--registry 只出现一次（消费重写不重复）");
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── status dataDir 解析 + 版本指纹 + 退出码（2026-10-24 修复回归） ──

test("service status：dataDir 解析链——--data flag 优先，其次 PM2 注册 args，最后默认", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p0b-st-"));
  const flagDir = fs.mkdtempSync(path.join(os.tmpdir(), "p0b-st-flag-"));
  fs.writeFileSync(path.join(tmp, "service.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), cwd: process.cwd() }), "utf8");
  // 注册 args 指向 tmp；--data flag 指向 flagDir → flag 赢，锁读 flagDir（无锁）
  const app = [{ ...APP_ONLINE[0], pm2_env: { ...APP_ONLINE[0].pm2_env, args: ["wechat", "start", "--data", tmp] } }];
  const { runner } = mkRunner((args) => (args[0] === "jlist" ? { ok: true, stdout: JSON.stringify(app), stderr: "", status: 0 } : "record"));
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  try {
    const rc = await wechatService(["status", "--data", flagDir], runner);
    process.stdout.write = orig;
    assert.ok(out.includes(`data 目录：${flagDir}`), `flag 优先：${out}`);
    assert.ok(!out.includes(`data 目录：${tmp}`), "未回落到 PM2 注册 args");
    assert.equal(rc, 1, "锁读错路径 → 无存活持有者 → 非 healthy → 1");
    // 再验证回落：不带 --data → 用注册 args 的 tmp → 锁命中本进程（存活）
    out = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    const rc2 = await wechatService(["status"], runner);
    process.stdout.write = orig;
    assert.ok(out.includes(`data 目录：${tmp}`), `回落 PM2 args：${out}`);
    assert.ok(out.includes(`单实例锁：pid=${process.pid}（存活`), "锁从注册 dataDir 读到");
    assert.equal(rc2, 1, "online+锁存活但无 bot 状态文件 → starting → 非 1 即 0?（starting 仍非 healthy → 1）");
  } finally {
    process.stdout.write = orig;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(flagDir, { recursive: true, force: true });
  }
});

test("service status：版本指纹行（git HEAD + registry 摘要）；未注册退出码 1（供巡检判定就绪）", async () => {
  const { runner } = mkRunner(() => JLIST_EMPTY);
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  try {
    const rc = await wechatService(["status"], runner);
    assert.equal(rc, 1, "unregistered → stopped → 非 healthy → 1");
    assert.match(out, /版本：git \S+；registry \S+（\d+ 条，sha [0-9a-f]{8}）/, "指纹行完整");
    assert.match(out, /data 目录：/, "data 目录行存在");
  } finally {
    process.stdout.write = orig;
  }
});

// ── 活跃 workflow 守卫 ──

test("service stop/restart：活跃 workflow 在跑 → 拒绝（--force 覆盖）；无活跃 → 正常执行", async () => {
  const active = listRuns(path.resolve(".")).filter((r) => r.effectiveStatus === "running").length;
  const { runner, commands } = mkRunner((args) =>
    args[0] === "jlist" ? { ok: true, stdout: JSON.stringify(APP_ONLINE), stderr: "", status: 0 } : "record",
  );
  // stop：活跃>0 且无 --force → 2 且不触 pm2 stop；活跃=0 → 正常 0
  const rcStop = await wechatService(["stop"], runner);
  if (active > 0) {
    assert.equal(rcStop, 2, "活跃时默认拒绝");
    assert.ok(!commands.some((c) => c[0] === "stop"), "未执行 pm2 stop");
    const rcForce = await wechatService(["stop", "--force"], runner);
    assert.equal(rcForce, 0, "--force 覆盖守卫");
  } else {
    assert.equal(rcStop, 0, "无活跃直接停");
  }
  // restart 同语义
  commands.length = 0;
  const rcRestart = await wechatService(["restart"], runner);
  if (active > 0) {
    assert.equal(rcRestart, 2, "restart 活跃时拒绝");
    assert.ok(!commands.some((c) => c[0] === "restart"));
    assert.equal(await wechatService(["restart", "--force"], runner), 0);
  } else {
    assert.equal(rcRestart, 0);
  }
});

// ── ecosystem args 数组形态（空格路径安全） ──

test("writeEcosystemConfig：args 保持数组（含空格路径不拆错）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p0b-arr-"));
  const spacePath = path.join(tmp, "dir with spaces");
  fs.mkdirSync(spacePath, { recursive: true });
  const { configPath } = writeEcosystemConfig(
    tmp,
    ["--scripts", spacePath],
    path.resolve("."),
  );
  const cfg = fs.readFileSync(configPath, "utf8");
  const esc = spacePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(cfg, new RegExp(`--scripts",\\s*"${esc}`), "数组形态保留含空格路径");
  fs.rmSync(tmp, { recursive: true, force: true });
});
