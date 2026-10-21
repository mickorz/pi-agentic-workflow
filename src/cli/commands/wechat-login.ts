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

const QR_POLL_MS = 2000;
const QR_MAX_REFRESH = 5;

interface LoginCredentials {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
}

interface LoginApi {
  loadCredentials(): Promise<LoginCredentials | null>;
  saveCredentials(creds: LoginCredentials): Promise<void>;
  getQrCode(baseUrl?: string): Promise<{ token: string; url: string }>;
  pollQrStatus(
    token: string,
    baseUrl?: string,
  ): Promise<{ status: string; redirectHost?: string; credentials?: LoginCredentials | null }>;
}

export async function wechatLogin(): Promise<number> {
  const authPath = "../../../thirdparties/pi-wechat-assistant/src/bridge/auth.ts";
  const utilsPath = "../../../thirdparties/pi-wechat-assistant/src/shared/utils.ts";
  const auth = (await import(authPath)) as unknown as LoginApi;
  const { renderQrCode } = (await import(utilsPath)) as unknown as {
    renderQrCode: (url: string) => Promise<string>;
  };

  const existing = await auth.loadCredentials();
  if (existing) {
    process.stdout.write(
      [
        `✅ 已有登录凭据（accountId=${existing.accountId}，userId=${existing.userId}），无需扫码`,
        `凭据位置：~/.pi/agent/wechat-assistant/credentials.json（失效可删除后重跑本命令重新扫码）`,
      ].join("\n") + "\n",
    );
    return 0;
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
            `✅ 登录成功：accountId=${result.credentials.accountId}（凭据已落盘，后续 wechat start 免扫码）`,
            `下一步：pi-workflow wechat start …（发消息的微信无需记 wxid，首条消息自动绑定）`,
          ].join("\n") + "\n",
        );
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
