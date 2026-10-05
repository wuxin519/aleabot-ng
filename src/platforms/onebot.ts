/**
 * OneBot 11 适配器（用于 QQ 接入）
 *
 * 通过 WebSocket **客户端**模式连接 OneBot 实现（如 NapCat / Lagrange / go-cqhttp）。
 * 这是目前最稳定的 QQ 机器人方案：登录/风控由 OneBot 框架负责，
 * 本项目只做消息收发，不碰 QQ 协议本身（规避 oicq 一类逆向方案的不稳定）。
 *
 * 环境变量：
 *   ONEBOT_WS_URL    如 ws://127.0.0.1:3001 （NapCat 默认 3001 反向 WS）
 *   ONEBOT_TOKEN     可选，OneBot 配置的 access_token
 *   ONEBOT_ENABLED   是否启用（true/false）
 *
 * 若是「正向 WS」（本项目连过去）用 ONEBOT_WS_URL；
 * 若是「反向 WS」（框架连过来）则由框架配置指向本项目（见 POST 模式说明）。
 */
import WebSocket from 'ws';
import {
  PlatformAdapter, IncomingMessage, AdapterHandlers, AdapterStatus, OutgoingMessage,
  MessageSegment, SegmentType,
} from './types';

/**
 * CQ 码里的字符实体反转义。
 * OneBot 规定 `,` `[` `]` `&` 在参数里必须转义，取出来要还原。
 */
function decodeCQ(s: string): string {
  return s
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

/** 把 OneBot 段类型收敛到我们自己的类型集合 */
function normalizeSegmentType(t: string): SegmentType {
  switch (t) {
    case 'text': return 'text';
    case 'at': return 'at';
    case 'image': return 'image';
    case 'face': return 'face';
    case 'reply': return 'reply';
    case 'record': return 'voice';
    case 'video': return 'video';
    case 'file': return 'file';
    default: return 'other';
  }
}

/** 由 type + data 构造一个消息段 */
function toSegment(type: string, data: Record<string, unknown>): MessageSegment {
  const st = normalizeSegmentType(type);
  const seg: MessageSegment = { type: st };
  switch (st) {
    case 'text':
      seg.text = String(data.text ?? '');
      break;
    case 'at':
      seg.targetId = String(data.qq ?? '');
      // NapCat / Lagrange 通常会给 name 字段（就是群名片）
      if (data.name !== undefined) seg.targetName = String(data.name);
      break;
    case 'reply':
      seg.targetId = String(data.id ?? '');
      break;
    default:
      if (data.file !== undefined) seg.file = String(data.file);
      if (data.url !== undefined) seg.file = seg.file || String(data.url);
      break;
  }
  return seg;
}

/**
 * 解析 CQ 码字符串为消息段数组。
 *
 * 注意：这里**不再丢弃** CQ 码，而是转成结构化段。
 * 纯文本仍然由调用方从 text 段拼接得到，语义与以前一致。
 */
function parseCQString(raw: string): MessageSegment[] {
  const segs: MessageSegment[] = [];
  const re = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) {
      const t = raw.slice(last, m.index);
      if (t) segs.push({ type: 'text', text: decodeCQ(t) });
    }
    const data: Record<string, unknown> = {};
    const paramStr = m[2].startsWith(',') ? m[2].slice(1) : m[2];
    if (paramStr) {
      for (const kv of paramStr.split(',')) {
        const eq = kv.indexOf('=');
        if (eq > 0) data[kv.slice(0, eq)] = decodeCQ(kv.slice(eq + 1));
      }
    }
    segs.push(toSegment(m[1], data));
    last = re.lastIndex;
  }
  if (last < raw.length) {
    const t = raw.slice(last);
    if (t) segs.push({ type: 'text', text: decodeCQ(t) });
  }
  return segs;
}

/** OneBot 11 事件结构（精简） */
interface OneBotEvent {
  post_type?: string;
  message_type?: 'private' | 'group';
  sub_type?: string;
  message_id?: number;
  user_id?: number;
  group_id?: number;
  raw_message?: string;
  message?: unknown;
  sender?: { nickname?: string; card?: string; user_id?: number };
  self_id?: number;
  [k: string]: unknown;
}

