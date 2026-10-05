/**
 * 跑团日志记录器（.lognew 系列）。
 *
 * 设计目标：把「群里发生了什么」按主流骰子（主流骰娘 / Dice!）的约定记下来，
 * 导出的文本可以直接丢进日志染色器（story-painter 一类）或喂给跑团视频工具。
 *
 * 【记录格式：两层符号】
 *
 *   ① 条头：`名字(账号) 时间`
 *      负责切分「谁 · 何时 · 说了什么」。正文**没有结束标记**，
 *      靠「下一个条头出现」界定边界 —— 所以正文里的换行是安全的。
 *
 *   ② 正文前缀：`. / 　( 【 　[CQ:image] 　@名字`
 *      负责切分「这条是什么性质」，染色器靠它做「一键剔除场外 / 隐藏指令」。
 *
 * 【为什么符号要保留】
 *   早期实现在适配器层就把 CQ 码删干净了，结果是：
 *     - 图片变成空字符串 → 日志里看不出「这里发过一张图」
 *     - @ 变成空字符串   → 看不出「他 @ 了谁」
 *   所以这里改为：适配器产出**结构化消息段**，由本模块负责渲染成符号。
 */
import { Store, LogSession, LogMessageRecord, Platform } from './store';
import type { IncomingMessage, MessageSegment } from '../platforms/types';

/** 消息性质 */
export type MessageKind = 'chat' | 'dice' | 'ooc' | 'command' | 'image';

/** 角色（与主流骰娘的 CharItem.role 对齐） */
export type MessageRole = '角色' | '主持人' | '骰子' | '隐藏';

/**
 * 把消息段渲染成日志正文（带符号）。
 *
 * 符号取自 story-painter 的判定规则：
 *   图片 → [图]   表情 → [表情]   语音 → [语音]   视频 → [视频]   文件 → [文件]
 *   @    → @名字（拿不到名字就退回 ID）
 */
export function renderLogBody(text: string, segments?: MessageSegment[]): string {
  if (!segments || segments.length === 0) return (text || '').trim();

  let out = '';
  for (const s of segments) {
    switch (s.type) {
      case 'text':
        out += s.text || '';
        break;
      case 'at':
        if (s.targetId === 'all') out += '@全体成员';
        else out += `@${s.targetName || s.targetId || '某人'}`;
        break;
      case 'image':
        out += '[图]';
        break;
      case 'face':
        out += '[表情]';
        break;
      case 'voice':
        out += '[语音]';
        break;
      case 'video':
        out += '[视频]';
        break;
      case 'file':
        out += '[文件]';
        break;
      case 'reply':
        out += '[回复]';
        break;
      default:
        // other 段没有可读形式，忽略（但要保留 trace 用的 raw 在 segments 里）
        break;
    }
  }

  const rendered = out.trim();
  // 兜底：段里没渲染出任何东西就用纯文本，避免记成空行
  return rendered || (text || '').trim();
}

/**
 * 判定消息性质。
 *
 * ⚠️ 判定顺序很重要：
 *   1. 指令优先 —— `.r` 开头的消息即使带图也是指令
 *   2. 场外（成对的括号开头）
 *   3. 纯图片
 *   4. 其余为普通发言
 *
 * `..` 开头**不算**指令（防止玩家打省略号误触），这是主流实现的共同处理。
 */
