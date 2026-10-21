/**
 * WX-P0 真机登录链路薄验证（P1-T7 前置）：扫码 → 轮询确认 → 凭据落盘 → 收发回显
 *
 * 复用 thirdparties/pi-wechat-assistant 协议层（bridge/auth）与工具层（shared/utils.renderQrCode），
 * 独立 Node 进程运行（路径 B：无 Pi Extension 上下文）。
 * 同时验证：Extension 层工具函数（renderQrCode）与状态存储（state-storage）的独立复用性。
 *
 * 运行（仓库根）：npx tsx dev-examples/wx-m0/login-flow.ts
 * 已有凭据时跳过扫码直接进入收发；Ctrl-C 退出（notifyStop + dispose）。
 */

import {
  getQrCode,
  pollQrStatus,
  loadCredentials,
  saveCredentials,
} from "../../thirdparties/pi-wechat-assistant/src/bridge/auth.js";
import { WeixinClient } from "../../thirdparties/pi-wechat-assistant/src/wechat/client.js";
import { renderQrCode } from "../../thirdparties/pi-wechat-assistant/src/shared/utils.js";

const QR_POLL_MS = 2000;
const QR_MAX_REFRESH = 3;
const RECEIVE_BUDGET_MS = 10 * 60 * 1000; // 收发验证总预算 10 分钟

async function login(): Promise<ReturnType<typeof loadCredentials> extends Promise<infer T> ? T : never> {
  const existing = await loadCredentials();
  if (existing) {
    console.log(`已有登录凭据（accountId=${existing.accountId}），跳过扫码`);
    return existing;
  }

  let baseUrl: string | undefined;
  let token: string;
  let first = true;
  let refreshCount = 0;
  let lastStatus: string | null = null;

  while (true) {
    const qr = await getQrCode(baseUrl);
    token = qr.token;
    const qrText = await renderQrCode(qr.url);
    console.log(first ? "\n请用微信扫码登录：\n" : "\n二维码已刷新，请重新扫码：\n");
    console.log(qrText);
    console.log(`（链接备选）${qr.url}\n`);
    first = false;
    lastStatus = null;

    for (;;) {
      await new Promise((r) => setTimeout(r, QR_POLL_MS));
      const result = await pollQrStatus(token, baseUrl);
      if (result.redirectHost) {
        baseUrl = `https://${result.redirectHost}`;
        console.log(`[redirect] ${baseUrl}`);
      }
      if (result.status === lastStatus) continue;
      lastStatus = result.status;

      if (result.status === "scaned") {
        console.log("已扫码，请在手机上确认登录");
        continue;
      }
      if (result.status === "confirmed" && result.credentials) {
        await saveCredentials(result.credentials);
        console.log(`登录成功：accountId=${result.credentials.accountId}（凭据已落盘）`);
        return result.credentials;
      }
      if (result.status === "expired") {
        refreshCount++;
        if (refreshCount >= QR_MAX_REFRESH) throw new Error("二维码多次过期，请重跑脚本");
        console.log(`二维码过期，刷新 (${refreshCount}/${QR_MAX_REFRESH})`);
        break; // 跳出内层，重新取码
      }
      // scaned_but_redirect / waiting：继续轮询
    }
  }
}

async function main(): Promise<number> {
  const credentials = await login();
  const client = await WeixinClient.create(credentials as never);
  await client.notifyStart();
  console.log(`\nWeixinClient 就绪（accountId=${client.accountId}，userId=${client.userId}）`);
  console.log("用绑定微信给 Bot 发一条消息，会原样回显；Ctrl-C 退出\n");

  let closed = false;
  const onSigint = () => {
    if (closed) return;
    closed = true;
    console.log("\n正在退出（notifyStop + dispose）...");
    void client
      .notifyStop()
      .catch(() => {})
      .then(() => client.dispose())
      .then(() => process.exit(0));
  };
  process.on("SIGINT", onSigint);

  const startedAt = Date.now();
  let received = 0;
  while (!closed) {
    if (Date.now() - startedAt > RECEIVE_BUDGET_MS) {
      console.log("收发验证预算耗尽（10 分钟），退出");
      onSigint();
      return 0;
    }
    const messages = await client.getUpdates();
    for (const m of messages) {
      if (!m.text) continue;
      received++;
      console.log(`[收到#${received}] ${m.userId}: ${m.text}`);
      await client.sendText(m.userId, `[login-flow 回显] ${m.text}`);
      console.log(`[已回复#${received}]`);
    }
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(`[失败] ${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  },
);
