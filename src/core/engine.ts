/**
 * 业务引擎：接收归一化消息，解析命令、执行骰点/角色卡/先攻等逻辑，
 * 返回待发送的回复文本，并负责写日志。
 * 与平台无关（只依赖 IncomingMessage）。
 */
import { Store, Platform, LogSession, SheetRecord } from '../core/store';
import * as path from 'path';
import * as fs from 'fs';
import { parseCommand, HELP_TEXT, ParsedCommand, parseMultiCheck, MultiCheckSpec } from '../core/command';
import { rollExpression, cocCheck, rollCOCBonus, formatCOCBonus, COC_RULES } from '../core/dice';
import { generateCOC, generateCOC5, generateDND, renderSheet, attributeOrder, rollMainAttributes, mainAttributesMeta, COC7_ORDER, CharacterSheet } from '../core/sheet';
import { RandomFn, defaultRandom } from '../core/random';
import {
  MADNESS_IMMEDIATE, MADNESS_LONGTERM, MadnessEntry,
  NAME_TABLES, NameLang,
  CARD_DECKS, DECK_ALIAS,
  COC_SKILL_BASE, KEYWORDS,
} from '../core/tables';
import {
  Recorder, exportLogText, exportLogJSON, safeFileName, formatTime, isLogControl,
} from '../core/recorder';
import type { IncomingMessage } from '../platforms/types';

/** 引擎处理结果 */
export interface EngineResult {
  /** 回复文本（为空表示不回复） */
  reply: string;
  /** 是否需要发送到私聊（管理员备份等） */
  privateReply?: boolean;
  /**
   * 暗骰用：群里只发这段「提示」（不含结果），真正的结果走 reply + privateReply 私聊。
   * 为空表示没有群内提示需求。
   */
  groupHint?: string;
  /** 置 true 表示发完这条回复后退出当前群（.bot bye） */
  bye?: boolean;
  /**
   * 随回复一起发送的图片。
   * 支持本地绝对路径（适配器会补 file:// 前缀）或 http 地址。
   * 发送失败时适配器会降级为只发文本。
   */
  images?: string[];
  /**
   * 随回复一起发送的文件（跑团日志导出）。
   * 适配器不支持上传文件时会降级为「把内容截断成文本发出去」。
   */
  files?: Array<{ path: string; name: string }>;
}

/** 咕咕文案池 */
const GUGU_TEXTS = [
  '咕咕咕——（展翅）',
  '咕！（理直气壮地甩锅给网络）',
  '咕咕？（歪头，表示怀疑）',
  '咕咕咕咕咕咕……（试图用鸽语念咒）',
  '今日份的咕，已顺丰包邮送达。',
  '鸽了。不是不想跑，是这周真的有事。',
  '（一只鸽子从头顶飞过，留下一片羽毛）咕——',
  '骰娘也要休息的嘛，咕。这是法定摸鱼时间。',
  '咕咕！听说有人想让我加班？不存在的。',
  '本鸽已就位，但骰子它自己滚走了……咕。',
  '咕咕咕（叼着一张塔罗牌飞走了）',
  '鸽王登基，无需多言。',
];

/**
 * FNV-1a 字符串哈希（32 位）。
 *
 * 用于「今日人品」这种需要**同一天同一人结果固定**的场景 ——
 * 不能用 this.rng，因为随机源每次都不同，同一天会算出不同结果。
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * 生成进度条文本。
 * 注意 value > 0 时至少点亮一格 —— 否则人品 1~4 会渲染成一条全空的进度条，
 * 看起来像「没有结果」。
 */
function bar(value: number, max = 100, segments = 10): string {
  const raw = Math.round((value / max) * segments);
  const filled = value <= 0 ? 0 : Math.max(1, Math.min(segments, raw));
  return '█'.repeat(filled) + '░'.repeat(segments - filled);
}

/** 今日人品类运势：标题 + 一句话签语（按分数段） */
function jrrpFortune(v: number): { title: string; line: string } {
  if (v === 100) return { title: '🌟 天选之人', line: '今日诸事皆顺，连走路都能捡到钱——你是被命运盖章偏爱的崽。' };
  if (v >= 90) return { title: '🔥 锦鲤附体', line: '好运像开了挂，想做的事都能成。大胆冲，今天你最大。' };
  if (v >= 75) return { title: '🌿 小确幸日', line: '没啥大波折，反而处处是惊喜。宜掷骰、约会、以及理直气壮地摸鱼。' };
  if (v >= 50) return { title: '⚖️ 风平浪静', line: '不功不过的一天，稳稳当当就很好。宜按部就班，忌平地起波澜。' };
  if (v >= 30) return { title: '🌫️ 阴有小雨', line: '运气有点打瞌睡，出门记得带伞（物理的+心理的）。宜低调，忌冲动上头。' };
  if (v >= 10) return { title: '🌀 水逆预警', line: '今天诸事不宜硬刚。重要决定先往后推，先当一只安静的咸鱼。' };
  return { title: '💤 装死模式', line: '今日宜躺平、宜装死、宜把手机调成飞行模式。不出门就是最大的幸运。' };
}

/** 今日宜 / 忌（按日期+用户固定，避免每次刷新都变） */
const JRRP_YI = ['掷骰', '表白', '吃火锅', '睡懒觉', '买彩票', '出门浪', '怼老板', '肝游戏', '约饭', '听歌发呆'];
const JRRP_JI = ['冲动消费', '立 flag', '熬夜修仙', '和人对线', '开新坑', '信锦鲤', '删好友', '替人担保', '大扫除', '自拍发群'];
/** 幸运色 / 幸运物 */
const JRRP_COLORS = ['正红', '鎏金', '雾蓝', '薄荷绿', '樱粉', '曜石黑', '奶白', '葡萄紫', '落日橙', '松石绿'];
const JRRP_ITEMS = ['一枚旧硬币', '四叶草', '猫的尾巴尖', '半块橡皮', '幸运骰子', '一颗草莓糖', '羽毛笔', '迷你罗盘', '彩虹软糖', '护身符'];
/** 今日诗词（意象偏明快开阔，作 .jrrp 收尾；按日期+用户固定） */
const JRRP_POEMS = [
  '「海上生明月，天涯共此时」——张九龄',
  '「春风得意马蹄疾，一日看尽长安花」——孟郊',
  '「长风破浪会有时，直挂云帆济沧海」——李白',
  '「莫愁前路无知己，天下谁人不识君」——高适',
  '「明月松间照，清泉石上流」——王维',
  '「采菊东篱下，悠然见南山」——陶渊明',
  '「星垂平野阔，月涌大江流」——杜甫',
  '「落霞与孤鹜齐飞，秋水共长天一色」——王勃',
  '「晴空一鹤排云上，便引诗情到碧霄」——刘禹锡',
  '「稻花香里说丰年，听取蛙声一片」——辛弃疾',
  '「绿蚁新醅酒，红泥小火炉」——白居易',
  '「人闲桂花落，夜静春山空」——王维',
  '「天阶夜色凉如水，卧看牵牛织女星」——杜牧',
  '「接天莲叶无穷碧，映日荷花别样红」——杨万里',
  '「竹外桃花三两枝，春江水暖鸭先知」——苏轼',
  '「沾衣欲湿杏花雨，吹面不寒杨柳风」——志南',
  '「晚来天欲雪，能饮一杯无」——白居易',
  '「疏影横斜水清浅，暗香浮动月黄昏」——林逋',
  '「小舟从此逝，江海寄余生」——苏轼',
  '「我见青山多妩媚，料青山见我应如是」——辛弃疾',
];

/** 日志状态的中文说法 */
function sessionStatusText(status: LogSession['status']): string {
  if (status === 'recording') return '记录中';
  if (status === 'paused') return '已暂停';
  return '已结束';
}

/** 参数里是否要求导出 JSON（主流骰娘格式） */
function wantsJson(args: string[]): boolean {
  return args.some((a) => /^(json|js|json格式)$/i.test(a));
}

/**
 * 计算一个骰点表达式的**最大可能值**（理智大失败按最大值扣减用）。
 * 只支持我们引擎的加减形式：1d6+2 → 8、2d6 → 12、3 → 3、1d6-1 → 5。
 */
function maxOfDiceExpr(expr: string): number {
  let max = 0;
  for (const tok of expr.match(/[+-]?[^+-]+/g) || []) {
    const sign = tok.startsWith('-') ? -1 : 1;
    const term = tok.replace(/^[+-]/, '');
    const dm = /^(\d*)[dD](\d+)$/.exec(term);
    if (dm) {
      const n = dm[1] ? parseInt(dm[1], 10) : 1;
      max += sign * n * parseInt(dm[2], 10);
    } else if (/^\d+$/.test(term)) {
      max += sign * parseInt(term, 10);
    }
  }
  return Math.max(0, max);
}

export class Engine {
  private store: Store;
  private rng: RandomFn;
  /** 管理员 ID 集合（QQ 号或 KOOK 用户 ID），可在配置中指定 */
  private admins: Set<string>;
  /** 备份目录 */
  private backupDir: string;
  /** 跑团日志导出目录 */
  private logDir: string;
  /** 跑团日志记录器 */
  readonly recorder: Recorder;

  constructor(store: Store, opts?: { rng?: RandomFn; admins?: string[]; backupDir?: string; logDir?: string }) {
    this.store = store;
    this.rng = opts?.rng || defaultRandom;
    this.admins = new Set(opts?.admins || []);
    this.backupDir = opts?.backupDir || 'data/backups';
    this.logDir = opts?.logDir || process.env.ALEABOT_LOG_DIR || path.join(process.cwd(), 'data', 'logs');
    this.recorder = new Recorder(store);
  }

  /** 判断是否管理员 */
  isAdmin(userId: string): boolean {
    return this.admins.has(userId);
  }

  /**
   * 是否可以管理跑团日志。
   *
   * ⚠️ 特意做了「未配置管理员则不限制」的处理：如果群里没配 ADMIN_IDS，
   * 严格校验会让 .log 完全无法使用（等于功能被锁死）。
   * 一旦配置了 ADMIN_IDS，就恢复为仅管理员可操作。
   */
  private canManageLog(msg: IncomingMessage): boolean {
    if (this.admins.size === 0) return true;
    return this.isAdmin(msg.userId);
  }

  /** 取当前群的前缀（默认 "."） */
  private prefixOf(platform: Platform, groupId: string): string {
    return this.store.getSetting(platform, groupId, 'prefix', '.') || '.';
  }

  /** 取当前群的默认骰 */
  private defaultDiceOf(platform: Platform, groupId: string): string {
    return this.store.getSetting(platform, groupId, 'defaultDice', '1d100') || '1d100';
  }

  /**
   * 玩家展示名 = 角色卡名字（即玩家的昵称），无则回落平台昵称。
   * 角色卡名字与玩家昵称是同一个东西：用 `.st name <名字>` / `.sn <名字>` 设置后，
   * 这里取到的就是昵称，下游所有回复署名、日志、角色卡生成都会自动用它。
   */
  private playerName(msg: IncomingMessage): string {
    const rec = this.store.getSheet(msg.platform, msg.userId);
    if (rec?.data) {
      try {
        const sheet = JSON.parse(rec.data) as { name?: string };
        if (sheet.name && sheet.name.trim()) return sheet.name.trim();
      } catch {
        /* 角色卡损坏则忽略，回落平台昵称 */
      }
    }
    return msg.userName || '';
  }

  /** 处理一条消息，返回回复 */
  async handle(msg: IncomingMessage): Promise<EngineResult | null> {
    const prefix = this.prefixOf(msg.platform, msg.groupId);
    const cmd = parseCommand(msg.text, prefix);

    // 展示名：角色卡名字即玩家昵称，统一在这里取一次并包装进消息，
    // 这样后续所有回复署名、日志、角色卡生成都会自动用昵称（无需逐行改）。
    const displayName = this.playerName(msg);
    const m: IncomingMessage = displayName ? { ...msg, userName: displayName } : msg;

    // 群停用状态（.bot off）：只响应 .bot on（恢复开关由管理员或配置者掌握），
    // 其余指令一律静默忽略 —— 骰娘「被打瞌睡」时的标准行为。
    const enabled = this.store.getSetting(msg.platform, msg.groupId, 'botEnabled', 'true') !== 'false';
    if (!enabled && cmd?.type !== 'bot' && cmd?.type !== 'set' && cmd?.type !== 'backup') {
      return null;
    }

    // 跑团日志：先记账再处理（否则「记录中」的消息会漏掉指令本身）
    try {
      this.recorder.capture(m, cmd?.type);
    } catch (e) {
      // 记录失败绝不能影响正常指令
      console.error(`[log] 记录消息失败: ${(e as Error).message}`);
    }

    if (!cmd) return null;

    let result: EngineResult;
    try {
      result = await this.dispatch(m, cmd);
    } catch (e) {
      result = { reply: `⚠️ 出错: ${(e as Error).message}` };
    }

    // 骰子的输出也入账（主流骰娘的 isDice 语义），这样日志里「掷了什么」和
    // 「谁在说话」会对得上
    try {
      if (result.reply && !isLogControl(cmd.type)) {
        this.recorder.captureDice(m, result.reply);
      }
    } catch (e) {
      console.error(`[log] 记录骰点失败: ${(e as Error).message}`);
    }

    return result;
  }

