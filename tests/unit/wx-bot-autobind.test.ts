/**
 * 免记 wxid：BotAdapter 首消息自动绑定（autoBindFirstUser）
 * - 无白名单 + autoBind → 首个发消息用户成为唯一授权用户，其余后续用户被过滤
 * - 显式 allowedUserIds 存在时不触发自动绑定
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { WechatBotAdapter } from "../../src/gateway/wechat/bot-adapter.js";
import type { BotInboundMessage } from "../../src/contracts/wx.js";

function msg(userId: string, messageId: string): { userId: string; messageId: string; text: string; timestamp: Date } {
  return { userId, messageId, text: `hi-${messageId}`, timestamp: new Date() };
}

test("自动绑定：首个发消息用户成为唯一授权用户，后续他人被过滤", async () => {
  const queue: Array<Array<ReturnType<typeof msg>>> = [
    [msg("wxid_alice", "m1")],
    [msg("wxid_bob", "m2")], // 非绑定用户 → 过滤
    [msg("wxid_alice", "m3")], // 绑定用户 → 放行
  ];
  const adapter = new WechatBotAdapter({
    clientFactory: async () => ({
      sendText: async () => undefined,
      getUpdates: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return queue.shift() ?? [];
      },
    }),
    pollIdleMs: 1,
    autoBindFirstUser: true,
  });
  const received: BotInboundMessage[] = [];
  const bound: string[] = [];
  adapter.onMessage(async (m) => {
    received.push(m);
  });
  // @ts-expect-error 测试观察回调（不入公共接口）
  adapter.options.onUserBound = (u: string) => bound.push(u);

  await adapter.start();
  await new Promise((r) => setTimeout(r, 80));
  await adapter.stop();

  assert.deepEqual(bound, ["wxid_alice"], "首消息触发一次绑定回调");
  assert.deepEqual(
    received.map((m) => m.userId),
    ["wxid_alice", "wxid_alice"],
    "bob 被过滤，alice 后续消息放行",
  );
});

test("显式白名单存在时不触发自动绑定", async () => {
  const queue: Array<Array<ReturnType<typeof msg>>> = [
    [msg("wxid_bob", "m1")], // 不在白名单 → 直接过滤（不自动绑定）
  ];
  const adapter = new WechatBotAdapter({
    clientFactory: async () => ({
      sendText: async () => undefined,
      getUpdates: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return queue.shift() ?? [];
      },
    }),
    pollIdleMs: 1,
    allowedUserIds: ["wxid_alice"],
    autoBindFirstUser: true,
  });
  const received: BotInboundMessage[] = [];
  adapter.onMessage(async (m) => {
    received.push(m);
  });
  await adapter.start();
  await new Promise((r) => setTimeout(r, 60));
  await adapter.stop();
  assert.equal(received.length, 0, "白名单优先，bob 被过滤");
});
