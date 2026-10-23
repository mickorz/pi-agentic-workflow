/**
 * BotAdapter 契约（WG-001）+ 微信实现（LK-01 路径 B：复用 pi-wechat-assistant 协议模块）
 * LK-03/LK-05 默认：绑定用户过滤、messageId 幂等、chat 回固定话术。
 * P2（WG-006/007，A17）：会话过期自动退避重连；stop() 只停 Bot，不触碰任何 Run（停止≠取消）。
 *
 * WeixinClient 对接（2026-10-21 真机修正）：
 *   真实 API 为「静态工厂 create(credentials) + 拉模式 getUpdates(signal) + sendText」，
 *   私有构造不可直接 new、也不存在 onMessage 回调注入——收信必须自驱动轮询循环。
 */

import type { BotInboundMessage } from "../../contracts/wx.js";

export interface BotAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (message: BotInboundMessage) => Promise<void>): void;
  send(userId: string, text: string): Promise<void>;
}

export interface ReconnectOptions {
  /** 最大重连尝试次数（缺省 5；0 = 不自动重连） */
  maxRetries?: number;
  /** 退避基数毫秒（缺省 5s，指数递增） */
  backoffMs?: number;
}

/** 最小客户端接口（与 WeixinClient 真实 API 同构；测试 fake 按此实现） */
export interface WechatClientLike {
  sendText(toUserId: string, text: string): Promise<unknown>;
  getUpdates(signal?: AbortSignal): Promise<
    Array<{ messageId: string; userId: string; text?: string; contextToken?: string; timestamp?: Date }>
  >;
  dispose?(): Promise<void>;
}

export interface WechatBotAdapterOptions {
  allowedUserIds?: string[];
  /** 无 allowedUserIds 时：首个发消息的用户自动绑定为唯一授权用户（免记 wxid） */
  autoBindFirstUser?: boolean;
  /** 自动绑定发生时回调（持久化/横幅用） */
  onUserBound?: (userId: string) => void;
  /** 客户端工厂（测试注入 fake；真实缺省走凭据 + WeixinClient.create） */
  clientFactory?: () => Promise<WechatClientLike>;
  /** 断线重连策略 */
  reconnect?: ReconnectOptions;
  /** 状态回调（审计/观测用） */
  onStatus?: (status: "connected" | "reconnecting" | "stopped", attempt?: number) => void;
  /** 每轮成功拉取后的心跳回调（F11 健康判定用；长轮询阻塞时不频笛） */
  onPollOk?: () => void;
  /** 轮询空批时的节流间隔（缺省 200ms；真实长轮询 40s 一次，fake 立返防 busy-loop） */
  pollIdleMs?: number;
}

/** 微信 BotAdapter：包装 WeixinClient（凭据来自 ~/.pi/agent/wechat-assistant/credentials.json） */
export class WechatBotAdapter implements BotAdapter {
  private handler?: (message: BotInboundMessage) => Promise<void>;
  private client?: WechatClientLike;
  private stopped = true;
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private pollController?: AbortController;
  private pollLoop?: Promise<void>;

