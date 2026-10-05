/**
 * 适配器管理器：统一管理多平台适配器的启动/停止与消息分发。
 * 核心引擎只在这里被调用一次，平台差异全部收敛在各自适配器中。
 */
import { Engine } from '../core/engine';
import { PlatformAdapter, IncomingMessage, AdapterStatus, OutgoingMessage } from './types';
import { OneBotAdapter } from './onebot';
import { KookAdapter } from './kook';
import * as fs from 'fs';

/** 是否需要私聊回复（把群消息的回复发到发送者私聊） */
export type ReplyRouter = (msg: IncomingMessage, reply: string) => Promise<void>;

export class AdapterManager {
  private adapters: PlatformAdapter[] = [];
  private engine: Engine;
  private statuses = new Map<string, AdapterStatus>();
  private onStatusChange: (s: AdapterStatus) => void;

  constructor(engine: Engine, onStatusChange?: (s: AdapterStatus) => void) {
    this.engine = engine;
    this.onStatusChange = onStatusChange || (() => {});
  }

  /** 按环境变量决定启用哪些平台 */
  async startAll(): Promise<void> {
    const handlers = {
      onMessage: (msg: IncomingMessage) => this.route(msg),
      onError: (err: Error) => {
        console.error(`[adapter] ${err.message}`);
      },
      onStatus: (s: AdapterStatus) => {
        this.statuses.set(s.platform, s);
        this.onStatusChange(s);
        console.log(`[adapter] ${s.platform} ${s.online ? '已连接' : '已断开'} ${s.info || ''}`);
      },
    };

    const enableQQ = (process.env.ONEBOT_ENABLED || 'false').toLowerCase() === 'true';
    const enableKook = (process.env.KOOK_ENABLED || 'false').toLowerCase() === 'true';

    if (enableQQ) {
      const a = new OneBotAdapter(handlers);
      this.adapters.push(a);
      await a.start();
      console.log('[adapter] QQ(OneBot) 适配器已启动');
    } else {
      console.log('[adapter] QQ(OneBot) 未启用（ONEBOT_ENABLED != true）');
    }

    if (enableKook) {
      const a = new KookAdapter(handlers);
      this.adapters.push(a);
      await a.start();
      console.log('[adapter] KOOK 适配器已启动');
    } else {
      console.log('[adapter] KOOK 未启用（KOOK_ENABLED != true）');
    }

    if (this.adapters.length === 0) {
      console.warn('[adapter] 警告：没有启用任何平台适配器，机器人将不会响应消息');
    }
  }