  private async dispatch(msg: IncomingMessage, cmd: ParsedCommand): Promise<EngineResult> {
    switch (cmd.type) {
      // ---------- 掷骰 ----------
      case 'roll':
        return this.doRoll(msg, cmd.args.join(''));
      case 'roll-hidden':
        return this.doRoll(msg, cmd.args.join(''), true);
      case 'roll-default':
        return this.doRoll(msg, this.defaultDiceOf(msg.platform, msg.groupId));
      case 'roll-bonus':
        return this.doBonusCheck(msg, cmd.args, 'bonus');
      case 'roll-penalty':
        return this.doBonusCheck(msg, cmd.args, 'penalty');

      // ---------- COC 检定 ----------
      case 'check':
        return this.doCheck(msg, cmd.args);
      case 'check-rc':
        return this.doCheck(msg, cmd.args, 0);
      case 'growth':
        return this.doGrowth(msg, cmd.args);
      case 'madness-ti':
        return this.doMadness(msg, 'ti');
      case 'madness-li':
        return this.doMadness(msg, 'li');
      case 'sc':
        return this.doSc(msg, cmd.args);
      case 'setcoc':
        return this.doSetcoc(msg, cmd.args);
      case 'hp':
        return this.doHpSan(msg, 'hp', cmd.args);
      case 'san':
        return this.doHpSan(msg, 'san', cmd.args);

      // ---------- 角色卡 ----------
      case 'coc':
        return this.doGenSheet(msg, 'coc7', cmd.args);
      case 'coc5':
        return this.doGenSheet(msg, 'coc5', cmd.args);
      case 'dnd':
        return this.doGenSheet(msg, 'dnd5e', cmd.args);
      case 'st-set':
        return this.doStSet(msg, cmd.args);
      case 'st-show':
        return this.doStShow(msg, cmd.args);
      case 'st-new':
        return this.doStNew(msg, cmd.args);
      case 'st-switch':
        return this.doStSwitch(msg, cmd.args);
      case 'st-list':
        return this.doStList(msg);
      case 'st-clr':
        return this.doStClr(msg);
      case 'st-delattr':
        return this.doStDelAttr(msg, cmd.args);
      case 'st-export':
        return this.doStExport(msg);
      case 'st-expr':
        return this.doStExpr(msg, cmd.args);
      case 'pc':
        return this.doPc(msg, cmd.args);
      case 'ri':
        return this.doRi(msg, cmd.args);

      // ---------- 先攻 ----------
      case 'init-add':
        return this.doInitAdd(msg, cmd.args);
      case 'init-list':
        return this.doInitList(msg);
      case 'init-clear':
        this.store.clearInitiative(msg.platform, msg.groupId);
        return { reply: '🧹 先攻列表已清空' };

      // ---------- 跑团工具 ----------
      case 'draw':
        return this.doDraw(msg, cmd.args);
      case 'drawlist':
        return this.doDrawlist();
      case 'name':
        return this.doName(cmd.args);
      case 'who':
        return this.doWho(cmd.args);

      // ---------- 统计与娱乐 ----------
      case 'stat':
        return this.doStat(msg, cmd.args, false);
      case 'hiy':
        return this.doStat(msg, cmd.args, true);
      case 'jrrp':
        return this.doJrrp(msg);
      case 'gugu':
        return this.doGugu();
      case 'coin':
        return this.doCoin(msg, cmd.args);

      // ---------- 骰子开关 ----------
      case 'bot':
        return this.doBot(msg, cmd.args);

      // ---------- 查询与帮助 ----------
      case 'help':
        return this.doHelp();
      case 'help-kw':
        return this.doHelpKeyword(cmd.args);

      // ---------- 跑团日志 ----------
      case 'log-new':
        return this.doLogNew(msg, cmd.args);
      case 'log-on':
        return this.doLogSetRecording(msg, true);
      case 'log-off':
        return this.doLogSetRecording(msg, false);
      case 'log-end':
        return this.doLogEnd(msg, cmd.args);
      case 'log-status':
        return this.doLogStatus(msg);
      case 'log-list':
        return this.doLogList(msg);
      case 'log-get':
        return this.doLogGet(msg, cmd.args);
      case 'log-del':
        return this.doLogDel(msg, cmd.args);
      case 'log-stat':
        return this.doLogStat(msg);
      case 'ob':
        return this.doOb(msg);

      // ---------- 管理 ----------
      case 'set':
        return this.doSet(msg, cmd.args);
      case 'backup': {
        if (!this.isAdmin(msg.userId)) return { reply: '⛔ 只有管理员可以执行备份' };
        const file = await this.store.backup(this.backupDir);
        return { reply: `💾 备份完成: ${file}`, privateReply: true };
      }
      default:
        return { reply: `❓ 未知指令「${cmd.verb}」，发送 ${this.prefixOf(msg.platform, msg.groupId)}help 查看帮助` };
    }
  }

  // ==================== 帮助 ====================