export function classifyMessage(text: string, segments?: MessageSegment[]): MessageKind {
  const t = (text || '').trim();
  if (/^[.。/](?![.。/])/.test(t)) return 'command';
  if (/^[（(【]/.test(t)) return 'ooc';
  // 只有「开头就是图片」才算图片消息 —— 与染色器的判定一致
  // （「@某人 你看[图]」这类仍然是普通发言，只是正文里带 [图] 符号）
  const first = segments?.find((s) => !(s.type === 'text' && !(s.text || '').trim()));
  if (first && first.type === 'image') return 'image';
  return 'chat';
}

/** 判定角色 */
export function resolveRole(opts: { isDice?: boolean; isOb?: boolean; isGm?: boolean }): MessageRole {
  if (opts.isDice) return '骰子';
  if (opts.isOb) return '隐藏';
  if (opts.isGm) return '主持人';
  return '角色';
}

/** 两位补零 */
function p2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 时间格式化。
 *
 * 主流骰娘导出用的是 `YYYY/MM/DD HH:mm:ss`（本地时区），
 * 这里保持一致，方便导入染色器后不出现「时间不一样」的错觉。
 */
export function formatTime(ms: number, style: 'slash' | 'dash' = 'slash'): string {
  const d = new Date(ms);
  const date = style === 'slash'
    ? `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`
    : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return `${date} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/**
 * 导出为「QQ 风格」纯文本。
 *
 *    名字(账号) 2026/10/02 20:31:05
 *    我要搜查书架
 *    （空行分隔）
 */
export function exportLogText(session: LogSession, messages: LogMessageRecord[], opts: { header?: boolean } = {}): string {
  const lines: string[] = [];
  if (opts.header !== false) {
    lines.push(`=== 跑团日志：${session.name} ===`);
    lines.push(`群号 ${session.groupId} ｜ 共 ${messages.length} 条 ｜ 创建者 ${session.createdBy || '未知'}`);
    lines.push(`开始 ${formatTime(session.createdAt)}${session.endedAt ? ` ｜ 结束 ${formatTime(session.endedAt)}` : ''}`);
    lines.push('');
  }
  for (const m of messages) {
    const name = m.isDice ? (m.userName || '骰子') : (m.userName || m.userId);
    // 观众（ob）发言在名字前加 ob 前缀 —— 染色器正是靠这个前缀识别隐藏角色
    const shown = m.role === '隐藏' && !name.startsWith('ob') ? `ob${name}` : name;
    const head = m.isDice ? `${shown}` : `${shown}(${m.userId})`;
    lines.push(`${head} ${formatTime(m.createdAt)}`);
    lines.push(m.body);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 导出为**主流骰娘 JSON**格式。
 *
 * story-painter 的 SealDiceLogImporter 只要求：
 *   `items` 存在且 `items[0]` 同时含 `isDice` 与 `message` 两个键。
 * 字段名照抄它的 LogItem 定义，保证能直接被识别。
 *
 * ⚠️ `time` 是**秒**（dayjs.unix），不是毫秒。
 */
export function exportLogJSON(session: LogSession, messages: LogMessageRecord[]): string {
  const items = messages.map((m, i) => {
    const base = m.userName || (m.isDice ? '骰子' : m.userId);
    // 与文本导出保持一致：隐藏角色用 ob 前缀，染色器据此判定 role
    const nickname = m.role === '隐藏' && !base.startsWith('ob') ? `ob${base}` : base;
    return {
      id: i + 1,
      nickname,
      IMUserId: m.userId,
      time: Math.floor(m.createdAt / 1000),
      message: m.body,
      isDice: m.isDice,
      commandId: -1,
      role: m.role || (m.isDice ? '骰子' : '角色'),
      // 自定义扩展（染色器会忽略未知字段，但便于我们自己回溯）
      kind: m.kind,
    };
  });
  return JSON.stringify(
    {
      version: 1,
      name: session.name,
      platform: session.platform,
      groupId: session.groupId,
      createdBy: session.createdBy || '',
      createdAt: session.createdAt,
      endedAt: session.endedAt || 0,
      items,
    },
    null,
    1,
  );
}

/** 日志文件名安全化（去掉路径分隔符与非法字符） */
export function safeFileName(name: string): string {
  const cleaned = (name || '跑团日志').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();
  return cleaned.slice(0, 40) || '跑团日志';
}

/**
 * 记录器：把群消息写进当前进行中的日志。
 *
 * 性能约定：**没有进行中日志的群，捕获过程只做一次带索引的查询即返回**，
 * 不会产生任何写入 —— 否则一个活跃群能把数据库撑爆。
 */
export class Recorder {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** 该用户是否处于观众（ob）模式 */
  isOb(platform: Platform, groupId: string, userId: string): boolean {
    return this.store.getSetting(platform, groupId, `ob:${userId}`) === '1';
  }

  /** 切换观众模式，返回切换后的状态 */
  toggleOb(platform: Platform, groupId: string, userId: string): boolean {
    const next = !this.isOb(platform, groupId, userId);
    this.store.setSetting(platform, groupId, `ob:${userId}`, next ? '1' : '0');
    return next;
  }

  /**
   * 记录一条入站群消息。
   *
   * @param cmdType 已解析出的指令类型；日志控制类指令（.log / .ob）本身不入账，
   *                否则「结束记录」这条指令会变成日志的最后一行。
   */
  capture(msg: IncomingMessage, cmdType?: string): void {
    if (msg.isPrivate) return; // 跑团日志只针对群聊
    if (cmdType && isLogControl(cmdType)) return;

    const session = this.store.getRecordingSession(msg.platform, msg.groupId);
    if (!session) return;

    const body = renderLogBody(msg.text, msg.segments);
    if (!body) return; // 没内容可记（例如纯 reply/文件段）

    const isOb = this.isOb(msg.platform, msg.groupId, msg.userId);
    const kind = classifyMessage(msg.text, msg.segments);

    this.store.addLogMessage({
      sessionId: session.id,
      platform: msg.platform,
      groupId: msg.groupId,
      userId: msg.userId,
      userName: msg.userName,
      kind,
      body,
      isDice: false,
      role: resolveRole({ isOb }),
      messageId: msg.messageId,
      createdAt: Date.now(),
    });
  }

  /** 记录骰子/机器人的输出（主流骰娘的 isDice 语义） */
  captureDice(msg: IncomingMessage, reply: string): void {
    if (msg.isPrivate || !reply) return;
    // 指令图之类只有图片的回复没有文本，不必入账
    if (reply.length > 2000) return;

    const session = this.store.getRecordingSession(msg.platform, msg.groupId);
    if (!session) return;

    this.store.addLogMessage({
      sessionId: session.id,
      platform: msg.platform,
      groupId: msg.groupId,
      userId: 'bot',
      userName: '骰子',
      kind: 'dice',
      body: reply,
      isDice: true,
      role: '骰子',
      createdAt: Date.now(),
    });
  }
}

/** 日志控制类指令：这些指令本身不写进日志正文 */
export function isLogControl(cmdType: string): boolean {
  return cmdType.startsWith('log-') || cmdType === 'ob';
}
