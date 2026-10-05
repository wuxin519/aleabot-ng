/**
 * 统一平台适配接口。
 * 所有 IM 平台（QQ OneBot / KOOK / ...）都实现该接口，
 * 核心引擎只依赖本接口，做到平台无关。
 */
import type { Platform } from '../core/store';

/**
 * 消息段类型（跨平台归一化）。
 *
 * 之所以要保留结构化消息段，而不是只留纯文本：
 *   1. 跑团日志需要记录「这条里有什么」—— @ 了谁、有没有图、是什么表情；
 *   2. 对抗检定（.rav @对手）需要知道被 @ 的人是谁。
 * 早期实现把这些直接删掉了（`replace(/\[CQ:[^\]]+\]/g,'')`），
 * 导致上述两类功能都做不了。
 */
export type SegmentType =
  | 'text'
  | 'at'
  | 'image'
  | 'face'
  | 'reply'
  | 'voice'
  | 'video'
  | 'file'
  | 'other';

/** 一个消息段 */
export interface MessageSegment {
  type: SegmentType;
  /** text：文本内容 */
  text?: string;
  /** at：被 @ 的对象 ID（`all` 表示 @全体成员） */
  targetId?: string;
  /** at：被 @ 的显示名（部分框架会给，没有就回退成 ID） */
  targetName?: string;
  /** image / voice / video / file：文件名或可访问地址 */
  file?: string;
  /** 原始 CQ 码，便于排查 */
  raw?: string;
}

/** 收到的一条消息（已归一化） */
export interface IncomingMessage {
  platform: Platform;
  /** 群/频道 ID（私聊时为空字符串） */
  groupId: string;
  /** 群/频道名称（可选） */
  groupName?: string;
  /** 发送者 ID */
  userId: string;
  /** 发送者昵称 */
  userName?: string;
  /** 消息纯文本（已去除 @ 等；保持原有语义，勿改） */
  text: string;
  /** 是否为私聊 */
  isPrivate: boolean;
  /**
   * 结构化消息段（保留 @ / 图片 / 表情 / 回复等）。
   *
   * ⚠️ 与 `text` 的关系：`text` 仍是「所有 text 段拼起来的纯文本」，
   * 现有全部指令都依赖它，**不要改变它的语义**；`segments` 是额外补充。
   */
  segments?: MessageSegment[];
  /** 消息 ID（OneBot 的 message_id），用于日志去重与引用回复 */
  messageId?: string;
  /** 是否 @ 了机器人自己 */
  mentionsSelf?: boolean;
  /** 原始事件对象，适配器可自行使用 */
  raw?: unknown;
}

/** 适配器事件回调 */
export interface AdapterHandlers {
  onMessage(msg: IncomingMessage): void | Promise<void>;
  onError?(err: Error): void;
  onStatus?(status: AdapterStatus): void;
}

/** 适配器连接状态 */
export interface AdapterStatus {
  platform: Platform;
  online: boolean;
  /** 附加信息（昵称/连接时间等） */
  info?: string;
}

/**
 * 待发送的图片。
 * 三种来源按优先级：
 *   file   本地绝对路径（OneBot 可用 file:// 前缀，需框架开启本地文件转 URL）
 *   url    http(s) 地址
 *   base64 形如 `base64://xxxx` 的内联数据
 */
export interface OutgoingImage {
  file?: string;
  url?: string;
  base64?: string;
}

/**
 * 待发送的消息内容。
 *
 * 之所以不直接传 string，是因为要支持「图片 + 文字」混排：
 * 图片类指令（如 .help）只发图，普通指令只发文字。
 */
export interface OutgoingMessage {
  /** 文本内容（可为空字符串） */
  text?: string;
  /** 图片列表（可为空数组） */
  images?: OutgoingImage[];
}

/** 平台适配器接口 */
export interface PlatformAdapter {
  readonly platform: Platform;
  /** 启动连接 */
  start(): Promise<void>;
  /** 停止连接 */
  stop(): Promise<void>;
  /** 发送群消息（兼容原有纯文本调用） */
  sendGroup(groupId: string, text: string): Promise<void>;
  /** 发送私聊消息（兼容原有纯文本调用） */
  sendPrivate(userId: string, text: string): Promise<void>;
  /** 发送群图文消息（可选，未实现则回退到纯文本） */
  sendGroupRich?(groupId: string, msg: OutgoingMessage): Promise<void>;
  /** 发送私聊图文消息（可选，未实现则回退到纯文本） */
  sendPrivateRich?(userId: string, msg: OutgoingMessage): Promise<void>;
  /**
   * 上传群文件（可选）。跑团日志导出用。
   * 未实现的适配器会被路由层降级为「直接发文本」。
   */
  uploadGroupFile?(groupId: string, filePath: string, name: string): Promise<void>;
  /**
   * 退出指定群（可选）。`.bot bye` 用。
   * 未实现的适配器会被路由层忽略（只发告别语）。
   */
  leaveGroup?(groupId: string): Promise<void>;
  /** 是否在线 */
  isOnline(): boolean;
  /** 当前状态 */
  status(): AdapterStatus;
}
