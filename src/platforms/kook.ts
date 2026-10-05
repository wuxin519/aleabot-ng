/**
 * KOOK（开黑啦）适配器
 *
 * 使用 KOOK 官方开放平台 Bot API：
 *   - 通过 /gateway/index 获取 WebSocket 网关地址
 *   - 通过 WebSocket 接收事件（消息）
 *   - 通过 REST API 发送消息（/message/create）
 *
 * 国内可直连、稳定、有官方 API 文档，适合跑团语音社区。
 *
 * 环境变量：
 *   KOOK_TOKEN     机器人 Token（开放平台「机器人」页获取）
 *   KOOK_ENABLED   是否启用
 */
import WebSocket from 'ws';
import { PlatformAdapter, IncomingMessage, AdapterHandlers, AdapterStatus } from './types';

const KOOK_API = 'https://www.kookapp.cn/api/v3';

/** KOOK 事件包结构（精简） */
interface KookPacket {
  s?: number; // 信令：0 事件, 1 hello, 2 ping, 3 pong, 5 reconnect, 6 resume ack
  d?: {
    channel_type?: string; // GROUP / PERSON
    type?: number; // 1 文字 2 图片 9 视频 10 卡片 255 系统
    target_id?: string;
    author_id?: string;
    content?: string;
    msg_id?: string;
    extra?: { author?: { nickname?: string; username?: string }; guild_id?: string; channel_name?: string };
    [k: string]: unknown;
  };
  sn?: number;
}

export class KookAdapter implements PlatformAdapter {
  readonly platform = 'kook' as const;
  private ws?: WebSocket;
  private handlers: AdapterHandlers;
  private token: string;
  private online = false;
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private sessionId = '';
  private lastSn = 0;
  private reconnectDelay = 3000;
  /** 网关限速：记录上次发送时间 */
  private lastSendAt = 0;

  constructor(handlers: AdapterHandlers) {
    this.handlers = handlers;
    this.token = process.env.KOOK_TOKEN || '';
  }

  status(): AdapterStatus {
    return { platform: this.platform, online: this.online, info: this.sessionId ? `session:${this.sessionId.slice(0, 8)}` : '' };
  }

  isOnline(): boolean {
    return this.online;
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (!this.token) {
      this.handlers.onError?.(new Error('KOOK_TOKEN 未配置，KOOK 适配器不会启动'));
      return;
    }
    await this.connect();
  }

  /** 获取网关地址并连接 */
  private async connect(): Promise<void> {
    try {
      const res = await fetch(`${KOOK_API}/gateway/index?compress=0`, {
        headers: { Authorization: `Bot ${this.token}` },
      });
      const json = (await res.json()) as { code: number; message: string; data?: { url: string } };
      if (json.code !== 0 || !json.data?.url) {
        throw new Error(`获取 KOOK 网关失败: ${json.code} ${json.message}`);
      }
      this.openWs(json.data.url);
    } catch (e) {
      this.handlers.onError?.(e as Error);
      this.scheduleReconnect();
    }
  }

  private openWs(url: string): void {
    this.ws = new WebSocket(url);
    this.ws.on('open', () => {
      this.online = true;
      this.reconnectDelay = 3000;
      this.handlers.onStatus?.(this.status());
      // 若已有 session，尝试恢复
      if (this.sessionId && this.lastSn > 0) {
        this.ws?.send(JSON.stringify({ s: 6, d: { token: this.token, session_id: this.sessionId, sn: this.lastSn } }));
      } else {
        this.ws?.send(JSON.stringify({ s: 2, sn: this.lastSn, d: null })); // ping
      }
    });
    this.ws.on('message', (data: WebSocket.RawData) => this.handleRaw(data.toString()));
    this.ws.on('close', () => {
      this.online = false;
      this.handlers.onStatus?.(this.status());
      this.clearTimers();
      this.scheduleReconnect();
    });
    this.ws.on('error', (err) => this.handlers.onError?.(err as Error));
  }

  private handleRaw(raw: string): void {
    let pkt: KookPacket;
    try {
      pkt = JSON.parse(raw) as KookPacket;
    } catch {
      return;
    }
    if (typeof pkt.sn === 'number') this.lastSn = pkt.sn;

    switch (pkt.s) {
      case 1: {
        // hello：开始心跳
        const interval = ((pkt.d as { code?: number } | undefined) as unknown as { heartbeat_interval?: number })?.heartbeat_interval;
        this.startHeartbeat(interval && interval > 0 ? interval : 30000);
        break;
      }
      case 0:
        // 事件
        this.handleEvent(pkt);
        break;
      case 3:
        // pong：无需处理
        break;
      case 5:
        // 要求重连
        this.ws?.close();
        break;
      case 6:
        // resume ack：恢复成功
        break;
      default:
        break;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ s: 2, sn: this.lastSn, d: null }));
      }
    }, Math.max(5000, intervalMs));
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
  }

  private handleEvent(pkt: KookPacket): void {
    const d = pkt.d;
    if (!d) return;
    // 只处理文字消息（type=1）
    if (d.type !== 1) return;
    if (!d.content) return;

    const isPrivate = d.channel_type === 'PERSON';
    const text = d.content.replace(/\(met\)\d+\(met\)/g, '').trim(); // 去除 @提及标记

    const msg: IncomingMessage = {
      platform: 'kook',
      groupId: isPrivate ? '' : String(d.target_id || ''),
      groupName: d.extra?.channel_name,
      userId: String(d.author_id || ''),
      userName: d.extra?.author?.nickname || d.extra?.author?.username || String(d.author_id || ''),
      text,
      isPrivate,
      raw: d,
    };
    this.handlers.onMessage(msg);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
      this.sessionId = '';
      this.lastSn = 0;
      void this.connect();
    }, this.reconnectDelay);
  }

  /** KOOK 发消息有频率限制（默认 5 秒 5 条），做简单节流 */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastSendAt;
    const minGap = 250; // 保守 250ms
    if (elapsed < minGap) {
      await new Promise((r) => setTimeout(r, minGap - elapsed));
    }
    this.lastSendAt = Date.now();
  }

  private async postMessage(body: Record<string, unknown>): Promise<void> {
    await this.throttle();
    const res = await fetch(`${KOOK_API}/message/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { code: number; message: string };
    if (json.code !== 0) {
      throw new Error(`KOOK 发送失败: ${json.code} ${json.message}`);
    }
  }

  async sendGroup(groupId: string, text: string): Promise<void> {
    await this.postMessage({ target_id: groupId, type: 9, content: text });
  }

  async sendPrivate(userId: string, text: string): Promise<void> {
    // KOOK 私聊使用 type=9（KMarkdown），target_id 为用户 ID
    await this.postMessage({ target_id: userId, type: 9, content: text });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = undefined;
    }
    this.online = false;
    this.handlers.onStatus?.(this.status());
  }
}