  /**
   * 帮助：优先回指令图。
   *
   * 图片路径查找顺序（取第一个真实存在的文件）：
   *   1. 环境变量 HELP_IMAGE（方便不改代码换图）
   *   2. cwd/public/help.png           —— 后台可管理的位置，也是部署默认位置
   *                                       （在后台「帮助图片」页上传就是换这个文件）
   *   3. cwd/docs/指令图.png            —— 源码仓库里的原始产出
   *   4. cwd/../docs/指令图.png         —— 从 dist/ 运行时向上找一层
   *
   * 图片不存在（未部署）时自动降级为纯文字帮助，保证 .help 永远有响应。
   */
  private doHelp(): EngineResult {
    const candidates = [
      process.env.HELP_IMAGE || '',
      path.join(process.cwd(), 'public', 'help.png'),
      path.join(process.cwd(), 'docs', '指令图.png'),
      path.join(process.cwd(), '..', 'docs', '指令图.png'),
    ].filter(Boolean);

    for (const p of candidates) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).size > 0) {
          // 注意：这里不能缓存文件内容 —— 后台换图后必须立刻生效
          return { reply: '', images: [p] };
        }
      } catch {
        // 单个候选路径异常不影响后续尝试
      }
    }

    // 兜底：没有图片就发文字表
    return { reply: HELP_TEXT };
  }

  /**
   * `.help <词条>` —— 轻量规则速查。
   *
   * 不依赖外部规则库，先用内置的「规则词条 + 技能基础值」两张表顶住；
   * 后续若要接完整规则书，只需替换 tables.ts 里的 KEYWORDS。
   */
  private doHelpKeyword(args: string[]): EngineResult {
    const kw = args.join('').trim();
    if (!kw) {
      return { reply: '用法: .help <词条>\n例: .help 成功等级 / .help 侦查 / .help 技能基础值' };
    }

    // 1. 规则词条精确命中
    if (KEYWORDS[kw]) return { reply: KEYWORDS[kw] };

    // 2. 技能基础值精确命中
    if (COC_SKILL_BASE[kw] !== undefined) {
      return {
        reply: `【技能】${kw}\n基础值: ${COC_SKILL_BASE[kw]}%\n提示: 发送 .ra ${kw} ${COC_SKILL_BASE[kw]} 可直接检定`,
      };
    }

    // 3. 模糊匹配，给出候选
    const fuzzy = [
      ...Object.keys(KEYWORDS).filter((k) => k.includes(kw) || kw.includes(k)),
      ...Object.keys(COC_SKILL_BASE).filter((k) => k.includes(kw) || kw.includes(k)),
    ];
    if (fuzzy.length > 0) {
      return {
        reply: `没有「${kw}」这个条目，你是不是想找:\n${fuzzy.slice(0, 10).map((x) => `· ${x}`).join('\n')}\n发送 .help <词条> 即可查询`,
      };
    }

    return {
      reply: `没有找到词条「${kw}」。\n可用规则词条: ${Object.keys(KEYWORDS).join(' ')}\n也可以直接输入技能名，如 .help 侦查`,
    };
  }

  // ==================== 掷骰 ====================

  /** 掷骰 */
  /** 取群默认骰的面数（"1d100" → 100，`.r d` 省略面数时用它） */
  private defaultSidesOf(platform: Platform, groupId: string): number {
    const m = /d(\d+)/i.exec(this.defaultDiceOf(platform, groupId));
    return m ? parseInt(m[1], 10) : 100;
  }

  /** 取群房规号（.setcoc 设置，默认 0） */
  /** 读群房规（0-5 或 'dg'） */
  private cocRulesOf(platform: Platform, groupId: string): number | string {
    const v = (this.store.getSetting(platform, groupId, 'cocRules', '0') || '0').toLowerCase();
    if (v === 'dg') return 'dg';
    const n = parseInt(v, 10);
    return [0, 1, 2, 3, 4, 5].includes(n) ? n : 0;
  }

  /**
   * 掷骰：.r 3d6+2（v1.2 支持多轮 `3#`、暗骰 .rh、群默认面数）
   * @param hidden true = 暗骰（群里只提示，结果私聊）
   */
  private doRoll(msg: IncomingMessage, expr: string, hidden = false): EngineResult {
    if (msg.isPrivate && hidden) {
      return { reply: '⚠️ 暗骰只在群里有意义（私聊本来就是只有你看得到）' };
    }
    const name = msg.userName ? `【${msg.userName}】` : '';
    const sides = this.defaultSidesOf(msg.platform, msg.groupId);
    const cleaned = expr.trim();

    if (!cleaned) {
      // .r 无参数 → 掷默认骰
      return this.doRoll(msg, this.defaultDiceOf(msg.platform, msg.groupId), hidden);
    }

    // 保存的表达式：.r 手枪伤害（由 .st &手枪伤害=1d6+1 定义）
    const savedExpr = this.lookupExpression(msg, cleaned);
    if (savedExpr) {
      try {
        const r = rollExpression(savedExpr, this.rng, sides, this.cocRulesOf(msg.platform, msg.groupId));
        this.store.addLog({
          platform: msg.platform, groupId: msg.groupId, groupName: msg.groupName,
          userId: msg.userId, userName: msg.userName,
          expression: cleaned, total: r.total,
          detail: `${cleaned}=${savedExpr} → ${r.detail}`, createdAt: Date.now(),
        });
        const reply = `🎲 ${name}${cleaned} = ${r.total}\n[${cleaned}=${savedExpr}] ${r.detail}`;
        if (hidden) return { reply, privateReply: true, groupHint: `🎲 ${name}正在暗中掷骰…` };
        return { reply };
      } catch {
        return { reply: `表达式「${cleaned}」有误：${savedExpr}` };
      }
    }

    // `.r b` / `.r b3` / `.r p4`：主流骰娘写法，直接掷一次带奖励/惩罚的 D100（不做技能检定）
    const bp = /^([bp])(\d*)$/i.exec(cleaned);
    if (bp) {
      const r = rollCOCBonus(bp[2] ? parseInt(bp[2], 10) : 1, bp[1].toLowerCase() === 'b' ? 'bonus' : 'penalty', this.rng);
      const detail = formatCOCBonus(r);
      this.store.addLog({
        platform: msg.platform, groupId: msg.groupId, groupName: msg.groupName,
        userId: msg.userId, userName: msg.userName,
        expression: cleaned, total: r.value, detail, createdAt: Date.now(),
      });
      const reply = `🎲 ${name}${cleaned} = ${r.value}\n${detail}`;
      if (hidden) return { reply, privateReply: true, groupHint: `🎲 ${name}正在暗中掷骰…` };
      return { reply };
    }

    // 多轮掷骰：`3#2d50` = 掷 3 次 2d50（上限 20 次，防刷屏）
    const multi = /^(\d+)#(.+)$/.exec(cleaned);
    if (multi) {
      const times = Math.min(20, Math.max(1, parseInt(multi[1], 10)));
      const subExpr = multi[2];
      if (!subExpr) return { reply: '用法: .r 3#2d50（# 前是次数，后面是表达式）' };

      const lines: string[] = [];
      let sum = 0;
      for (let i = 0; i < times; i++) {
        const result = rollExpression(subExpr, this.rng, sides, this.cocRulesOf(msg.platform, msg.groupId));
        sum += result.total;
        lines.push(`${i + 1}. ${subExpr}=${result.total}  ${result.detail}`);
        this.store.addLog({
          platform: msg.platform, groupId: msg.groupId, groupName: msg.groupName,
          userId: msg.userId, userName: msg.userName,
          expression: subExpr, total: result.total, detail: result.detail, createdAt: Date.now(),
        });
      }
      const reply = `🎲 ${name}掷骰${times}次 (合计 ${sum}):\n${lines.join('\n')}`;
      if (hidden) return { reply, privateReply: true, groupHint: `🎲 ${name}正在暗中掷骰${times}次…` };
      return { reply };
    }

    // 普通单次掷骰
    const result = rollExpression(cleaned, this.rng, sides, this.cocRulesOf(msg.platform, msg.groupId));
    this.store.addLog({
      platform: msg.platform,
      groupId: msg.groupId,
      groupName: msg.groupName,
      userId: msg.userId,
      userName: msg.userName,
      expression: cleaned,
      total: result.total,
      detail: result.detail,
      createdAt: Date.now(),
      lines: result.groups.map((g) => ({ raw: g.raw, rolls: g.rolls, kept: g.kept, subtotal: g.subtotal })),
    });
    const reply = `🎲 ${name}${cleaned} = ${result.total}\n${result.detail}`;
    if (hidden) return { reply, privateReply: true, groupHint: `🎲 ${name}正在暗中掷骰…` };
    return { reply };
  }

  // ==================== COC 检定 ====================

  /** COC 检定：.ra 侦查 60 / .ra 侦查 / .ra 3#p手枪
   *  forceRule: .rc 传 0（规则书检定，忽略群房规）；.ra 传 undefined（读房规） */
  private doCheck(msg: IncomingMessage, args: string[], forceRule?: number): EngineResult {
    if (args.length === 0) {
      return {
        reply: [
          '用法: .ra <技能名|表达式> [目标值]',
          '例: .ra 侦查 60 / .ra 60 / .ra 侦查（读角色卡）',
          '调整: .ra 侦查+10 / .ra 困难侦查（难度前缀）',
          '多列: .ra 3#p手枪（3 次，带惩罚骰）',
          forceRule === 0 ? '当前是 .rc 规则书检定（大成功/大失败按规则书，不看房规）' : '',
        ].filter(Boolean).join('\n'),
      };
    }

    // 多列检定语法只看第一个参数（如 .ra 3#p手枪），
    // 不能把全部参数拼起来 —— 那样会把「技能名」和「目标值」粘死成 "侦查55"
    const multi = parseMultiCheck(args[0]);
    if (multi) {
      const restParts = [multi.rest, ...args.slice(1)].filter(Boolean);
      return this.doMultiCheck(msg, multi, restParts, forceRule);
    }

    const resolved = this.resolveCheckTarget(msg, args);
    if ('error' in resolved) return { reply: resolved.error };

    const r = this.performCheck(msg, resolved.skillName, resolved.target, undefined, resolved.difficulty, forceRule);
    const name = msg.userName ? `【${msg.userName}】` : '';
    return { reply: this.checkReply(name, resolved.skillName, resolved.target, r) };
  }

  /** 奖励骰 / 惩罚骰检定（.rb / .rp） */
  private doBonusCheck(msg: IncomingMessage, args: string[], mode: 'bonus' | 'penalty'): EngineResult {
    const name = msg.userName ? `【${msg.userName}】` : '';
    const modeText = mode === 'bonus' ? '奖励骰' : '惩罚骰';

    // 无参数：只掷一次带奖励/惩罚的 D100，不做技能检定
    if (args.length === 0) {
      const r = rollCOCBonus(1, mode, this.rng);
      const detail = formatCOCBonus(r);
      this.store.addLog({
        platform: msg.platform,
        groupId: msg.groupId,
        groupName: msg.groupName,
        userId: msg.userId,
        userName: msg.userName,
        expression: mode === 'bonus' ? 'rb' : 'rp',
        total: r.value,
        detail,
        createdAt: Date.now(),
      });
      return { reply: `🎲 ${name}${modeText} 1d100 = ${r.value}\n${detail}` };
    }

    const resolved = this.resolveCheckTarget(msg, args);
    if ('error' in resolved) return { reply: resolved.error };

    const r = this.performCheck(msg, resolved.skillName, resolved.target, { mode, count: 1 }, resolved.difficulty);
    const need = resolved.difficulty ? `（需${r.needLevel}）` : '';
    const icon = r.success ? '✅' : '❌';
    return {
      reply: `${icon} ${name}${resolved.skillName}检定(${modeText})${need}: 1d100 = ${r.rollValue} / ${resolved.target} → ${r.level}${r.bonusDetail}`,
    };
  }

  /** 多列检定：.ra 3#p手枪 */
  private doMultiCheck(msg: IncomingMessage, spec: MultiCheckSpec, restParts: string[], forceRule?: number): EngineResult {
    if (restParts.length === 0) {
      return { reply: '用法: .ra 3#p手枪\n3# 为重复次数，p 惩罚骰 / b 奖励骰，之后跟技能名' };
    }

    const resolved = this.resolveCheckTarget(msg, restParts);
    if ('error' in resolved) return { reply: resolved.error };

    const bonus = spec.bonus
      ? { mode: (spec.bonus === 'b' ? 'bonus' : 'penalty') as 'bonus' | 'penalty', count: spec.bonusCount }
      : undefined;
    const tag = spec.bonus
      ? `（${spec.bonus === 'b' ? '奖励骰' : '惩罚骰'}×${spec.bonusCount}）`
      : '';
    const name = msg.userName ? `【${msg.userName}】` : '';

    const lines: string[] = [`🎯 ${name}${resolved.skillName} 连发 ×${spec.times}${tag}`];
    for (let i = 0; i < spec.times; i++) {
      const r = this.performCheck(msg, resolved.skillName, resolved.target, bonus, resolved.difficulty, forceRule);
      const icon = r.success ? '✅' : '❌';
      const need = resolved.difficulty ? `(需${r.needLevel})` : '';
      lines.push(`  ${i + 1}. ${icon} 1d100 = ${r.rollValue} / ${resolved.target} → ${r.level} ${need}`);
    }
    return { reply: lines.join('\n') };
  }

  /**
   * 执行一次检定（可选带奖励/惩罚骰），写日志并返回结构化结果。
   */
  private performCheck(
    msg: IncomingMessage,
    skillName: string,
    target: number,
    bonus?: { mode: 'bonus' | 'penalty'; count: number },
    difficulty?: string,
    forceRule?: number,
  ): { rollValue: number; level: string; success: boolean; bonusDetail: string; needLevel: string } {
    let rollValue: number;
    let bonusDetail = '';

    if (bonus) {
      const r = rollCOCBonus(bonus.count, bonus.mode, this.rng);
      rollValue = r.value;
      bonusDetail = `\n${formatCOCBonus(r)}`;
    } else {
      // 1..100
      rollValue = Math.floor(this.rng() * 100) + 1;
    }

    // .rc 强制用规则书房规(0)，.ra 读群房规
    const rule = forceRule !== undefined ? forceRule : this.cocRulesOf(msg.platform, msg.groupId);
    const check = cocCheck(rollValue, target, rule);

    // 难度前缀：只把「达到指定等级」才算成功（主流骰娘 `.ra 困难侦查`）
    //   困难 = 判定线 ÷2、极难 = ÷5、简易 = ÷2 但宽松、大成功 = 按房规
    let success = check.success;
    let needLevel = '';
    if (difficulty) {
      let factor = 1;
      let need: string;
      switch (difficulty) {
        case '困难': factor = 2; need = '困难成功'; break;
        case '极难': factor = 5; need = '极难成功'; break;
        case '简易': factor = 2; need = '困难成功'; break;
        case '大成功': factor = 0; need = '大成功'; break;
        default: factor = 1; need = '';
      }
      if (difficulty === '大成功') {
        needLevel = need;
        success = check.level === '大成功';
      } else if (factor > 1) {
        const hardTarget = Math.max(1, Math.floor(target / factor));
        // 用更难的目标线重新判定
        const hard = cocCheck(rollValue, hardTarget, rule);
        needLevel = need;
        success = hard.success;
      }
    }

    this.store.addLog({
      platform: msg.platform,
      groupId: msg.groupId,
      groupName: msg.groupName,
      userId: msg.userId,
      userName: msg.userName,
      expression: `${forceRule === 0 ? 'rc' : 'ra'} ${skillName} ${target}`,
      total: rollValue,
      detail: `${rollValue} vs ${target} → ${check.level}${difficulty ? ` [要求${needLevel}]` : ''}${bonus ? ` [${bonus.mode}×${bonus.count}]` : ''}`,
      createdAt: Date.now(),
    });

    return { rollValue, level: check.level, success, bonusDetail, needLevel };
  }

  /** 拼装带难度标记的检定结果文本 */
  private checkReply(
    name: string, skillName: string, target: number,
    r: { rollValue: number; level: string; success: boolean; bonusDetail: string; needLevel: string },
  ): string {
    const icon = r.success ? '✅' : '❌';
    const need = r.needLevel ? `（需${r.needLevel}）` : '';
    return `${icon} ${name}${skillName}检定${need}: 1d100 = ${r.rollValue} / ${target} → ${r.level}${r.bonusDetail}`;
  }

  /**
   * 从参数解析「技能表达式 + 目标值」。支持主流骰娘写法：
   *   .ra 侦查            读角色卡
   *   .ra 侦查60          直接指定
   *   .ra 侦查+10         属性调整（目标 = 卡上值 + 10）
   *   .ra 困难侦查+10     难度前缀（困难=÷2、极难=÷5、大成功=按房规）
   *   .ra 60              裸数值检定
   * 返回 difficulty 供上层调整判定线。
   */
  private resolveCheckTarget(
    msg: IncomingMessage,
    args: string[],
  ): { skillName: string; target: number; difficulty?: string } | { error: string } {
    let skillName = '';
    let target: number | undefined;
    let difficulty: string | undefined;

    // 主流骰娘风连写：`.ra侦查60` / `.ra困难侦查+10`
    // ⚠️ 不能对含 +/- 的串做这个拆分，否则 `侦查+10` 会被切成 `侦查+` 和 `10`，
    //    导致目标值变成 10（属性调整形态要留给下面的 adjust 逻辑处理）。
    if (args.length === 1 && !/[+-]/.test(args[0])) {
      const m = /^(\D+?)(\d+)$/.exec(args[0]);
      if (m) args = [m[1], m[2]];
    }

    // 第一个参数是纯数字 → 直接作为检定目标
    if (/^\d+$/.test(args[0])) {
      target = parseInt(args[0], 10);
      skillName = `检定${target}`;
      return { skillName, target };
    }

    // 难度前缀（必须在剥离技能名前处理）
    let expr = args[0];
    const diffM = /^(困难|极难|普通|大成功|简易)/.exec(expr);
    if (diffM) {
      difficulty = diffM[1];
      expr = expr.slice(difficulty.length);
    }

    // 属性调整后缀：`技能+10` / `技能-1d4`（可能与难度前缀同时出现）
    let adjust = 0;
    const adjM = /^(.+?)([+-])((?:\d+)?(?:d\d+)?(?:[+-]\d+)?)$/.exec(expr);
    if (adjM && adjM[1] && /[一-龥a-zA-Z]/.test(adjM[1]) && adjM[3]) {
      const base = adjM[1];
      const sign = adjM[2];
      const amountRaw = adjM[3];
      // 防止把纯键名误判（如「力量-1」里 base=力… 需保证 base 是完整技能名）
      if (base) {
        expr = base;
        const amount = /^\d+$/.test(amountRaw)
          ? parseInt(amountRaw, 10)
          : rollExpression(amountRaw, this.rng).total;
        adjust = sign === '+' ? amount : -amount;
      }
    }

    skillName = expr;
    if (args[1] && /^\d+$/.test(args[1])) target = parseInt(args[1], 10);
    if (target === undefined) {
      const v = this.lookupSkill(msg, skillName);
      if (v !== undefined) target = v;
    }

    if (target === undefined) {
      return { error: `未找到技能「${skillName}」的目标值，请补充，如 .ra ${skillName} 60` };
    }
    target += adjust;
    if (difficulty) return { skillName, target, difficulty };
    return { skillName, target };
  }

  /** 从角色卡里查技能值（兼容「侦查」与「技能_侦查」两种键名） */
  private lookupSkill(msg: IncomingMessage, skillName: string): number | undefined {
    const rec = this.store.getSheet(msg.platform, msg.userId);
    if (!rec) return undefined;
    try {
      const sheet = JSON.parse(rec.data) as CharacterSheet;
      const v = sheet.attributes[skillName] ?? sheet.attributes[`技能_${skillName}`];
      return typeof v === 'number' ? v : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 技能成长检定（主流骰娘语义）：
   *   .en <技能> [<技能>...]        对每个技能各成长一次
   *   .en <技能> <点数>             强制指定当前点数（不论成败都会写回新值）
   *   .en <技能> [点数] +<失败>/<成功>  自定义成长点数（可含骰点，可为负）
   *   .en <技能> [点数] +<成功>     失败成长为 0 的简写
   * 相同技能不能在同一命令里重复列出（要多次成长就发多次）。
   */
  private doGrowth(msg: IncomingMessage, args: string[]): EngineResult {
    if (args.length === 0) {
      return {
        reply: [
          '用法: .en <技能名> [更多技能名...]',
          '例: .en 侦查 聆听 图书馆使用（一次成长多个）',
          '指定点数: .en 侦查 65',
          '自定义成长: .en 侦查 +0/1d6（失败不涨/成功涨 1d6）',
        ].join('\n'),
      };
    }

    // 摘出自定义成长值（形如 +0/1d6 或 +1d6，通常在最后）
    let failGainExpr = '0';
    let succGainExpr = '1d10';
    let custom = false;
    const gainArg = args.find((a) => /^\+.*/.test(a));
    const rest = args.filter((a) => a !== gainArg);
    if (gainArg) {
      custom = true;
      const body = gainArg.replace(/^\+/, '');
      const slash = body.indexOf('/');
      if (slash >= 0) {
        failGainExpr = body.slice(0, slash) || '0';
        succGainExpr = body.slice(slash + 1) || '0';
      } else {
        failGainExpr = '0';
        succGainExpr = body || '0';
      }
    }

    // 解析技能列表：`.en 侦查 65` 里第二个纯数字是「当前点数」而不是技能名
    const names: string[] = [];
    let forced: number | undefined;
    for (const a of rest) {
      if (/^\d+$/.test(a) && names.length >= 1) {
        forced = parseInt(a, 10); // 跟在技能名后的纯数字 = 强制点数
        continue;
      }
      names.push(a);
    }
    if (names.length === 0) {
      return { reply: '请至少指定一个技能名' };
    }
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (dup.length) {
      return { reply: `技能「${[...new Set(dup)].join('、')}」重复了，要多次成长请分开发送` };
    }

    const nameTag = msg.userName ? `【${msg.userName}】` : '';
    const lines: string[] = [];
    for (const skillName of names) {
      const current = forced ?? this.lookupSkill(msg, skillName);
      if (current === undefined) {
        lines.push(`⚠️ ${nameTag}${skillName}：未找到当前值（用 .st ${skillName} 50 先录入，或 .en ${skillName} 65 指定）`);
        continue;
      }
      const rollValue = Math.floor(this.rng() * 100) + 1;
      const grew = rollValue > current;

      if (!grew) {
        // 失败：默认 0 成长；若自定义了失败成长值则照样结算并写回
        if (!custom || failGainExpr === '0') {
          this.store.addLog({
            platform: msg.platform, groupId: msg.groupId, groupName: msg.groupName,
            userId: msg.userId, userName: msg.userName,
            expression: `en ${skillName} ${current}`, total: rollValue,
            detail: `${rollValue} ≤ ${current} → 未成长`, createdAt: Date.now(),
          });
          lines.push(`📉 ${nameTag}${skillName}: 1d100 = ${rollValue} ≤ ${current} → 未成长`);
          continue;
        }
        const lose = this.evalGain(failGainExpr);
        const newValue = Math.max(0, current + lose);
        const saved = this.writeBackSkill(msg, skillName, newValue);
        this.store.addLog({
          platform: msg.platform, groupId: msg.groupId, groupName: msg.groupName,
          userId: msg.userId, userName: msg.userName,
          expression: `en ${skillName} ${current}`, total: rollValue,
          detail: `${rollValue} ≤ ${current} → 失败成长 ${lose}，${current}→${newValue}`, createdAt: Date.now(),
        });
        lines.push(`📉 ${nameTag}${skillName}: 1d100 = ${rollValue} ≤ ${current} → 失败成长 ${failGainExpr} = ${lose}，${current} → ${newValue}${saved ? '' : '（未保存）'}`);
        continue;
      }

      // 成功
      const gain = custom ? this.evalGain(succGainExpr) : Math.floor(this.rng() * 10) + 1;
      const newValue = Math.min(99, current + gain);
      const saved = this.writeBackSkill(msg, skillName, newValue);
      this.store.addLog({
        platform: msg.platform, groupId: msg.groupId, groupName: msg.groupName,
        userId: msg.userId, userName: msg.userName,
        expression: `en ${skillName} ${current}`, total: rollValue,
        detail: `${rollValue} > ${current} → 成长 +${gain}，${current}→${newValue}`, createdAt: Date.now(),
      });
      lines.push(
        `📈 ${nameTag}${skillName}: 1d100 = ${rollValue} > ${current} → ` +
        `+${custom ? `${succGainExpr} = ${gain}` : `1d10 = ${gain}`}，${current} → ${newValue}${saved ? '' : '（未保存）'}`,
      );
    }

    const head = names.length > 1 ? `技能成长 ×${names.length}\n` : '';
    return { reply: head + lines.join('\n') };
  }

  /** 求值成长点数表达式（支持 1d6 / 2 / -1 / +1d4 等） */
  private evalGain(expr: string): number {
    const t = expr.trim();
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    try {
      return rollExpression(t, this.rng).total;
    } catch {
      return 0;
    }
  }

  /** 把技能新值写回角色卡；返回是否写成功 */
  private writeBackSkill(msg: IncomingMessage, skillName: string, newValue: number): boolean {
    const rec = this.store.getSheet(msg.platform, msg.userId);
    if (!rec) return false;
    try {
      const sheet = JSON.parse(rec.data) as CharacterSheet;
      // 优先更新已存在的键，避免同一技能出现两份
      if (typeof sheet.attributes[skillName] === 'number') {
        sheet.attributes[skillName] = newValue;
      } else if (typeof sheet.attributes[`技能_${skillName}`] === 'number') {
        sheet.attributes[`技能_${skillName}`] = newValue;
      } else {
        sheet.attributes[`技能_${skillName}`] = newValue;
      }
      this.saveCurrentSheet(msg, rec, sheet);
      return true;
    } catch {
      return false;
    }
  }

  /** 疯狂表：.ti 临时性 / .li 长期性 */
  private doMadness(msg: IncomingMessage, kind: 'ti' | 'li'): EngineResult {
    const table: MadnessEntry[] = kind === 'ti' ? MADNESS_IMMEDIATE : MADNESS_LONGTERM;
    const title = kind === 'ti' ? '临时性疯狂' : '长期性疯狂';
    const roll = Math.floor(this.rng() * 10) + 1;
    const entry = table.find((x) => x.roll === roll) ?? table[0];
    const name = msg.userName ? `【${msg.userName}】` : '';
    return {
      reply: `🌀 ${name}${title}表 1d10 = ${roll}\n【${entry.name}】${entry.desc}`,
    };
  }

  // ==================== COC 扩展（v1.2）：理智 / 对抗 / 房规 / HP·SAN ====================

  /**
   * 理智检定：.sc [成功扣[/失败扣]] [原因] [--cap=N] [--half]
   *   .sc                → 默认 1/1d6（成功扣 1，失败扣 1d6）
   *   .sc 1d6            → 成功扣 1，失败扣 1d6
   *   .sc 0/1d10         → 成功扣 0，失败扣 1d10
   *   .sc 60 1/1d6       → 首个纯数字当作当前 SAN（不读卡）
   *   .sc 1/1d6 --cap=3  → 本次损失上限 3（主流骰娘「习惯恐怖」规则）
   *   .sc 1/1d6 --half   → 本次损失减半向下取整（主流骰娘「神话淬炼」规则）
   *   两者可同时使用：先减半，再按上限截断。
   *
   * 大成功不掉 SAN；大失败按失败表达式取最大值扣（COC 7 常用房规）。
   * 扣减结果自动写回角色卡「理智」。
   */
  private doSc(msg: IncomingMessage, args: string[]): EngineResult {
    const name = msg.userName ? `【${msg.userName}】` : '';

    // 先摘出标志参数（--cap=N / --half），它们不参与表达式解析
    let cap: number | undefined;
    let half = false;
    const cleanArgs: string[] = [];
    for (const a of args) {
      const capM = /^--cap=(\d+)$/.exec(a);
      if (capM) {
        cap = parseInt(capM[1], 10);
        continue;
      }
      if (a === '--half') {
        half = true;
        continue;
      }
      cleanArgs.push(a);
    }

    // 参数整理：把可能混在一起的「0/1d10」拆开，并识别首个纯数字作为 SAN 值
    let sanArg: number | undefined;
    let successExpr = '1';
    let failExpr = '1d6';
    const rest: string[] = [];
    for (const a of cleanArgs) {
      if (/^\d+$/.test(a) && sanArg === undefined && cleanArgs.length >= 2) {
        sanArg = parseInt(a, 10); // .sc 60 1/1d6 → 直接指定 SAN
      } else {
        rest.push(a);
      }
    }
    const joined = rest.join('');
    if (joined) {
      const [s, f] = joined.split('/');
      if (f !== undefined) {
        successExpr = s || '1';
        failExpr = f || '1d6';
      } else {
        // 只给一个表达式 → 成功扣 1，失败扣它
        successExpr = '1';
        failExpr = s;
      }
    }

    // 当前 SAN：参数指定 > 角色卡
    const current = sanArg ?? this.lookupSheetValue(msg, ['理智', 'san', 'SAN']);
    if (current === undefined) {
      return {
        reply:
          `未找到你的理智值。先用 .st 理智 60 录入，或直接指定：\n` +
          `例: .sc 60 1/1d6（当前 SAN 60，成功扣 1 / 失败扣 1d6）`,
      };
    }

    // 掷骰 + 房规判定
    const rollValue = Math.floor(this.rng() * 100) + 1;
    const check = cocCheck(rollValue, current, this.cocRulesOf(msg.platform, msg.groupId));

    let costText: string;
    let newSan = current;
    if (check.level === '大成功') {
      costText = '✨ 大成功，理智毫发无损！';
    } else {
      const isFumble = check.level === '大失败';
      // 大失败：按失败表达式取最大值（1d6 → 6，2d6+1 → 13）
      const costExpr = isFumble ? failExpr : check.success ? successExpr : failExpr;
      let cost: number;
      if (isFumble) {
        cost = maxOfDiceExpr(failExpr);
      } else if (/^\d+$/.test(costExpr)) {
        cost = parseInt(costExpr, 10);
      } else {
        cost = rollExpression(costExpr, this.rng).total;
      }

      // --half：损失减半（向下取整）；--cap=N：损失上限。先减半再截断（主流骰娘顺序）
      let rawCost = cost;
      const mods: string[] = [];
      if (half) {
        cost = Math.floor(cost / 2);
        mods.push(`减半 ${rawCost}→${cost}`);
      }
      if (cap !== undefined && cost > cap) {
        mods.push(`截断 ${cost}→${cap}`);
        cost = cap;
      }

      newSan = Math.max(0, current - cost);
      const saved = this.writeSheetValue(msg, ['理智', 'san', 'SAN'], newSan);
      costText =
        `${isFumble ? '💀 大失败！' : ''}SAN 扣减 ${costExpr}` +
        `${isFumble ? '（取最大）' : ''} = ${rawCost}` +
        `${mods.length ? `（${mods.join('，')}）` : ''}` +
        ` → ${current} → ${newSan}（-${cost}）` +
        `${saved ? '' : '\n（未找到角色卡，结果未保存）'}`
      ;
    }

    this.store.addLog({
      platform: msg.platform, groupId: msg.groupId, groupName: msg.groupName,
      userId: msg.userId, userName: msg.userName,
      expression: `sc${cap !== undefined ? ` --cap=${cap}` : ''}${half ? ' --half' : ''}`,
      total: rollValue,
      detail: `${rollValue}/${current} → ${check.level}，SAN ${current}→${newSan}`,
      createdAt: Date.now(),
    });

    const flags = `${cap !== undefined ? ` --cap=${cap}` : ''}${half ? ' --half' : ''}`;
    return {
      reply:
        `🎲 ${name}理智检定${flags}: 1d100 = ${rollValue} / ${current} → ${check.level}\n` +
        `🩸 ${costText}`,
    };
  }

  /**
   * 对抗检定：.rav @对手 <技能> [我方值] [对方值]
   * 双方各掷 1d100，成功等级高者胜；同级比骰值小者胜；都失败视为僵局。
   */
  private doRav(msg: IncomingMessage, args: string[]): EngineResult {
    if (msg.isPrivate) return { reply: '⚠️ 对抗检定需要在群里 @ 对手使用' };

    // 从消息段里找第一个 @ 的目标（@全体成员不算）
    const at = msg.segments?.find((s) => s.type === 'at' && s.targetId && s.targetId !== 'all');
    if (!at || !at.targetId) {
      return { reply: '用法: .rav @对手 <技能> [我方值] [对方值]\n例: .rav @李四 侦查（双方读卡）' };
    }

    // 解析技能名与可选数值
    const nums = args.filter((a) => /^\d+$/.test(a)).map((a) => parseInt(a, 10));
    const skillWords = args.filter((a) => !/^\d+$/.test(a));
    const skillName = skillWords.join(' ') || '对抗';

    // 我方目标值：参数 > 我的卡
    const myTarget = nums[0] ?? this.lookupSheetValue(msg, [skillName, `技能_${skillName}`]);
    if (myTarget === undefined) {
      return { reply: `未找到你「${skillName}」的值，用 .st ${skillName} 60 录入，或直接写进指令` };
    }
    // 对方目标值：第二个数字 > 对方的卡
    const oppSheetRec = this.store.getSheet(msg.platform, at.targetId);
    let oppTarget = nums[1] ?? undefined;
    if (oppTarget === undefined && oppSheetRec) {
      try {
        const sheet = JSON.parse(oppSheetRec.data) as CharacterSheet;
        const v = sheet.attributes[skillName] ?? sheet.attributes[`技能_${skillName}`];
        if (typeof v === 'number') oppTarget = v;
      } catch { /* 对方卡损坏就当没有 */ }
    }
    if (oppTarget === undefined) {
      const oppName = at.targetName || at.targetId;
      return { reply: `未找到 ${oppName}「${skillName}」的值，可让对方 .st 录入，或指定：.rav @对方 ${skillName} 我方值 对方值` };
    }

    // 双方各掷
    const myRoll = Math.floor(this.rng() * 100) + 1;
    const oppRoll = Math.floor(this.rng() * 100) + 1;
    const rule = this.cocRulesOf(msg.platform, msg.groupId);
    const myCheck = cocCheck(myRoll, myTarget, rule);
    const oppCheck = cocCheck(oppRoll, oppTarget, rule);

    const rank = (l: string): number =>
      l === '大成功' ? 5 : l === '极难成功' ? 4 : l === '困难成功' ? 3 : l === '成功' ? 2 : 0;

    const myName = msg.userName || '我';
    const oppName = at.targetName || at.targetId;
    let verdict: string;
    if (rank(myCheck.level) !== rank(oppCheck.level)) {
      verdict = rank(myCheck.level) > rank(oppCheck.level) ? `🏆 ${myName} 胜出！` : `🏆 ${oppName} 胜出！`;
    } else if (myCheck.level !== '失败' && myCheck.level !== '大失败') {
      // 同等级比大小：骰值小者胜（COC 对抗惯例）
      if (myRoll !== oppRoll) {
        verdict = myRoll < oppRoll ? `🏆 ${myName} 胜出（出目更小）！` : `🏆 ${oppName} 胜出（出目更小）！`;
      } else {
        verdict = '🤝 完全相同，重掷一次吧';
      }
    } else {
      verdict = '🤝 双方都失败，视为僵局';
    }

    this.store.addLog({
      platform: msg.platform, groupId: msg.groupId, groupName: msg.groupName,
      userId: msg.userId, userName: msg.userName,
      expression: `rav ${skillName}`, total: myRoll,
      detail: `${myRoll}/${myTarget} vs ${oppRoll}/${oppTarget} → ${verdict}`,
      createdAt: Date.now(),
    });

    return {
      reply:
        `⚔️ ${myName} vs ${oppName}「${skillName}」对抗\n` +
        `${myName}: 1d100 = ${myRoll} / ${myTarget} → ${myCheck.level}\n` +
        `${oppName}: 1d100 = ${oppRoll} / ${oppTarget} → ${oppCheck.level}\n` +
        verdict,
    };
  }

  /**
   * 房规切换：.setcoc [0|1|2|details]
   * 只影响 `.ra / .rb / .rp / .sc / .r 1d100<=x` 的大成功 / 大失败判定。
   */
  private doSetcoc(msg: IncomingMessage, args: string[]): EngineResult {
    const detailText = '房规说明（与主流骰娘一致）:\n' +
      COC_RULES.map((r) => `${r.key} = ${r.desc}`).join('\n');

    if (args.length === 0 || args[0] === 'details' || args[0] === '详情') {
      return { reply: `当前房规: ${this.cocRulesOf(msg.platform, msg.groupId)}\n${detailText}` };
    }
    const key = String(args[0]).toLowerCase();
    const valid = COC_RULES.some((r) => r.key === key);
    if (!valid) {
      return { reply: `不支持的房规: ${args[0]}（可用 ${COC_RULES.map((r) => r.key).join(' / ')}）\n${detailText}` };
    }
    this.store.setSetting(msg.platform, msg.groupId, 'cocRules', key);
    const desc = COC_RULES.find((r) => r.key === key)?.desc || '';
    return { reply: `✅ 已切换房规为 ${key}\n${key} = ${desc}` };
  }

  /** 从角色卡里按候选键名查第一个数值 */
  private lookupSheetValue(msg: IncomingMessage, keys: string[]): number | undefined {
    const rec = this.store.getSheet(msg.platform, msg.userId);
    if (!rec) return undefined;
    try {
      const sheet = JSON.parse(rec.data) as CharacterSheet;
      for (const k of keys) {
        const v = sheet.attributes[k];
        if (typeof v === 'number') return v;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** 把数值写回角色卡第一个存在的候选键（都不存在则写第一个）；返回是否写成功 */
  private writeSheetValue(msg: IncomingMessage, keys: string[], value: number): boolean {
    const rec = this.store.getSheet(msg.platform, msg.userId);
    if (!rec) return false;
    try {
      const sheet = JSON.parse(rec.data) as CharacterSheet;
      const hit = keys.find((k) => typeof sheet.attributes[k] === 'number') ?? keys[0];
      sheet.attributes[hit] = value;
      this.saveCurrentSheet(msg, rec, sheet);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * HP / SAN 快捷：.hp / .hp+1 / .hp-1d4 / .hp 50（直接设值）
   * 写回角色卡（键名优先取卡上已有的：生命值/hp、理智/san）。
   */
  private doHpSan(msg: IncomingMessage, kind: 'hp' | 'san', args: string[]): EngineResult {
    const keys = kind === 'hp' ? ['生命值', 'hp', 'HP'] : ['理智', 'san', 'SAN'];
    const label = kind === 'hp' ? 'HP' : 'SAN';
    const current = this.lookupSheetValue(msg, keys);
    if (current === undefined) {
      return { reply: `未找到你的${label}。先用 .coc 生成角色卡，或 .st ${kind} 50 录入` };
    }

    // 无参数 → 查看
    if (args.length === 0) {
      return { reply: `❤️ ${label}: ${current}` };
    }

    const exprRaw = args.join('');
    let newValue: number;
    let changeText: string;

    const delta = /^([+-])(.+)$/.exec(exprRaw);
    if (delta) {
      // 增减：表达式求值（掷骰均可）
      const amount = /^\d+$/.test(delta[2])
        ? parseInt(delta[2], 10)
        : rollExpression(delta[2], this.rng).total;
      newValue = delta[1] === '+' ? current + amount : current - amount;
      changeText = `${delta[1] === '+' ? '+' : '-'}${amount}`;
    } else if (/^\d+$/.test(exprRaw)) {
      // 直接设值
      newValue = parseInt(exprRaw, 10);
      changeText = `设为 ${newValue}`;
    } else {
      return { reply: `用法: .${kind} [查看] | .${kind}+1 | .${kind}-1d4 | .${kind} 50（设值）` };
    }

    newValue = Math.max(0, newValue);
    const saved = this.writeSheetValue(msg, keys, newValue);
    this.store.addLog({
      platform: msg.platform, groupId: msg.groupId, groupName: msg.groupName,
      userId: msg.userId, userName: msg.userName,
      expression: `${kind} ${exprRaw}`, total: newValue,
      detail: `${current} → ${newValue}`, createdAt: Date.now(),
    });
    return {
      reply:
        `❤️ ${label}: ${current} → ${newValue}（${changeText}）` +
        `${saved ? '' : '\n（未找到角色卡，结果未保存）'}`,
    };
  }

  /** 骰子开关权限：与跑团日志同一原则 —— 没配管理员就不限制（防锁死） */
  private canManageBot(msg: IncomingMessage): boolean {
    if (this.admins.size === 0) return true;
    return this.isAdmin(msg.userId);
  }

  /** 骰子开关：.bot on / off / bye / 状态（未配置管理员时人人可操作） */
  private doBot(msg: IncomingMessage, args: string[]): EngineResult {
    const sub = (args[0] || '').toLowerCase();
    const key = 'botEnabled';

    if (sub === 'on' || sub === '开启' || sub === 'up') {
      if (!this.canManageBot(msg)) return { reply: '⛔ 只有管理员可以开关骰子' };
      const wasOff = this.store.getSetting(msg.platform, msg.groupId, key, 'true') === 'false';
      this.store.setSetting(msg.platform, msg.groupId, key, 'true');
      return { reply: wasOff ? '🤖 骰子已启用，为大家服务！' : '🤖 骰子本来就是启用状态' };
    }
    if (sub === 'off' || sub === '关闭' || sub === 'down') {
      if (!this.canManageBot(msg)) return { reply: '⛔ 只有管理员可以开关骰子' };
      this.store.setSetting(msg.platform, msg.groupId, key, 'false');
      const p = this.prefixOf(msg.platform, msg.groupId);
      return { reply: `😴 骰子已停用（可随时 ${p}bot on 恢复）` };
    }
    if (sub === 'bye' || sub === '退群' || sub === '拜拜') {
      if (msg.isPrivate) return { reply: '⚠️ .bot bye 需要在群里发送' };
      if (!this.canManageBot(msg)) return { reply: '⛔ 只有管理员可以让骰子退群' };
      return { reply: '👋 收到，本骰这就退群，再会！', bye: true };
    }

    // 状态
    const enabled = this.store.getSetting(msg.platform, msg.groupId, key, 'true') !== 'false';
    return {
      reply: `🤖 AleaBot NG（本群状态: ${enabled ? '启用' : '停用'}）\n${this.prefixOf(msg.platform, msg.groupId)}bot on / off 开关，bye 退群`,
    };
  }

  /** 抛硬币：.coin [数量≤10] */
  private doCoin(msg: IncomingMessage, args: string[]): EngineResult {
    const count = args[0] && /^\d+$/.test(args[0]) ? Math.min(10, Math.max(1, parseInt(args[0], 10))) : 1;
    const results = Array.from({ length: count }, () => (this.rng() < 0.5 ? '正面' : '反面'));
    const heads = results.filter((r) => r === '正面').length;
    const tails = count - heads;
    const name = msg.userName ? `【${msg.userName}】` : '';
    const detail = count === 1 ? results[0] : `${results.join('、')}（正面×${heads} 反面×${tails}）`;

    // 按结果给点俏皮点评（纯娱乐，不影响判定）
    let note: string;
    if (count === 1) {
      note = results[0] === '正面' ? '正面！命运说：干就完了。' : '反面。命运说：再想想？';
    } else if (heads === count) {
      note = '清一色！今天这枚硬币坚定地站在你这边 ✨';
    } else if (heads === 0) {
      note = '一面都没翻过来……硬币它显然有自己的剧本 🌀';
    } else if (heads === tails) {
      note = '五五开，天平和你的运气一样四平八稳 ⚖️';
    } else {
      note = `正面略占${heads > tails ? '上风' : '下风'}，影响不大，随便选就好~`;
    }

    this.store.addLog({
      platform: msg.platform, groupId: msg.groupId, groupName: msg.groupName,
      userId: msg.userId, userName: msg.userName,
      expression: `coin×${count}`, total: heads,
      detail, createdAt: Date.now(),
    });
    return { reply: `🪙 ${name}抛硬币${count > 1 ? `×${count}` : ''}: ${detail}\n${note}` };
  }

  // ==================== 角色卡 ====================

  /**
   * 生成角色卡 / 批量掷属性。
   *
   * 主流骰娘语义：`.coc [<数量>]` / `.dnd [<数量>]` —— **只掷主属性**给玩家挑，
   * 不含技能、不写卡。主流骰娘原版是纯输出；本项目扩展：数量 > 1 时仍只输出（不写卡），
   * 想要真正建卡用 `.st new` 或不带数量的 `.coc`。
   *
   * 兼容旧行为：不带数量时生成完整卡并写入（保持 v1.x 的既有语义不变）。
   */
  private doGenSheet(msg: IncomingMessage, system: 'coc7' | 'coc5' | 'dnd5e', args: string[] = []): EngineResult {
    const cntArg = args.find((a) => /^\d+$/.test(a));
    const count = cntArg ? parseInt(cntArg, 10) : 1;

    // ---- 批量制卡模式：只掷主属性，纯输出不写卡（主流骰娘行为）----
    if (count > 1) {
      if (count > 20) {
        return { reply: `一次最多生成 20 组，请用 .coc 20 以内` };
      }
      const order = attributeOrder(system);
      const lines: string[] = [];
      for (let i = 0; i < count; i++) {
        const attrs = rollMainAttributes(system, this.rng);
        const meta = mainAttributesMeta(system, attrs);
        const parts = order.map((k) => `${k}:${attrs[k]}`);
        if (meta.hp !== undefined) parts.push(`HP:${meta.hp}`);
        if (meta.sum8 !== undefined) parts.push(`[${meta.sum8}/${meta.sumAll}]`);
        else if (meta.sumAll !== undefined) parts.push(`[合计${meta.sumAll}]`);
        lines.push(`${i + 1}. ${parts.join(' ')}`);
      }
      const head =
        system === 'coc7' ? 'COC 7 版主属性掷骰' :
          system === 'coc5' ? 'COC 5 版主属性掷骰' : 'D&D 5e 属性掷骰';
      return {
        reply:
          `🎲 ${head} × ${count}（只含主属性，技能需自行设定）\n` +
          `${lines.join('\n')}\n` +
          `挑好一组用 .st <键><值> 批量录入，例如 .st 力量88 体质70 敏捷60\n` +
          `或按位置一次录完：.st 88 70 60 75 80 65 70 60 55`,
      };
    }

    // ---- 建卡模式：生成完整卡并写入「当前卡」----
    const cur = this.store.getSheet(msg.platform, msg.userId);
    const title = cur?.title || '默认';
    const sheet =
      system === 'coc5' ? generateCOC5(msg.userName, this.rng, title)
        : system === 'coc7' ? generateCOC(msg.userName, this.rng, title)
          : generateDND(msg.userName, this.rng, title);
    this.store.saveSheet({
      platform: msg.platform,
      userId: msg.userId,
      userName: msg.userName,
      system,
      title,
      data: JSON.stringify(sheet),
      updatedAt: Date.now(),
    });
    this.store.setCurrentTitle(msg.platform, msg.userId, title);
    return { reply: renderSheet(sheet) };
  }

  /**
   * 载入「当前角色卡」。没有卡时按需新建一张 COC7（默认标题）。
   * 返回值带上 title，后续保存必须原样带回，否则会写错卡。
   */
  private loadCurrentSheet(msg: IncomingMessage): { rec: SheetRecord; sheet: CharacterSheet } | null {
    const rec = this.store.getSheet(msg.platform, msg.userId);
    if (rec) {
      try {
        const sheet = JSON.parse(rec.data) as CharacterSheet;
        if (!sheet.title) sheet.title = rec.title || '默认';
        return { rec, sheet };
      } catch {
        // 数据损坏：按当前标题重建
        const title = rec.title || '默认';
        const sheet = generateCOC(msg.userName, this.rng, title);
        return { rec, sheet };
      }
    }
    return null;
  }

  /** 查保存的计算表达式（.st &名=表达式） */
  private lookupExpression(msg: IncomingMessage, name: string): string | undefined {
    const rec = this.store.getSheet(msg.platform, msg.userId);
    if (!rec) return undefined;
    try {
      const sheet = JSON.parse(rec.data) as CharacterSheet;
      return sheet.expressions?.[name];
    } catch {
      return undefined;
    }
  }

  /** 保存当前角色卡（自动带上 title） */
  private saveCurrentSheet(msg: IncomingMessage, rec: SheetRecord, sheet: CharacterSheet): void {
    const title = rec.title || sheet.title || '默认';
    sheet.title = title;
    this.store.saveSheet({
      platform: msg.platform,
      userId: msg.userId,
      userName: msg.userName,
      system: sheet.system,
      title,
      data: JSON.stringify(sheet),
      updatedAt: Date.now(),
    });
  }

  /**
   * 把「键+值」串切成若干对，支持空格分隔与无空格连写：
   *   "力量88 体质70" → [{key:力量,val:88,raw:88}, {key:体质,val:70,raw:70}]
   *   "力量88体质70"  → 同上
   *   "侦查 70"       → 键值间空格会先被剥掉
   * `raw` 是数字部分的原始文本，用于校验「整串是否被完全解析」。
   */
  private static parseKeyValues(input: string): Array<{ key: string; val: number; raw: string }> {
    const out: Array<{ key: string; val: number; raw: string }> = [];
    const re = /([^\d\s]+)([\d.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      const val = parseFloat(m[2]);
      if (Number.isFinite(val)) out.push({ key: m[1], val, raw: m[2] });
    }
    return out;
  }

  /**
   * 设置/查看角色属性。
   * 支持的写法（都可紧贴，省略动词后的空格）：
   *   .st 力量 60          单个设值
   *   .st 力量88           连写
   *   .st 力量88 体质70    批量键值（空格可省）
   *   .st 60 50 70 55 ...  按属性顺序录入（免键名，顺序见 .st show）
   *   .st hp+1 / hp-1d4    增减
   *   .st name 张三        设定卡名/昵称
   *   .st 力量             查询单个属性
   */
  private doStSet(msg: IncomingMessage, args: string[]): EngineResult {
    if (args.length === 0) {
      return this.doStShow(msg);
    }
    const loaded = this.loadCurrentSheet(msg);
    const rec: SheetRecord = loaded?.rec ?? {
      platform: msg.platform, userId: msg.userId, system: 'coc7', data: '', title: '默认', updatedAt: Date.now(),
    };
    const sheet: CharacterSheet = loaded?.sheet ?? generateCOC(msg.userName, this.rng, '默认');

    // 角色卡名字（同时就是玩家昵称）：.st name <名字> / .sn <名字>
    // 设置后，所有回复署名 / 日志 / 角色卡生成都会用这个名字。
    const NAME_KEYS = ['name', '名称', '名字', '昵称'];
    if (NAME_KEYS.includes(args[0])) {
      const newName = args.slice(1).join(' ').trim();
      if (!newName) {
        return { reply: sheet.name ? `当前角色卡名字（昵称）：${sheet.name}` : '未设置角色卡名字，用 .st name <名字> 设置（这也会成为 bot 称呼你的昵称）' };
      }
      sheet.name = newName;
      this.saveCurrentSheet(msg, rec, sheet);
      return { reply: `✅ 已设置角色卡名字（也是你的昵称）：${newName}\n以后 bot 都用这个名字称呼你，日志与角色卡同步生效` };
    }

    // 增减语法：`.st hp+1` / `.st san-1d4` / `.st hp +1`（键与符号可连写）
    const joined = args.join(' ').replace(/\s+/g, ' ').trim();
    // 形如「键+表达式」或「键-表达式」；符号后必须是数字或骰子表达式
    const dm = /^([^\d\s+-]+)\s*([+-])\s*([\d].*)$/.exec(joined);
    if (dm) {
      const key = dm[1];
      const cur = sheet.attributes[key] ?? sheet.attributes[`技能_${key}`];
      if (typeof cur !== 'number') {
        return { reply: `未找到属性「${key}」的当前值，先 .st ${key} 50 设一个` };
      }
      const amount = /^\d+$/.test(dm[3]) ? parseInt(dm[3], 10) : rollExpression(dm[3], this.rng).total;
      const next = dm[2] === '+' ? cur + amount : cur - amount;
      sheet.attributes[key] = next;
      this.saveCurrentSheet(msg, rec, sheet);
      return { reply: `✅ ${key}: ${cur} → ${next}（${dm[2]}${amount}）` };
    }

    // ---------- 批量 / 位置录入 ----------
    // 位置录入：所有参数都是纯数字 → 按标准属性顺序映射（免键名）
    if (args.length >= 2 && args.every((a) => /^\d+$/.test(a))) {
      const order = attributeOrder(sheet.system);
      if (args.length > order.length) {
        return {
          reply:
            `按位置录入只支持 ${order.length} 个值（${order.join('/')}），你给了 ${args.length} 个。\n` +
            `多了就请用键名：.st 力量60 体质70 敏捷60`,
        };
      }
      const lines: string[] = [];
      args.forEach((a, i) => {
        const k = order[i];
        const v = parseInt(a, 10);
        sheet.attributes[k] = v;
        lines.push(`${k}:${v}`);
      });
      this.saveCurrentSheet(msg, rec, sheet);
      return { reply: `✅ 已按顺序录入 ${args.length} 项：\n${lines.join('  ')}` };
    }

    // 批量键值：`.st 力量88 体质70 敏捷60` / `.st 力量88体质70敏捷60` / `.st 力量88`
    // 判定：整串（去掉空格）能被完整切成「非数字键 + 数字值」就走批量。
    // 这样单个连写 `.st 力量88` 与多个连写走同一条路径，行为一致。
    {
      const compact = joined.replace(/\s+/g, '');
      const pairs = Engine.parseKeyValues(compact);
      // 「键 + 数字」两段拼起来必须正好覆盖整串，否则说明有无法解析的残余字符
      const covered = pairs.reduce((n, p) => n + p.key.length + p.raw.length, 0);
      if (pairs.length >= 1 && covered === compact.length) {
        const lines: string[] = [];
        for (const p of pairs) {
          const v = Math.round(p.val);
          sheet.attributes[p.key] = v;
          lines.push(`${p.key}:${v}`);
        }
        this.saveCurrentSheet(msg, rec, sheet);
        const head = pairs.length === 1 ? '✅ 已设置' : `✅ 已批量设置 ${pairs.length} 项`;
        return { reply: `${head}：\n${lines.join('  ')}` };
      }
    }

    // 兜底：单键值（正常已在上面批量分支处理，这里是「键 值」形式但键含空格等）
    if (args.length >= 2) {
      const key = args[0];
      const val = parseInt(args[1], 10);
      if (Number.isNaN(val)) {
        return { reply: `数值无效: ${args[1]}\n提示：一次录入多个可用 .st 力量88 体质70 敏捷60` };
      }
      sheet.attributes[key] = val;
      this.saveCurrentSheet(msg, rec, sheet);
      return { reply: `✅ 已设置 ${key} = ${val}` };
    }

    // 单参数：查询
    const key = args[0];
    // 兼容单键连写查询：.st 力量88 在上面已走批量；这里只处理纯键名
    const v = sheet.attributes[key] ?? sheet.attributes[`技能_${key}`];
    if (v === undefined) {
      return {
        reply:
          `未找到属性「${key}」。\n` +
          `批量：.st 力量88 体质70 敏捷60（空格可省）\n` +
          `按顺序：.st 60 50 70 55 65 75 80 90 50`,
      };
    }
    return { reply: `${key} = ${v}` };
  }

  /**
   * 新建角色卡：.st new <标题>
   * 生成一张新的 COC7 卡（属性随机，可随后用 .st 批量覆盖），并切换过去。
   */
  private doStNew(msg: IncomingMessage, args: string[]): EngineResult {
    const title = args.join(' ').trim();
    if (!title) {
      return { reply: '用法: .st new <标题>\n例: .st new 调查员A' };
    }
    if (this.store.getSheet(msg.platform, msg.userId, title)) {
      return { reply: `已存在标题「${title}」的角色卡，用 .st switch ${title} 切换过去` };
    }
    const sheet = generateCOC(msg.userName, this.rng, title);
    this.store.saveSheet({
      platform: msg.platform,
      userId: msg.userId,
      userName: msg.userName,
      system: sheet.system,
      title,
      data: JSON.stringify(sheet),
      updatedAt: Date.now(),
    });
    this.store.setCurrentTitle(msg.platform, msg.userId, title);
    return {
      reply:
        `✅ 已新建并切换到角色卡「${title}」\n` +
        `下面这行是随机初始值，可用 .st 批量覆盖：\n` +
        `.st 力量88 体质70 敏捷60 外貌75 意志80 体型65 智力70 教育60 幸运55\n` +
        `.st list 看全部卡 · .st switch <标题> 切换`,
    };
  }

  /** 列出我的角色卡：.st list（* 为当前卡） */
  private doStList(msg: IncomingMessage): EngineResult {
    const all = this.store.listSheets(msg.platform, msg.userId);
    if (all.length === 0) {
      return { reply: '你还没有角色卡，发送 .coc / .coc5 / .dnd 生成一张，或 .st new <标题> 新建' };
    }
    const cur = this.store.getCurrentTitle(msg.platform, msg.userId) ?? all[0].title ?? '默认';
    const lines = all.map((r, i) => {
      const mark = r.title === cur ? '*' : ' ';
      const t = r.title || '默认';
      return `${mark} ${i + 1}. ${t}`;
    });
    return {
      reply:
        `📋 你的角色卡（共 ${all.length} 张，* 为当前）：\n${lines.join('\n')}\n` +
        `切换：.st switch <标题或编号> · 删除：.st del <标题或编号>`,
    };
  }

  /** 切换角色卡：.st switch <标题或编号> */
  private doStSwitch(msg: IncomingMessage, args: string[]): EngineResult {
    const all = this.store.listSheets(msg.platform, msg.userId);
    if (all.length === 0) {
      return { reply: '你还没有角色卡，发送 .coc 生成一张，或 .st new <标题> 新建' };
    }
    const key = args.join(' ').trim();
    if (!key) {
      return this.doStList(msg);
    }
    // 编号（1 起）或标题（精确 → 包含）
    let target: SheetRecord | undefined;
    if (/^\d+$/.test(key)) {
      const n = parseInt(key, 10);
      target = all[n - 1];
    }
    if (!target) {
      target =
        all.find((r) => (r.title || '默认') === key) ||
        all.find((r) => (r.title || '默认').includes(key));
    }
    if (!target) {
      const names = all.map((r, i) => `${i + 1}.${r.title || '默认'}`).join(' ');
      return { reply: `没找到角色卡「${key}」。你有的卡：${names}` };
    }
    this.store.setCurrentTitle(msg.platform, msg.userId, target.title || '默认');
    return { reply: `✅ 已切换到角色卡「${target.title || '默认'}」\n.st show 查看 · .st list 看全部` };
  }

  /** 删除角色卡：`.pc del <标题或编号>`（卡片删除语义已从 .st del 迁到这里） */
  private doSheetDelete(msg: IncomingMessage, args: string[]): EngineResult {
    const all = this.store.listSheets(msg.platform, msg.userId);
    if (all.length === 0) {
      return { reply: '你还没有角色卡' };
    }
    const key = args.join(' ').trim();
    if (!key) {
      return { reply: '用法: .pc del <标题或编号>\n先 .pc list / .st list 看看有哪些卡' };
    }
    let target: SheetRecord | undefined;
    if (/^\d+$/.test(key)) {
      target = all[parseInt(key, 10) - 1];
    }
    if (!target) {
      target =
        all.find((r) => (r.title || '默认') === key) ||
        all.find((r) => (r.title || '默认').includes(key));
    }
    if (!target) {
      return { reply: `没找到角色卡「${key}」` };
    }
    const title = target.title || '默认';
    const wasCurrent = (this.store.getCurrentTitle(msg.platform, msg.userId) ?? all[0].title) === title;
    this.store.deleteSheetByTitle(msg.platform, msg.userId, title);
    if (wasCurrent) {
      const rest = this.store.listSheets(msg.platform, msg.userId);
      if (rest.length > 0) {
        this.store.setCurrentTitle(msg.platform, msg.userId, rest[0].title || '默认');
        return { reply: `✅ 已删除角色卡「${title}」，已切换到「${rest[0].title || '默认'}」` };
      }
      return { reply: `✅ 已删除角色卡「${title}」（你已没有角色卡，.coc 可重新生成）` };
    }
    return { reply: `✅ 已删除角色卡「${title}」` };
  }

  // ---------- .st 属性级子命令（主流骰娘语义） ----------

  /** 清空所有属性：.st clr */
  private doStClr(msg: IncomingMessage): EngineResult {
    const loaded = this.loadCurrentSheet(msg);
    if (!loaded) return { reply: '你还没有角色卡，没什么可清空的' };
    const { rec, sheet } = loaded;
    const keys = Object.keys(sheet.attributes);
    sheet.attributes = {};
    this.saveCurrentSheet(msg, rec, sheet);
    return { reply: `✅ 已清空 ${keys.length} 项属性（衍生值保留）\n.st export 可看剩余内容` };
  }

  /** 删除指定属性：.st del <属性>...（一次可删多个） */
  private doStDelAttr(msg: IncomingMessage, args: string[]): EngineResult {
    if (args.length === 0) {
      return { reply: '用法: .st del <属性名> [更多属性...]\n例: .st del 幸运 魔法\n（删角色卡请用 .pc del）' };
    }
    const loaded = this.loadCurrentSheet(msg);
    if (!loaded) return { reply: '你还没有角色卡' };
    const { rec, sheet } = loaded;
    const deleted: string[] = [];
    const missing: string[] = [];
    for (const rawKey of args) {
      // 兼容 `技能_侦查` 与 `侦查` 两种写法
      const k = Object.prototype.hasOwnProperty.call(sheet.attributes, rawKey) ? rawKey
        : Object.prototype.hasOwnProperty.call(sheet.attributes, `技能_${rawKey}`) ? `技能_${rawKey}`
          : null;
      if (k) {
        delete sheet.attributes[k];
        deleted.push(k);
      } else {
        missing.push(rawKey);
      }
    }
    if (deleted.length === 0) {
      return { reply: `未找到属性：${missing.join('、')}` };
    }
    this.saveCurrentSheet(msg, rec, sheet);
    let out = `✅ 已删除属性：${deleted.join('、')}`;
    if (missing.length) out += `\n⚠️ 未找到：${missing.join('、')}`;
    return { reply: out };
  }

  /** 导出属性：.st export（输出可直接复制到别的骰子的 .st 语句） */
  private doStExport(msg: IncomingMessage): EngineResult {
    const loaded = this.loadCurrentSheet(msg);
    if (!loaded) return { reply: '你还没有角色卡' };
    const { sheet } = loaded;
    const entries = Object.entries(sheet.attributes);
    if (entries.length === 0) return { reply: '当前卡没有属性可导出' };
    // 主属性放前面，技能随后，衍生值最后单列
    const order = attributeOrder(sheet.system);
    const main = entries.filter(([k]) => order.includes(k));
    const skills = entries.filter(([k]) => k.startsWith('技能_'));
    const others = entries.filter(([k]) => !order.includes(k) && !k.startsWith('技能_'));
    const fmt = (list: Array<[string, number]>) => list.map(([k, v]) => `${k}${v}`).join(' ');
    const title = sheet.title || '默认';
    return {
      reply:
        `📤 属性导出（卡「${title}」）\n` +
        (main.length ? `主属性：\n.st ${fmt(main)}\n` : '') +
        (skills.length ? `技能：\n.st ${fmt(skills)}\n` : '') +
        (others.length ? `其他：\n.st ${fmt(others)}\n` : '') +
        `可直接复制到本骰或其他骰子批量录入`,
    };
  }

  /** 保存计算表达式：.st &名=表达式（如 .st &手枪伤害=1d6+1） */
  private doStExpr(msg: IncomingMessage, args: string[]): EngineResult {
    const raw = args.join('').trim();
    if (!raw) {
      return { reply: '用法: .st &<名称>=<表达式>\n例: .st &手枪伤害=1d6+1\n之后 .r 手枪伤害 即可调用' };
    }
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      return { reply: `格式不对：${raw}\n用法: .st &<名称>=<表达式>` };
    }
    const name = raw.slice(0, eq).trim();
    const expr = raw.slice(eq + 1).trim();
    if (!name || !expr) {
      return { reply: `名称或表达式为空：${raw}` };
    }
    const loaded = this.loadCurrentSheet(msg);
    if (!loaded) return { reply: '你还没有角色卡，先 .coc 生成一张' };
    const { rec, sheet } = loaded;
    if (!sheet.expressions) sheet.expressions = {};
    sheet.expressions[name] = expr;
    this.saveCurrentSheet(msg, rec, sheet);
    return { reply: `✅ 已保存表达式「${name}」= ${expr}\n之后用 .r ${name} 调用` };
  }

  /** .pc 角色卡管理：new/tag(=switch)/list/del/save/show/nn/ren */
  private doPc(msg: IncomingMessage, args: string[]): EngineResult {
    const sub = (args[0] || '').toLowerCase();
    const rest = args.slice(1);
    switch (sub) {
      case 'new': case '新建': case 'create':
        return this.doStNew(msg, rest);
      case 'tag': case 'switch': case 'use': case '切换': case 'bind':
        return this.doStSwitch(msg, rest);
      case 'list': case '列表': case 'ls':
        return this.doStList(msg);
      case 'del': case 'delete': case '删除': case 'rm':
        return this.doSheetDelete(msg, rest);
      case 'show': case '查看':
        return this.doStShow(msg);
      case 'save': case '保存':
        // 卡本来就常驻保存，这里给个明确回执避免困惑
        return this.doStList(msg);
      case 'nn': case 'rename': case '改名':
        return this.doStSet(msg, ['name', ...rest]);
      default:
        return {
          reply:
            `角色卡管理：\n` +
            `.pc new <标题>        新建角色卡并切换\n` +
            `.pc tag <标题|编号>   切换角色卡（= .st switch）\n` +
            `.pc list             列出全部角色卡（= .st list）\n` +
            `.pc del <标题|编号>  删除角色卡\n` +
            `.pc show             查看当前卡（= .st show）\n` +
            `.pc nn <名字>        改名 / 设昵称（= .st name）`,
        };
    }
  }

  /** .ri 设定自己的先攻值（D&D）：.ri 12 / .ri +2 / .ri 1d20+3 */
  private doRi(msg: IncomingMessage, args: string[]): EngineResult {
    const raw = args.join('').trim();
    if (!raw) {
      return { reply: '用法: .ri <先攻值>\n支持 12 / +2（=D20+2）/ 1d20+3' };
    }
    let value: number;
    if (/^[+-]?\d+$/.test(raw)) {
      value = /^\+\d+$/.test(raw)
        ? 20 + parseInt(raw, 10)   // +2 视为 D20+2
        : parseInt(raw, 10);
    } else {
      try {
        value = rollExpression(raw, this.rng, 20).total;
      } catch {
        return { reply: `先攻值无效：${raw}` };
      }
    }
    this.store.addInitiative({
      platform: msg.platform,
      groupId: msg.groupId,
      name: msg.userName || msg.userId,
      value,
      createdAt: Date.now(),
    });
    return this.doInitList(msg, `✅ ${msg.userName || '你'} 的先攻值 = ${value}\n`);
  }

  /** 查看完整角色卡 */
  private doStShow(msg: IncomingMessage, args: string[] = []): EngineResult {
    const rec = this.store.getSheet(msg.platform, msg.userId);
    if (!rec) return { reply: '你还没有角色卡，发送 .coc / .coc5 / .dnd 生成一张吧' };
    try {
      const sheet = JSON.parse(rec.data) as CharacterSheet;
      // .st show <属性> → 查单项（主流骰娘语义）
      if (args.length > 0) {
        const lines: string[] = [];
        for (const rawKey of args) {
          const k = Object.prototype.hasOwnProperty.call(sheet.attributes, rawKey) ? rawKey
            : Object.prototype.hasOwnProperty.call(sheet.attributes, `技能_${rawKey}`) ? `技能_${rawKey}`
              : null;
          if (k) lines.push(`${k} = ${sheet.attributes[k]}`);
          else {
            const d = sheet.derived?.[rawKey];
            if (d !== undefined) lines.push(`${rawKey} = ${d}`);
            else lines.push(`${rawKey} = 未设置`);
          }
        }
        return { reply: lines.join('\n') };
      }
      return { reply: renderSheet(sheet) };
    } catch {
      return { reply: '角色卡数据损坏，请重新生成' };
    }
  }

  // ==================== 先攻 ====================

  /** 先攻：.init add 张三 15 */
  private doInitAdd(msg: IncomingMessage, args: string[]): EngineResult {
    if (args.length < 2) {
      return { reply: '用法: .init add <名字> <先攻值>\n例: .init add 张三 15' };
    }
    const value = parseInt(args[args.length - 1], 10);
    if (Number.isNaN(value)) {
      return { reply: `先攻值无效: ${args[args.length - 1]}` };
    }
    const name = args.slice(0, args.length - 1).join(' ');
    this.store.addInitiative({
      platform: msg.platform,
      groupId: msg.groupId,
      name,
      value,
      createdAt: Date.now(),
    });
    return this.doInitList(msg, `✅ 已加入先攻: ${name} (${value})\n`);
  }

  /** 先攻列表 */
  private doInitList(msg: IncomingMessage, header = ''): EngineResult {
    const list = this.store.listInitiative(msg.platform, msg.groupId);
    if (list.length === 0) {
      return { reply: `${header}📋 先攻列表为空` };
    }
    const lines = list.map((it, i) => `${i + 1}. ${it.name} — ${it.value}`);
    return { reply: `${header}📋 先攻顺序:\n${lines.join('\n')}` };
  }

  // ==================== 跑团工具 ====================

  /** 抽牌：.draw [牌堆] [数量] */
  private doDraw(msg: IncomingMessage, args: string[]): EngineResult {
    let deckName = '塔罗';
    let count = 1;
    for (const a of args) {
      const key = a.toLowerCase();
      if (DECK_ALIAS[key]) deckName = DECK_ALIAS[key];
      else if (/^\d+$/.test(a)) count = parseInt(a, 10);
    }

    const gen = CARD_DECKS[deckName];
    if (!gen) {
      return { reply: `没有「${deckName}」这个牌堆。可用: ${Object.keys(CARD_DECKS).join(' / ')}（发送 .drawlist 查看）` };
    }
    count = Math.max(1, Math.min(10, count));

    const pool = gen();
    if (count > pool.length) {
      return { reply: `牌堆「${deckName}」只有 ${pool.length} 张，抽不了 ${count} 张` };
    }

    // 不放回抽取
    const drawn: string[] = [];
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(this.rng() * pool.length);
      drawn.push(pool.splice(idx, 1)[0]);
    }

    // 塔罗附正逆位，扑克不需要
    const isTarot = deckName === '塔罗';
    const lines = drawn.map((c, i) => {
      const orientation = isTarot ? (this.rng() < 0.5 ? ' 正位' : ' 逆位') : '';
      return `${i + 1}. ${c}${orientation}`;
    });

    const name = msg.userName ? `【${msg.userName}】` : '';
    const intro = isTarot
      ? '🌙 命运的低语传来，塔罗牌泛起微光……你抽出了'
      : '🎴 你伸手从牌堆里抽出了';
    const tail = isTarot && count === 1 ? '（正逆位各半，信则灵～）' : '';
    const head = `🃏 ${name}${intro}【${deckName}】×${count}：${tail}`;
    return { reply: `${head}\n${lines.join('\n')}` };
  }

  /** 列出可用牌堆 */
  private doDrawlist(): EngineResult {
    const lines = Object.entries(CARD_DECKS).map(([n, gen]) => `· ${n} — ${gen().length} 张`);
    return { reply: `🃏 可用牌堆:\n${lines.join('\n')}\n用法: .draw 塔罗 3` };
  }

  /** 随机名字：.name cn/en/jp [数量] */
  private doName(args: string[]): EngineResult {
    let lang: NameLang = 'cn';
    let count = 10;
    for (const a of args) {
      const low = a.toLowerCase();
      if (low === 'cn' || a === '中' || a === '中文') lang = 'cn';
      else if (low === 'en' || a === '英' || a === '英文') lang = 'en';
      else if (low === 'jp' || a === '日' || a === '日文') lang = 'jp';
      else if (/^\d+$/.test(a)) count = parseInt(a, 10);
    }
    count = Math.max(1, Math.min(20, count));

    const t = NAME_TABLES[lang];
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const sur = t.surname[Math.floor(this.rng() * t.surname.length)];
      // 名字用「不重复索引」抽取，避免出现「伟伟」这种叠字
      const pickedIdx = new Set<number>();
      let given = '';
      let guard = 0;
      while (given.length < t.givenLen && guard++ < 200) {
        const idx = Math.floor(this.rng() * t.given.length);
        if (pickedIdx.has(idx)) continue;
        pickedIdx.add(idx);
        given += t.given[idx];
      }
      // 英文名是「名 姓」，中日是「姓 名」
      out.push(t.spaced ? `${given} ${sur}` : `${sur}${given}`);
    }

    const langText = lang === 'cn' ? '中文' : lang === 'en' ? '英文' : '日文';
    return { reply: `📛 命运为你摇出了${langText}名 ×${count}:\n${out.join('\n')}` };
  }

  /** 顺序重排：.who A B C */
  private doWho(args: string[]): EngineResult {
    // 支持空格分隔，也支持逗号 / 顿号分隔
    const items = args
      .flatMap((a) => a.split(/[,，、]/))
      .map((s) => s.trim())
      .filter(Boolean);

    if (items.length < 2) {
      return { reply: '用法: .who A B C\n至少给两项才能重排' };
    }
    if (items.length > 50) {
      return { reply: '最多支持 50 项' };
    }

    // Fisher-Yates 洗牌
    const arr = items.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return { reply: `🔀 命运的轮盘悄然转动……新的出场顺序已揭晓：\n${arr.map((x, i) => `${i + 1}. ${x}`).join('\n')}` };
  }

  // ==================== 统计与娱乐 ====================

  /**
   * 掷骰统计。
   * @param personal true = 我的统计（跨群汇总），false = 本群统计
   */
  private doStat(msg: IncomingMessage, args: string[], personal: boolean): EngineResult {
    const today = args.some((a) => a === '今日' || a === '本日' || a.toLowerCase() === 'today');
    let since: number | undefined;
    if (today) {
      const d = new Date();
      since = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }

    // 个人统计跨群汇总；群统计限定当前群
    const s = this.store.rollStats({
      platform: msg.platform,
      groupId: personal ? undefined : msg.groupId,
      userId: personal ? msg.userId : undefined,
      since,
    });

    const scopeText = personal ? '我的掷骰统计（跨群汇总）' : '本群掷骰统计';
    const timeText = today ? '今日' : '全部时间';

    if (s.count === 0) {
      return { reply: `📊 ${scopeText} · ${timeText}\n还没有任何掷骰记录，发送 .r 3d6 试试吧` };
    }

    const lines: string[] = [];
    lines.push(`📊 ${scopeText} · ${timeText}`);
    lines.push(`总掷骰 ${s.count} 次 | 参与 ${s.users} 人`);
    lines.push(`平均 ${s.avg.toFixed(1)} | 最高 ${s.max} | 最低 ${s.min}`);

    if (s.d100.count > 0) {
      lines.push('');
      lines.push(`百分骰（1d100）共 ${s.d100.count} 次`);
      lines.push(`大成功 ${s.d100.crits} 次 | 大失败 ${s.d100.fumbles} 次`);
      const labels = ['1-20  ', '21-40 ', '41-60 ', '61-80 ', '81-100'];
      const maxBucket = Math.max(...s.d100.buckets, 1);
      s.d100.buckets.forEach((v, i) => {
        const barLen = Math.round((v / maxBucket) * 12);
        lines.push(`${labels[i]} ${'█'.repeat(barLen)} ${v}`);
      });
    }

    if (!personal && s.topUsers.length > 0) {
      lines.push('');
      const top = s.topUsers.map((u) => `${u.userName}(${u.count})`).join('  ');
      lines.push(`掷骰最多: ${top}`);
    }

    if (s.recent.length > 0) {
      lines.push('');
      lines.push('最近记录:');
      for (const r of s.recent.slice(0, 5)) {
        const who = personal ? '' : `${r.userName || r.userId} `;
        lines.push(`· ${who}${r.expression} = ${r.total}`);
      }
    }

    return { reply: lines.join('\n') };
  }

  /**
   * 今日人品。
   *
   * 用「平台+用户+日期」做哈希种子，保证同一天同一人结果固定不变 ——
   * 如果直接用随机数，玩家反复发 .jrrp 就能刷出满意的人品值，失去意义。
   */
  private doJrrp(msg: IncomingMessage): EngineResult {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const seed = `${msg.platform}:${msg.userId}:${day}`;
    const value = (fnv1a(seed) % 100) + 1;
    const name = msg.userName ? `【${msg.userName}】` : '';

    // 宜 / 忌 / 幸运色 / 幸运物：全部基于「日期+用户」哈希，保证同一天同一人固定不变
    const { title, line } = jrrpFortune(value);
    const yi = JRRP_YI[fnv1a(seed + '|yi') % JRRP_YI.length];
    const ji = JRRP_JI[fnv1a(seed + '|ji') % JRRP_JI.length];
    const color = JRRP_COLORS[fnv1a(seed + '|color') % JRRP_COLORS.length];
    const item = JRRP_ITEMS[fnv1a(seed + '|item') % JRRP_ITEMS.length];
    const poem = JRRP_POEMS[fnv1a(seed + '|poem') % JRRP_POEMS.length];

    return {
      reply:
        `🎋 ${name}今日人品: ${value}/100 ${bar(value)}\n` +
        `【${title}】${line}\n` +
        `🔆 幸运色：${color}　🎁 幸运物：${item}\n` +
        `✅ 今日宜：${yi}　⛔ 今日忌：${ji}\n` +
        `（${day} · ${poem}）`,
    };
  }

  /** 咕咕咕 */
  private doGugu(): EngineResult {
    const text = GUGU_TEXTS[Math.floor(this.rng() * GUGU_TEXTS.length)];
    return { reply: `🕊️ ${text}` };
  }

  // ==================== 跑团日志 ====================

  /**
   * 取本群的「当前日志」；没有进行中的就退而取最后一场已结束的。
   * 这样 `.log get` / `.log stat` 在团结束后依然能对上一场生效。
   */
  private latestSession(msg: IncomingMessage): LogSession | undefined {
    const cur = this.store.getCurrentSession(msg.platform, msg.groupId);
    if (cur) return cur;
    return this.store.listLogSessions({ platform: msg.platform, groupId: msg.groupId, limit: 1 })[0];
  }

  /** 默认日志名 */
  private defaultLogName(): string {
    // formatTime 给的是 2026-10-02 21:08:00，截到分钟即可
    return `跑团日志 ${formatTime(Date.now(), 'dash').slice(0, 16)}`;
  }

  /** 新建日志并开始记录：.log new [名称] */
  private doLogNew(msg: IncomingMessage, args: string[]): EngineResult {
    const p = this.prefixOf(msg.platform, msg.groupId);
    if (msg.isPrivate) {
      return { reply: '⚠️ 跑团日志只能在群里使用（需要群的上下文才能记录）' };
    }
    if (!this.canManageLog(msg)) return { reply: '⛔ 只有管理员可以新建日志' };

    const existing = this.store.getCurrentSession(msg.platform, msg.groupId);
    if (existing) {
      return {
        reply:
          `⚠️ 本群已有未结束的日志「${existing.name}」(#${existing.id}，${sessionStatusText(existing.status)})。\n` +
          `先发 ${p}log end 结束它，或 ${p}log on 继续记录。`,
      };
    }

    const name = args.join(' ').trim() || this.defaultLogName();
    const id = this.store.createLogSession({
      platform: msg.platform,
      groupId: msg.groupId,
      groupName: msg.groupName,
      name,
      createdBy: msg.userId,
    });

    return {
      reply: [
        `📖 已新建日志「${name}」(#${id})，开始记录。`,
        '',
        '从现在起，群里发生的对话都会被记下来：',
        '· 图片 / 表情 / @ 会以 [图] [表情] @名字 的形式保留',
        '· 以 ( （ 【 开头的发言记为「场外」，复盘时可一键剔除',
        '· 想让自己整场的发言都被标为场外，先发 .ob 切换观众模式',
        '',
        `.log off 暂停 ｜ .log end 结束并导出 ｜ .log stat 看统计`,
      ].join('\n'),
    };
  }

  /** 开始 / 暂停记录 */
  private doLogSetRecording(msg: IncomingMessage, on: boolean): EngineResult {
    const p = this.prefixOf(msg.platform, msg.groupId);
    if (msg.isPrivate) return { reply: '⚠️ 跑团日志只能在群里使用' };
    if (!this.canManageLog(msg)) return { reply: `⛔ 只有管理员可以${on ? '开始' : '暂停'}记录` };

    const cur = this.store.getCurrentSession(msg.platform, msg.groupId);
    if (!cur) {
      return { reply: `⚠️ 本群还没有日志。先发 ${p}log new [名称] 新建一个。` };
    }

    const count = this.store.countLogMessages(cur.id);
    if (on) {
      if (cur.status === 'recording') {
        return { reply: `📖 日志「${cur.name}」正在记录中（已 ${count} 条）。` };
      }
      this.store.setLogSessionStatus(cur.id, 'recording');
      return { reply: `▶️ 已继续记录「${cur.name}」(#${cur.id})，当前 ${count} 条。` };
    }

    if (cur.status === 'paused') {
      return { reply: `⏸ 日志「${cur.name}」本来就是暂停状态（${count} 条）。发 ${p}log on 继续。` };
    }
    this.store.setLogSessionStatus(cur.id, 'paused');
    return { reply: `⏸ 已暂停记录「${cur.name}」（${count} 条）。发 ${p}log on 继续，或 ${p}log end 结束导出。` };
  }

  /** 结束记录并导出：.log end [json] */
  private doLogEnd(msg: IncomingMessage, args: string[]): EngineResult {
    if (msg.isPrivate) return { reply: '⚠️ 跑团日志只能在群里使用' };
    if (!this.canManageLog(msg)) return { reply: '⛔ 只有管理员可以结束记录' };

    const cur = this.store.getCurrentSession(msg.platform, msg.groupId);
    if (!cur) return { reply: '⚠️ 本群没有进行中的日志' };

    this.store.setLogSessionStatus(cur.id, 'ended');
    return this.buildLogExport(cur.id, wantsJson(args), `🏁 已结束日志「${cur.name}」`);
  }

  /** 查看日志状态：.log */
  private doLogStatus(msg: IncomingMessage): EngineResult {
    const p = this.prefixOf(msg.platform, msg.groupId);
    const cur = this.store.getCurrentSession(msg.platform, msg.groupId);

    if (!cur) {
      const last = this.store.listLogSessions({ platform: msg.platform, groupId: msg.groupId, limit: 1 })[0];
      if (!last) {
        return { reply: `📭 本群还没有任何日志。发 ${p}log new [名称] 开始记录。` };
      }
      return {
        reply:
          `📭 本群当前没有进行中的日志。\n` +
          `最后一场：「${last.name}」(#${last.id})，${last.messageCount ?? 0} 条，创建于 ${formatTime(last.createdAt)}\n` +
          `发 ${p}log new [名称] 新建，或 ${p}log get 导出上一场。`,
      };
    }

    const count = this.store.countLogMessages(cur.id);
    return {
      reply: [
        `📖 当前日志「${cur.name}」(#${cur.id})`,
        `状态：${sessionStatusText(cur.status)} ｜ 条数：${count} ｜ 创建：${formatTime(cur.createdAt)}`,
        `${p}log off 暂停 ｜ ${p}log end 结束导出 ｜ ${p}log stat 看统计 ｜ ${p}log get 导出`,
      ].join('\n'),
    };
  }

  /** 列出本群日志：.log list */
  private doLogList(msg: IncomingMessage): EngineResult {
    const p = this.prefixOf(msg.platform, msg.groupId);
    const list = this.store.listLogSessions({ platform: msg.platform, groupId: msg.groupId, limit: 10 });
    if (list.length === 0) return { reply: `📭 本群还没有日志记录。发 ${p}log new [名称] 开始。` };

    const lines = [`📚 本群日志（最近 ${list.length} 场）`];
    for (const s of list) {
      lines.push(`#${s.id} ${s.name} — ${sessionStatusText(s.status)}｜${s.messageCount ?? 0} 条｜${formatTime(s.createdAt)}`);
    }
    lines.push(`用 ${p}log get <编号> 导出指定日志`);
    return { reply: lines.join('\n') };
  }

  /** 导出日志：.log get [编号] [json] */
  private doLogGet(msg: IncomingMessage, args: string[]): EngineResult {
    const idArg = args.find((a) => /^\d+$/.test(a));
    const session = idArg ? this.store.getLogSession(Number(idArg)) : this.latestSession(msg);

    if (!session) {
      const p = this.prefixOf(msg.platform, msg.groupId);
      return { reply: `📭 本群没有可导出的日志。发 ${p}log new [名称] 开始记录。` };
    }
    if (session.groupId !== msg.groupId) {
      return { reply: '⛔ 该日志不属于本群' };
    }
    return this.buildLogExport(
      session.id,
      wantsJson(args),
      `📤 导出日志「${session.name}」(#${session.id})`,
    );
  }

  /** 删除日志：.log del [编号] */
  private doLogDel(msg: IncomingMessage, args: string[]): EngineResult {
    if (!this.canManageLog(msg)) return { reply: '⛔ 只有管理员可以删除日志' };

    const idArg = args.find((a) => /^\d+$/.test(a));
    const session = idArg
      ? this.store.getLogSession(Number(idArg))
      : this.store.getCurrentSession(msg.platform, msg.groupId);

    if (!session) return { reply: '⚠️ 没有找到要删除的日志' };
    if (session.groupId !== msg.groupId) return { reply: '⛔ 该日志不属于本群' };

    const count = this.store.countLogMessages(session.id);
    this.store.deleteLogSession(session.id);
    return { reply: `🗑 已删除日志「${session.name}」(#${session.id})，连同 ${count} 条记录。` };
  }

  /** 日志统计：.log stat */
  private doLogStat(msg: IncomingMessage): EngineResult {
    const p = this.prefixOf(msg.platform, msg.groupId);
    const session = this.latestSession(msg);
    if (!session) return { reply: `📭 本群还没有日志。发 ${p}log new [名称] 开始记录。` };

    const st = this.store.logMessageStats(session.id);
    if (st.total === 0) return { reply: `📊 日志「${session.name}」还没有记录内容。` };

    const kindName: Record<string, string> = {
      chat: '普通发言', dice: '骰点输出', ooc: '场外', command: '指令', image: '图片',
    };
    const dist = Object.entries(st.byKind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${kindName[k] || k} ${v}`)
      .join('｜');

    return {
      reply: [
        `📊 日志「${session.name}」(#${session.id}) 统计`,
        `共 ${st.total} 条 ｜ 参与 ${st.speakers} 人 ｜ ${sessionStatusText(session.status)}`,
        `时间：${formatTime(st.firstAt)} → ${formatTime(st.lastAt)}`,
        `性质：${dist}`,
        '（导出后染色器可按这些性质一键剔除场外 / 指令）',
      ].join('\n'),
    };
  }

  /** 切换观众模式：.ob */
  private doOb(msg: IncomingMessage): EngineResult {
    if (msg.isPrivate) return { reply: '⚠️ 观众模式需要在群里使用' };
    const on = this.recorder.toggleOb(msg.platform, msg.groupId, msg.userId);
    if (on) {
      return {
        reply:
          '🕶 已开启观众模式。\n' +
          '从现在起你的发言会被标记为隐藏角色，复盘导出后可以一键剔除。\n' +
          '（再发一次 .ob 关闭）',
      };
    }
    return { reply: '👤 已关闭观众模式，发言恢复正常记录。' };
  }

  /**
   * 生成日志文件。
   *
   * 文件写到 logDir，并由路由层尝试上传到群里；
   * 上传失败时会降级为「直接发前若干行文本」，保证内容一定能看到。
   */
  private buildLogExport(sessionId: number, asJson: boolean, headline: string): EngineResult {
    const session = this.store.getLogSession(sessionId);
    if (!session) return { reply: '⚠️ 日志不存在' };

    const messages = this.store.listLogMessages(sessionId);
    if (messages.length === 0) return { reply: `${headline}\n（本次没有任何记录）` };

    const content = asJson ? exportLogJSON(session, messages) : exportLogText(session, messages);
    const ext = asJson ? 'json' : 'txt';
    const fileName = `${safeFileName(session.name)}-${session.id}.${ext}`;
    const sizeKb = (Buffer.byteLength(content, 'utf-8') / 1024).toFixed(1);
    // 标题里统一带上编号，方便后续用 .log get <编号> 再取
    const title = headline.includes('(#') ? headline : `${headline}(#${session.id})`;

    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      const full = path.join(this.logDir, fileName);
      fs.writeFileSync(full, content, 'utf-8');
      return {
        reply: [
          title,
          `📄 ${fileName}（${messages.length} 条，${sizeKb} KB）`,
          asJson
            ? '主流骰娘 JSON 格式，可直接导入日志染色器'
            : 'QQ 风格文本，可直接导入染色器或存档',
        ].join('\n'),
        files: [{ path: full, name: fileName }],
      };
    } catch (e) {
      // 写盘失败：把内容截断成文本发出去，至少不丢信息
      const head = content.split('\n').slice(0, 120).join('\n');
      return {
        reply: `${title}\n⚠️ 生成文件失败（${(e as Error).message}），以下为前 120 行：\n\n${head}`,
      };
    }
  }

  // ==================== 群配置 ====================

  /** 群配置：.set <key> <value> */
  private doSet(msg: IncomingMessage, args: string[]): EngineResult {
    if (!this.isAdmin(msg.userId)) {
      return { reply: '⛔ 只有管理员可以修改群配置' };
    }
    if (args.length < 2) {
      return { reply: '用法: .set <键> <值>\n可用键: prefix(指令前缀), defaultDice(默认骰)' };
    }
    const [key, ...rest] = args;
    const value = rest.join(' ');
    const allowed = ['prefix', 'defaultDice'];
    if (!allowed.includes(key)) {
      return { reply: `不支持的配置键: ${key}（可用: ${allowed.join(', ')}）` };
    }
    this.store.setSetting(msg.platform, msg.groupId, key, value);
    return { reply: `✅ 已设置 ${key} = ${value}` };
  }
}
