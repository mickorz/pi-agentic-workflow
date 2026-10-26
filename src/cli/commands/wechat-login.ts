/**
 * pi-workflow wechat login —— 微信扫码登录 / 复用已有凭证
 *
 * 已有凭据（~/.pi/agent/wechat-assistant/credentials.json）→ 直接复用并回显账号信息；
 * 无凭据 → 终端二维码扫码 → 轮询确认 → 落盘。登录后 `wechat start` 免再扫码。
 *
 * 注意：扫码登录的账号即 Bot 账号；发消息的微信号无需预先知晓 wxid——
 * `wechat start` 缺省首消息自动绑定（bound-user.json）。
 * 协议层经动态 import 引 thirdparties TS 源（Node 原生 type stripping；不入 tsc 编译范围，
 * 与 bot-adapter 同款变量路径 + 结构化类型写法）。
 */

import fs from "node:fs";
import path from "node:path";

const QR_POLL_MS = 2000;
const QR_MAX_REFRESH = 5;

/** rebind 后：服务形态自动优雅重启（旧进程仍持旧凭据）；前台形态提示手动重启 */
async function restartServiceAfterRebind(): Promise<void> {
  const { findPm2App, createShellPm2Runner } = await import("./wechat-service.js");
  const { readServiceLock } = await import("../../gateway/service-lock.js");
  const runner = createShellPm2Runner();
  const app = findPm2App(runner);
  if (app) {
    const r = runner(["restart", "wechat-bot"]);
    process.stdout.write(
      r.ok
        ? "[OK] 已自动重启后台服务（rebind 新凭据生效；状态：pi-workflow wechat service status）\n"
        : `[警告] 自动重启失败（${(r.stderr || r.stdout).slice(0, 120)}）；请手动 pi-workflow wechat service restart\n`,
    );
    return;
  }
  const lock = readServiceLock(".pi-wechat");
  if (lock) {
    try {
      process.kill(lock.pid, 0);
      process.stdout.write(
        `[提示] 检测到前台 Bot 实例（pid=${lock.pid}）仍持旧凭据：请在其终端 Ctrl-C 后重新 wechat start\n`,
      );
    } catch {
      // 持有者已死（陈锁）：无需动作
    }
  }
}

/** 定位服务数据目录（给绑定确认消息用）：优先 PM2 ecosystem args 的 --data；
 *  兜底 cwd 相对 .pi-wechat（与 restartServiceAfterRebind 的锁检查同款假设） */
async function resolveServiceDataDir(): Promise<string | null> {
  try {
    const { findPm2App, createShellPm2Runner } = await import("./wechat-service.js");
    const app = findPm2App(createShellPm2Runner());
    if (app) {
      const i = app.args.indexOf("--data");
      if (i >= 0 && app.args[i + 1]) return app.args[i + 1] ?? null;
    }
  } catch {
    // PM2 不可用：走兜底
  }
  try {
    const { readServiceLock } = await import("../../gateway/service-lock.js");
    if (readServiceLock(".pi-wechat")) return path.resolve(".pi-wechat");
  } catch {
    // 无锁：无服务形态
  }
  return null;
}

/** 登录/重绑成功后：经服务 outbox 给绑定用户发确认消息（服务 5s flush 投递；尽力而为，绝不阻塞登录）。
 *  无绑定用户（首次登录，绑定发生在首条入站消息）则跳过并提示。 */
export async function notifyLoginBound(dataDir: string | null): Promise<void> {
  if (!dataDir) {
    process.stdout.write("[提示] 未定位到服务数据目录，跳过绑定确认消息\n");
    return;
  }
  let userId = "";
  try {
    userId = (JSON.parse(fs.readFileSync(path.join(dataDir, "bound-user.json"), "utf8")) as { userId?: string })
      .userId || "";
  } catch {
    // 无绑定用户
  }
  if (!userId) {
    process.stdout.write("[提示] 暂无绑定用户（首条消息自动绑定），跳过绑定确认消息\n");
    return;
  }
  const { Outbox } = await import("../../notify/outbox.js");
  new Outbox(dataDir).enqueue({
    userId,
    kind: "info",
    text: "✅ 微信 Bot 重新绑定成功，链路已恢复。可直接发送指令（如「帮助」或「任务列表」）。",
  });
  process.stdout.write("[OK] 已向绑定用户发送确认消息（服务 5s 内投递）\n");
}

interface LoginCredentials {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
}