export class OneBotAdapter implements PlatformAdapter {
  readonly platform = 'qq' as const;
  private ws?: WebSocket;
  private handlers: AdapterHandlers;
  private url: string;
  private token: string;
  private online = false;
  private selfId = '';
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelay = 3000;
  /** 回声ID自增 */
  private echoSeq = 1;
  /** 待响应的 API 调用 */
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(handlers: AdapterHandlers) {
    this.handlers = handlers;
    this.url = process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001';
    this.token = process.env.ONEBOT_TOKEN || '';
  }

  status(): AdapterStatus {
    return { platform: this.platform, online: this.online, info: this.selfId ? `QQ:${this.selfId}` : '' };
  }

  isOnline(): boolean {
    return this.online;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    const headers: Record<string, string> = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    try {
      this.ws = new WebSocket(this.url, { headers });
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws.on('open', () => {
      this.online = true;
      this.reconnectDelay = 3000;
      this.handlers.onStatus?.(this.status());
    });
    this.ws.on('message', (data: WebSocket.RawData) => {
      this.handleRaw(data.toString());
    });
    this.ws.on('close', () => {
      this.online = false;
      this.handlers.onStatus?.(this.status());
      this.scheduleReconnect();
    });
    this.ws.on('error', (err) => {
      this.handlers.onError?.(err as Error);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      // 指数退避，上限 30s
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
      this.connect();
    }, this.reconnectDelay);
  }

  /** 处理来自 OneBot 的原始消息（事件 or API 响应） */
  private handleRaw(raw: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    // API 响应：带 echo 字段
    if (data.echo !== undefined && typeof data.echo === 'string') {
      const pending = this.pending.get(data.echo);
      if (pending) {
        this.pending.delete(data.echo);
        clearTimeout(pending.timer);
        if (data.status === 'ok' || data.retcode === 0) {
          pending.resolve(data.data);
        } else {
          pending.reject(new Error(`OneBot API 失败: ${data.status || data.retcode} ${data.message || ''}`));
        }
      }
      return;
    }
    const ev = data as OneBotEvent;
    if (ev.post_type === 'meta_event' && ev.meta_event_type === 'lifecycle') {
      this.selfId = String(ev.self_id || '');
      this.handlers.onStatus?.(this.status());
      return;
    }
    if (ev.post_type === 'message') {
      const msg = this.normalize(ev);
      if (msg) this.handlers.onMessage(msg);
    }
  }

  /** 把 OneBot 消息事件归一化 */
  private normalize(ev: OneBotEvent): IncomingMessage | null {
    const type = ev.message_type;
    if (!type) return null;

    // 兜底：某些实现对机器人自己发的消息也会推 message 事件。
    // 若不拦掉，跑团日志会把机器人回复记两遍，指令也可能自问自答。
    const selfIdRaw = String(ev.self_id || this.selfId || '');
    if (selfIdRaw && String(ev.user_id || '') === selfIdRaw) return null;

    const { text, segments } = this.parseMessage(ev);
    // 纯文本与消息段都为空 → 没有可处理的内容
    if (!text && segments.length === 0) return null;

    const selfId = selfIdRaw;
    const mentionsSelf = !!selfId && segments.some((s) => s.type === 'at' && s.targetId === selfId);
    const messageId = ev.message_id !== undefined ? String(ev.message_id) : undefined;

    if (type === 'group') {
      return {
        platform: 'qq',
        groupId: String(ev.group_id || ''),
        groupName: undefined,
        userId: String(ev.user_id || ''),
        userName: ev.sender?.card || ev.sender?.nickname || String(ev.user_id || ''),
        text,
        isPrivate: false,
        segments,
        messageId,
        mentionsSelf,
        raw: ev,
      };
    }
    // 私聊
    return {
      platform: 'qq',
      groupId: '',
      userId: String(ev.user_id || ''),
      userName: ev.sender?.nickname || String(ev.user_id || ''),
      text,
      isPrivate: true,
      segments,
      messageId,
      mentionsSelf,
      raw: ev,
    };
  }

  /**
   * 解析消息：同时给出「纯文本」与「结构化消息段」。
   *
   * 优先用 `message` 数组（信息最全，@ 段通常带 name）；
   * 只有 CQ 字符串时才自己解析 `raw_message`。
   * 纯文本仍等于「所有 text 段拼接」，与旧实现保持一致。
   */
  private parseMessage(ev: OneBotEvent): { text: string; segments: MessageSegment[] } {
    let segments: MessageSegment[] = [];
    const arr = ev.message;
    if (Array.isArray(arr)) {
      for (const raw of arr) {
        if (!raw || typeof raw !== 'object') continue;
        const t = String((raw as { type?: unknown }).type || '');
        if (!t) continue;
        const d = ((raw as { data?: Record<string, unknown> }).data || {}) as Record<string, unknown>;
        segments.push(toSegment(t, d));
      }
    } else if (typeof ev.raw_message === 'string') {
      segments = parseCQString(ev.raw_message);
    }

    let text = segments.filter((s) => s.type === 'text').map((s) => s.text || '').join('');

    // 兜底：数组存在但一个 text 段都没解出来，而 raw_message 有内容 → 退回 CQ 解析
    if (!text.trim() && Array.isArray(arr) && typeof ev.raw_message === 'string' && ev.raw_message) {
      const alt = parseCQString(ev.raw_message);
      const altText = alt.filter((s) => s.type === 'text').map((s) => s.text || '').join('');
      if (altText.trim()) {
        segments = alt;
        text = altText;
      }
    }

    return { text: text.trim(), segments };
  }

  /** 调用 OneBot API（带回声匹配） */
  private callApi(action: string, params: Record<string, unknown>, timeoutMs = 10000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('OneBot 未连接'));
        return;
      }
      const echo = `alea-${this.echoSeq++}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot API 超时: ${action}`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  async sendGroup(groupId: string, text: string): Promise<void> {
    await this.callApi('send_group_msg', { group_id: Number(groupId), message: text });
  }