  constructor(private readonly options: WechatBotAdapterOptions = {}) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempt = 0;
    await this.connect();
    this.options.onStatus?.("connected");
    this.startPolling();
  }

  /** WG-007：停止 Bot ≠ 取消 Run。仅关闭本 Gateway（停轮询 + dispose），不改任何任务状态。 */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.pollController?.abort();
    const client = this.client;
    this.client = undefined;
    await client?.dispose?.().catch(() => undefined);
    this.options.onStatus?.("stopped");
  }

  onMessage(handler: (message: BotInboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(userId: string, text: string): Promise<void> {
    if (!this.client) throw new Error("Bot 未启动");
    await this.client.sendText(userId, text);
  }

  /** WG-006：会话过期 → 指数退避重连（凭据失效最终停在 stopped，可人工重新扫码 SOP） */
  handleSessionExpired(): void {
    if (this.stopped) return;
    const { maxRetries = 5, backoffMs = 5000 } = this.options.reconnect ?? {};
    if (this.reconnectAttempt >= maxRetries) {
      this.client = undefined;
      this.options.onStatus?.("stopped", this.reconnectAttempt);
      return;
    }
    this.pollController?.abort();
    this.reconnectAttempt += 1;
    const delay = backoffMs * 2 ** (this.reconnectAttempt - 1);
    this.options.onStatus?.("reconnecting", this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      void (async () => {
        try {
          await this.connect();
          this.reconnectAttempt = 0; // 重连成功重置计数
          this.options.onStatus?.("connected");
          this.startPolling();
        } catch {
          this.handleSessionExpired(); // 继续退避
        }
      })();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** 拉模式收信循环：getUpdates 长轮询 → 绑定用户过滤 → 幂等键交给上层 Inbox */
  private startPolling(): void {
    const client = this.client;
    if (!client) return;
    this.pollController = new AbortController();
    const { signal } = this.pollController;
    this.pollLoop = (async () => {
      while (!this.stopped && this.client === client) {
        let messages: Awaited<ReturnType<WechatClientLike["getUpdates"]>> = [];
        try {
          messages = await client.getUpdates(signal);
        } catch (e) {
          if (this.stopped || signal.aborted) break;
          if (e instanceof Error && e.name === "SessionExpiredError") {
            this.handleSessionExpired();
            break;
          }
          // 传输层瞬时错误（网络抖动/长轮询超时）：退避 1s 后继续
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        this.options.onPollOk?.();
        for (const incoming of messages) {
          if (!this.handler) continue;
          // 免记 wxid：无白名单且开启自动绑定 → 首个发消息用户成为唯一授权用户
          if (!this.options.allowedUserIds?.length && this.options.autoBindFirstUser) {
            this.options.allowedUserIds = [incoming.userId];
            this.options.onUserBound?.(incoming.userId);
          }
          // WG-002：绑定用户过滤
          if (this.options.allowedUserIds && !this.options.allowedUserIds.includes(incoming.userId)) continue;
          const text = (incoming.text ?? "").trim();
          if (!text) continue;
          await this.handler({
            channel: "wechat",
            userId: incoming.userId,
            messageId: incoming.messageId,
            text,
            receivedAt: (incoming.timestamp ?? new Date()).toISOString(),
          });
        }
        if (messages.length === 0) {
          // 空批节流：真实客户端长轮询自然阻塞；fake/异常场景防 busy-loop
          await new Promise((r) => setTimeout(r, this.options.pollIdleMs ?? 200));
        }
      }
    })();
  }

  private async connect(): Promise<void> {
    // 测试注入：fake 客户端不依赖真机凭据
    if (this.options.clientFactory) {
      this.client = await this.options.clientFactory();
      return;
    }
    const authPath = "../../../thirdparties/pi-wechat-assistant/src/bridge/auth.ts";
    const { loadCredentials } = (await import(authPath)) as {
      loadCredentials: () => Promise<{ token: string; baseUrl: string; accountId: string; userId: string } | null>;
    };
    const creds = await loadCredentials();
    if (!creds) throw new Error("无微信凭据：先执行真机登录（npx tsx dev-examples/wx-m0/login-flow.ts）扫码登录");
    const modPath = "../../../thirdparties/pi-wechat-assistant/src/wechat/client.ts";
    const { WeixinClient } = (await import(/* @vite-ignore */ modPath)) as {
      WeixinClient: { create: (creds: unknown) => Promise<WechatClientLike> };
    };
    this.client = await WeixinClient.create(creds);
  }
}

/** chat 固定话术（LK-05：chat 默认关闭） */
export const CHAT_FALLBACK_REPLY =
  "我是工作流助手，暂不支持闲聊。可说「分析 <github 仓库地址>」这类指令，或回复「帮助」查看可用流程。";
