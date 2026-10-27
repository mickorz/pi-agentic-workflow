/**
 * MockWechatClient（P1.6 / V8-mock）：wechat start --mock-client 的测试客户端。
 *
 * 实现 WechatClientLike 同构接口，替代真实 WeixinClient：
 *   - getUpdates(): 追读 <dataDir>/mock-inbox.jsonl 新增行（游标推进；驱动脚本负责追加消息）
 *   - sendText():  追加 <dataDir>/mock-outbox.jsonl（驱动脚本 tail 之，自动批准/断言）
 *
 * 除传输层外全链真实：绑定过滤、messageId 幂等、授权门、checkpoint 确认通道、
 * dispatch/agent 会话、执行器——与真机唯一差异是消息进出走本地文件而非微信协议。
 * 驱动脚本：dev-examples/manual-test/wechat-mock-driver.py
 */
import fs from "node:fs";
import path from "node:path";
import type { WechatClientLike } from "./bot-adapter.js";

interface MockInboundEntry {
  userId?: string;
  text?: string;
  /** 可选；缺省自动生成（mock-<ts>-<n>），Inbox 幂等键唯一即可 */
  messageId?: string;
}

export class MockWechatClient implements WechatClientLike {
  private readonly inboxFile: string;
  private readonly outboxFile: string;
  private cursor = 0;
  private seq = 0;

  constructor(dataDir: string) {
    this.inboxFile = path.join(dataDir, "mock-inbox.jsonl");
    this.outboxFile = path.join(dataDir, "mock-outbox.jsonl");
    fs.mkdirSync(dataDir, { recursive: true });
  }

  async sendText(toUserId: string, text: string): Promise<unknown> {
    const entry = {
      outboxId: `ob-mock-${Date.now()}-${this.seq++}`,
      toUserId,
      text,
      at: new Date().toISOString(),
    };
    fs.appendFileSync(this.outboxFile, JSON.stringify(entry) + "\n", "utf8");
    return { ok: true };
  }

  async getUpdates(_signal?: AbortSignal): Promise<
    Array<{ messageId: string; userId: string; text?: string; timestamp?: Date }>
  > {
    if (!fs.existsSync(this.inboxFile)) return [];
    const raw = fs.readFileSync(this.inboxFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const fresh = lines.slice(this.cursor);
    this.cursor = lines.length;
    void _signal;
    return fresh.map((line, i) => {
      let entry: MockInboundEntry = {};
      try {
        entry = JSON.parse(line) as MockInboundEntry;
      } catch {
        // 非 JSON 行按整行文本处理（驱动脚本可以偷懒 echo >> ）
        entry = { text: line };
      }
      return {
        messageId: entry.messageId ?? `mock-${Date.now()}-${this.seq++}-${i}`,
        userId: entry.userId ?? "mock-user",
        text: entry.text ?? "",
        timestamp: new Date(),
      };
    });
  }
}