  /** 消息路由：交给引擎，返回回复 */
  private async route(msg: IncomingMessage): Promise<void> {
    const ad = this.adapters.find((a) => a.platform === msg.platform);
    if (!ad) return;

    // 收到消息的入口日志：排查「机器人不响应」时，先看这一行有没有出现
    const where = msg.isPrivate ? '私聊' : `群 ${msg.groupId}`;
    if (process.env.QUIET_LOG !== 'true') {
      console.log(`[msg] 收到 ${msg.platform} ${where} 来自 ${msg.userName}(${msg.userId}): ${msg.text.slice(0, 100)}`);
    }

    const result = await this.engine.handle(msg);
    const hasImages = !!(result && result.images && result.images.length > 0);
    const hasFiles = !!(result && result.files && result.files.length > 0);
    // 无文本、无图片、无文件 = 真的没回复（非指令 / 已忽略）
    if (!result || (!result.reply && !hasImages && !hasFiles)) {
      if (process.env.QUIET_LOG !== 'true') {
        console.log(`[msg] 无回复（非指令或已忽略）: ${msg.text.slice(0, 60)}`);
      }
      return;
    }

    // 群消息默认发群；私聊、或管理员类需要私聊的回复，走私聊
    const toPrivate = msg.isPrivate || !!result.privateReply;

    // 跑团日志导出：先传文件，再发说明文字
    if (hasFiles) {
      await this.sendFiles(ad, msg, result.files!);
    }

    // 暗骰（.rh）：先在群里发一句「正在暗中掷骰」的提示（不含结果），
    // 结果正文走下面的私聊分支发给本人
    if (result.groupHint && !msg.isPrivate) {
      try {
        await ad.sendGroup(msg.groupId, result.groupHint);
      } catch (e) {
        console.error(`[adapter] 暗骰提示发送失败: ${(e as Error).message}`);
      }
    }

    try {
      if (hasImages && ad.sendGroupRich && ad.sendPrivateRich) {
        const payload = { text: result.reply, images: (result.images || []).map((f) => ({ file: f })) };
        if (toPrivate) await ad.sendPrivateRich(msg.userId, payload);
        else await ad.sendGroupRich(msg.groupId, payload);
      } else {
        // 适配器不支持图文（如 KOOK 图片走独立上传流程），降级为纯文本
        if (result.reply) {
          if (toPrivate) await ad.sendPrivate(msg.userId, result.reply);
          else await ad.sendGroup(msg.groupId, result.reply);
        }
      }
      if (process.env.QUIET_LOG !== 'true') {
        const parts: string[] = [];
        if (hasImages) parts.push(`[图片 x${result.images!.length}]`);
        if (hasFiles) parts.push(`[文件 x${result.files!.length}]`);
        console.log(`[msg] 已回复 ${msg.platform} ${where}: ${(parts.join('') + (result.reply || '')).slice(0, 100)}`);
      }
    } catch (e) {
      console.error(`[adapter] 发送回复失败: ${(e as Error).message}`);
      // 图文发送失败时补发一条纯文本，避免用户看到「无响应」
      if (hasImages && result.reply) {
        try {
          if (toPrivate) await ad.sendPrivate(msg.userId, result.reply);
          else await ad.sendGroup(msg.groupId, result.reply);
          console.log('[adapter] 图片发送失败，已降级为纯文本');
        } catch {
          // 二次失败就不再重试了
        }
      }
    }

    // .bot bye：回复发完后再退群，避免「先退了群话没送到」
    if (result.bye && !msg.isPrivate && ad.leaveGroup) {
      try {
        await ad.leaveGroup(msg.groupId);
        console.log(`[adapter] 已按指令退出群 ${msg.groupId}`);
      } catch (e) {
        console.error(`[adapter] 退群失败: ${(e as Error).message}`);
      }
    }
  }

  /**
   * 上传日志导出文件。
   *
   * 三种失败情形都要有兜底，否则用户看到的会是「发了个指令但什么都没发生」：
   *   1. 平台不支持上传（如 KOOK 未实现）→ 直接发文本
   *   2. 私聊 → OneBot 的 upload_group_file 用不了 → 发文本
   *   3. 上传超时/被风控 → 读文件前 60 行发出来
   */
  private async sendFiles(
    ad: PlatformAdapter,
    msg: IncomingMessage,
    files: Array<{ path: string; name: string }>,
  ): Promise<void> {
    for (const f of files) {
      try {
        if (msg.isPrivate) throw new Error('私聊不支持上传文件');
        if (!ad.uploadGroupFile) throw new Error('该平台暂不支持上传文件');
        await ad.uploadGroupFile(msg.groupId, f.path, f.name);
        if (process.env.QUIET_LOG !== 'true') {
          console.log(`[adapter] 已上传文件 ${f.name}`);
        }
      } catch (e) {
        console.error(`[adapter] 上传文件失败: ${(e as Error).message}`);
        try {
          const head = fs.readFileSync(f.path, 'utf-8').split('\n').slice(0, 60).join('\n');
          await ad.sendGroup(msg.groupId, `⚠️ 文件上传失败（${(e as Error).message}），以下为前 60 行：\n\n${head}`);
        } catch {
          // 连文件都读不出来就不再纠缠
        }
      }
    }
  }

  /** 主动发送（供后台/通知使用） */
  async send(platform: string, groupId: string, text: string): Promise<void> {
    const ad = this.adapters.find((a) => a.platform === platform);
    if (!ad) throw new Error(`平台未启用: ${platform}`);
    await ad.sendGroup(groupId, text);
  }

  listStatus(): AdapterStatus[] {
    return this.adapters.map((a) => a.status());
  }

  async stopAll(): Promise<void> {
    for (const a of this.adapters) {
      await a.stop();
    }
    this.adapters = [];
  }
}
