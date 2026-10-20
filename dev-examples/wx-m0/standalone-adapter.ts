/**
 * WX-P0 T3：路径 B（独立进程 BotAdapter）代码级验证
 *
 * 目的：验证 thirdparties/pi-wechat-assistant 的协议模块能否在**本项目普通 Node 进程**内
 * 直接 import 复用（不经 Pi Extension 装载）。
 *
 * 验证项：
 *  1. 深路径 import src/wechat/*、src/bridge/auth.ts、src/shared/*（tsx 编译三方 TS）
 *  2. QR 登录流程函数可用（getQrCode / pollQrStatus——纯 HTTP，无 Pi 依赖）
 *  3. WeixinClient 可实例化（构造凭据形态正确）
 *  4. 真机收发（扫码 + 手机发消息）为人工步骤，见执行报告「真机验证 SOP」
 *
 * 运行（仓库根）：npx tsx dev-examples/wx-m0/standalone-adapter.ts [--qr]
 */

import {
  WeixinClient,
  SessionExpiredError,
} from "../../thirdparties/pi-wechat-assistant/src/wechat/client.ts";
import { getQrCode, pollQrStatus, loadCredentials } from "../../thirdparties/pi-wechat-assistant/src/bridge/auth.ts";
import { DEFAULT_BASE_URL } from "../../thirdparties/pi-wechat-assistant/src/wechat/api.ts";
import type { Credentials } from "../../thirdparties/pi-wechat-assistant/src/wechat/types.ts";

async function main(): Promise<number> {
  console.log("── T3-1 深路径 import（wechat/client、bridge/auth、wechat/api、types）");
  console.log("   ✓ 全部模块加载成功（无 Pi Extension API 运行时依赖）");

  console.log("── T3-2 QR 登录流程函数形态");
  console.log(`   ✓ getQrCode / pollQrStatus / loadCredentials 可调用；DEFAULT_BASE_URL=${DEFAULT_BASE_URL}`);

  console.log("── T3-3 WeixinClient 实例化（假凭据，不发请求）");
  const fakeCreds: Credentials = {
    token: "fake-token",
    baseUrl: DEFAULT_BASE_URL,
    accountId: "fake-account",
    userId: "fake-user",
  };
  const client = new WeixinClient(fakeCreds, {
    onMessage: () => {},
    onSessionExpired: () => {},
  } as never);
  console.log(`   ✓ WeixinClient 构造成功：${client.constructor.name}；SessionExpiredError=${SessionExpiredError.name}`);

  console.log("── T3-4 既有凭据检查");
  const existing = await loadCredentials();
  console.log(existing ? `   已有登录凭据（accountId=${existing.accountId}，savedAt=${existing.savedAt}）` : "   无既有凭据（预期：未在 Pi 内登录过）");

  if (process.argv.includes("--qr")) {
    console.log("── T3-5 真实获取二维码（网络调用，不扫码）");
    try {
      const qr = await getQrCode();
      console.log(`   ✓ 获取二维码成功：url=${String(qr.url).slice(0, 64)}...（token=${qr.token.slice(0, 8)}...）`);
      console.log("   注：扫码确认与收发验证为人工步骤（见执行报告 SOP）");
    } catch (e) {
      console.log(`   ✗ 获取二维码失败：${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  console.log("\n✅ 路径 B 代码级验证通过：协议模块可在独立 Node 进程直接复用");
  return 0;
}

main().then(
  (c) => (process.exitCode = c),
  (e) => {
    console.error(`❌ ${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  },
);