  async sendPrivate(userId: string, text: string): Promise<void> {
    await this.callApi('send_private_msg', { user_id: Number(userId), message: text });
  }

  /**
   * 把 OutgoingMessage 组装为 OneBot 消息段数组。
   *
   * 图片统一用 file:// 前缀（NapCat / go-cqhttp 均识别），
   * 相比 base64 内联更省带宽、更不易触发发送超时。
   */
  private buildSegments(msg: OutgoingMessage): unknown[] {
    const segs: unknown[] = [];
    if (msg.text) segs.push({ type: 'text', data: { text: msg.text } });
    for (const img of msg.images || []) {
      const raw = img.file || img.url || img.base64 || '';
      if (!raw) continue;
      // 纯本地路径补 file:// 前缀；已是 file/http/base64/data 前缀的原样透传
      const file = img.file && !/^(file|http|base64|data):/i.test(raw) ? `file://${raw}` : raw;
      segs.push({ type: 'image', data: { file } });
    }
    return segs;
  }

  async sendGroupRich(groupId: string, msg: OutgoingMessage): Promise<void> {
    const segs = this.buildSegments(msg);
    if (segs.length === 0) return;
    // 只有文本时退化为纯字符串，兼容性最好
    const onlyText = segs.length === 1 && (segs[0] as { type: string }).type === 'text';
    await this.callApi('send_group_msg', {
      group_id: Number(groupId),
      message: onlyText ? msg.text || '' : segs,
    });
  }

  async sendPrivateRich(userId: string, msg: OutgoingMessage): Promise<void> {
    const segs = this.buildSegments(msg);
    if (segs.length === 0) return;
    const onlyText = segs.length === 1 && (segs[0] as { type: string }).type === 'text';
    await this.callApi('send_private_msg', {
      user_id: Number(userId),
      message: onlyText ? msg.text || '' : segs,
    });
  }

  /**
   * 上传群文件（跑团日志导出）。
   *
   * `file` 必须是 **OneBot 框架所在机器** 上能读到的绝对路径；
   * 本项目与 NapCat 同机部署，所以直接给本地路径即可。
   * 上传大文件可能较慢，超时放宽到 60s。
   */
  async uploadGroupFile(groupId: string, filePath: string, name: string): Promise<void> {
    await this.callApi(
      'upload_group_file',
      { group_id: Number(groupId), file: filePath, name, folder: '' },
      60000,
    );
  }

  /**
   * 退出指定群（OneBot `set_group_leave`）。`.bot bye` 用。
   */
  async leaveGroup(groupId: string): Promise<void> {
    await this.callApi('set_group_leave', { group_id: Number(groupId) }, 15000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('连接已关闭'));
    }
    this.pending.clear();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = undefined;
    }
    this.online = false;
    this.handlers.onStatus?.(this.status());
  }
}