interface LoginApi {
  loadCredentials(): Promise<LoginCredentials | null>;
  saveCredentials(creds: LoginCredentials): Promise<void>;
  clearCredentials(): Promise<void>;
  getQrCode(baseUrl?: string): Promise<{ token: string; url: string }>;
  pollQrStatus(
    token: string,
    baseUrl?: string,
  ): Promise<{ status: string; redirectHost?: string; credentials?: LoginCredentials | null }>;
}

/**
 * force=true（wechat rebind）：先清除已有凭据再进扫码——用于换机接管/凭据失效重登；
 * 同一 bot 账号新登录会顶掉其他机器的旧会话。
 */
export async function wechatLogin(force = false): Promise<number> {
  const authPath = "../../../thirdparties/pi-wechat-assistant/src/bridge/auth.ts";
  const utilsPath = "../../../thirdparties/pi-wechat-assistant/src/shared/utils.ts";
  const auth = (await import(authPath)) as unknown as LoginApi;
  const { renderQrCode } = (await import(utilsPath)) as unknown as {
    renderQrCode: (url: string) => Promise<string>;
  };

  const existing = await auth.loadCredentials();
  if (existing && !force) {
    process.stdout.write(
      [
        `[OK] 已有登录凭据（accountId=${existing.accountId}，userId=${existing.userId}），无需扫码`,
        `凭据位置：~/.pi/agent/wechat-assistant/credentials.json（失效可用 wechat rebind 重新扫码）`,
      ].join("\n") + "\n",
    );
    return 0;
  }
  if (force && existing) {
    await auth.clearCredentials();
    process.stdout.write(
      `[解绑] 已清除旧凭据（accountId=${existing.accountId}），请扫码重新登录（同账号新登录会顶掉其他机器的会话）\n`,
    );
  }

  let baseUrl: string | undefined;
  let first = true;
  let refreshCount = 0;
  let lastStatus: string | null = null;

  for (;;) {
    const qr = await auth.getQrCode(baseUrl);
    const qrText = await renderQrCode(qr.url);
    process.stdout.write(first ? "\n请用（作为 Bot 的）微信扫码登录：\n\n" : "\n二维码已刷新，请重新扫码：\n\n");
    process.stdout.write(qrText + "\n");
    process.stdout.write(`（扫码不便时可用链接）${qr.url}\n\n`);
    first = false;
    lastStatus = null;

    for (;;) {
      await new Promise((r) => setTimeout(r, QR_POLL_MS));
      const result = await auth.pollQrStatus(qr.token, baseUrl);
      if (result.redirectHost) {
        baseUrl = `https://${result.redirectHost}`;
        process.stdout.write(`[redirect] ${baseUrl}\n`);
      }
      if (result.status === lastStatus) continue;
      lastStatus = result.status;

      if (result.status === "scaned") {
        process.stdout.write("已扫码，请在手机上确认登录\n");
        continue;
      }
      if (result.status === "confirmed" && result.credentials) {
        await auth.saveCredentials(result.credentials);
        process.stdout.write(
          [
            `[OK] 登录成功：accountId=${result.credentials.accountId}（凭据已落盘，后续 wechat start 免扫码）`,
            `下一步：pi-workflow wechat start …（发消息的微信无需记 wxid，首条消息自动绑定）`,
          ].join("\n") + "\n",
        );
        // 换绑后运行中的 Bot 进程仍持旧凭据（rebind 典型场景 login_required 已停止重试）：
        // 服务形态自动优雅重启加载新凭据；前台形态提示手动重启（不能替用户杀前台终端进程）
        if (force) {
          await restartServiceAfterRebind();
        }
        // 扫码成功即向绑定用户推送确认消息（rebind 后链路自验证；首次登录无绑定用户自动跳过）
        try {
          await notifyLoginBound(await resolveServiceDataDir());
        } catch (e) {
          process.stdout.write(`[提示] 绑定确认消息发送跳过（${(e as Error).message?.slice(0, 80)}）\n`);
        }
        return 0;
      }
      if (result.status === "expired") {
        refreshCount += 1;
        if (refreshCount >= QR_MAX_REFRESH) {
          process.stderr.write("二维码多次过期，请重跑本命令\n");
          return 1;
        }
        process.stdout.write(`二维码过期，自动刷新 (${refreshCount}/${QR_MAX_REFRESH})\n`);
        break; // 重新取码
      }
      // scaned_but_redirect / waiting：继续轮询
    }
  }
}
