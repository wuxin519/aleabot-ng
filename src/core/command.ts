/**
 * 命令解析层：把聊天消息文本解析为结构化指令。
 * 命令前缀默认 "."，可在群配置中修改；英文句点「.」与中文句号「。」等价，
 * 中文输入法打出的「。r 3d6」与「.r 3d6」效果完全相同。
 *
 * 【紧贴写法】动词与表达式之间可以不空格（主流骰娘 / Dice! 习惯）：
 *   .r3d100 ≡ .r 3d100    .r3#2d50 ≡ .r 3#2d50    .ra侦查 60 ≡ .ra 侦查 60
 *
 * 【基础骰点】
 *   .r 3d6+2          普通掷骰（支持 k/kh/kl/dh/dl 取高取低）
 *   .r 3#2d50         多轮掷骰：3# 重复 3 次
 *   .r d / .r d50     省略面数 → 群默认骰面（默认 100）
 *   .r d20优势        D&D 优势骰（= 2d20kh1）；劣势同理
 *   .r f              Fate 命运骰（[---+]）
 *   .r 5a6            WoD 无限骰（成功线 8、面数 10，≥6 加骰）
 *   .r 4c3            双十字骰（≥3 暴击续轮）
 *   .r                掷默认骰（群配置，默认 1d100）
 *   .rh 3d6           暗骰：群里只提示，结果私聊
 *   .rb 侦查 60        奖励骰检定（十位骰取小）
 *   .rp 侦查 60        惩罚骰检定（十位骰取大）
 *
 * 【COC 检定】
 *   .ra 侦查 60        COC 技能检定（带目标值）
 *   .ra 侦查           使用角色卡上的技能值检定
 *   .ra 侦查+10        属性调整（+10 / -5 / +1d4 都行）
 *   .ra 困难侦查       难度前缀：困难=÷2 极难=÷5 大成功（要求达到该等级才算成功）
 *   .rc 侦查           规则书检定（大成功/大失败按规则书，不看房规）
 *   .ra 3#p手枪        多列检定：3# 重复 3 次，p 带惩罚骰，b 带奖励骰
 *   .sc [成功扣/失败扣] 理智检定（默认 1/1d6，自动读写卡上 SAN）
 *   .sc 1/1d6 --cap=3  理智损失上限（习惯恐怖）；--half 减半（神话淬炼）
 *   .setcoc 0..5|dg    切换房规（0 规则书 / 2 常用 / dg 骰运；.setcoc details 看全表）
 *   .hp / .san         查看（.hp+1 / .san-1d4 增减并写回卡）
 *   .en 侦查           技能成长检定（1d100 > 技能值则 +1d10）
 *   .en 侦查 聆听      多个技能一次成长；+0/1d6 自定义成长点数
 *   .ti / .li          掷临时性疯狂 / 长期性疯狂表
 *
 * 【角色卡】
 *   .coc / .coc7       生成 COC 7 版角色卡
 *   .coc5              生成 COC 5 版角色卡（天命）
 *   .dnd / .dnd5e      生成 D&D 5e 角色卡
 *   .coc 5 / .coc5 5   一次掷 5 组主属性（只主属性，技能自定；不写卡）
 *   .st 力量 60        设置/查看角色卡属性（也支持 .st 力量88 连写）
 *   .st 力量88 体质70  一次录入多个属性（空格可省）
 *   .st 60 50 70 ...   按属性顺序录入（免键名，顺序见 .st show）
 *   .st hp+1           增减属性（掷骰表达式均可）
 *   .st show [属性]    查看完整角色卡 / 单项属性
 *   .st del <属性>...  删除指定属性（删角色卡用 .pc del）
 *   .st clr            清空所有属性
 *   .st export         导出属性（可直接复制到别的骰子）
 *   .st &名=表达式     保存计算表达式，之后 .r 名 调用
 *   .st name 张三      设定角色卡名字（同时是 bot 称呼你的昵称，跨卡通用）
 *   .st new 调查员A    新建一张角色卡并切换过去（多卡）
 *   .st list           列出我的全部角色卡（标 * 为当前卡）
 *   .st switch 调查员A 切换角色卡（也可写编号，如 .st switch 2）
 *   .pc new/tag/list/del/show/nn   角色卡管理（主流骰娘 .pc 系列）
 *   .nn <名字>         同 .st name
 *
 * 【跑团工具】
 *   .init add 张三 15  先攻：加入
 *   .init list         先攻：查看
 *   .init clr          先攻：清空
 *   .draw 塔罗 3        抽 3 张塔罗
 *   .drawlist          列出可用牌堆
 *   .coin              抛硬币
 *   .name cn 10         随机生成 10 个中文名
 *   .who A B C         把若干项随机打乱顺序
 *
 * 【统计与娱乐】
 *   .stat              本群掷骰统计（可加「今日」）
 *   .hiy               我个人的掷骰统计（可加「今日」）
 *   .jrrp              今日人品（同一天同一人结果固定）
 *   .gugu              咕咕咕
 *
 * 【查询与帮助】
 *   .help              发送指令图（无参数）
 *   .help 侦查          查询规则词条 / 技能基础值
 *   .rule 成功等级      同 .help <词条>
 *   .bot on / off      群内开关骰子（管理员）
 *   .set <key> <value> 群配置（仅管理员）
 *   .bak               触发一次数据备份（仅管理员，私聊）
 *
 * 【跑团日志】（记录整场团的对话，可导出给日志染色器）
 *   .log new [名称]    新建日志并开始记录（同群同时只能有一个）
 *   .log on / off      继续 / 暂停记录
 *   .log end [json]    结束记录并导出文件
 *   .log get [json]    导出当前（或最后一场）日志
 *   .log list          列出本群的日志
 *   .log del [id]      删除日志
 *   .log stat          当前日志统计
 *   .log               查看当前日志状态
 *   .ob                切换观众模式（发言被标记为隐藏，方便复盘时剔除）
 *   以上均可写作无空格形式：.lognew / .logon / .logoff / .logend ...
 */

/** 命令类型枚举 */
export type CommandType =
  | 'roll'
  | 'roll-hidden'
  | 'roll-default'
  | 'roll-bonus'
  | 'roll-penalty'
  | 'check'
  | 'check-rc'
  | 'growth'
  | 'madness-ti'
  | 'madness-li'
  | 'sc'
  | 'setcoc'
  | 'coin'
  | 'bot'
  | 'hp'
  | 'san'
  | 'coc'
  | 'coc5'
  | 'dnd'
  | 'init-add'
  | 'init-list'
  | 'init-clear'
  | 'st-set'
  | 'st-show'
  | 'st-new'
  | 'st-switch'
  | 'st-list'
  | 'st-clr'
  | 'st-delattr'
  | 'st-export'
  | 'st-expr'
  | 'pc'
  | 'nn'
  | 'ri'
  | 'jrrp'
  | 'gugu'
  | 'who'
  | 'name'
  | 'stat'
  | 'hiy'
  | 'draw'
  | 'drawlist'
  | 'help'
  | 'help-kw'
  | 'log-new'
  | 'log-on'
  | 'log-off'
  | 'log-end'
  | 'log-list'
  | 'log-get'
  | 'log-del'
  | 'log-stat'
  | 'log-status'
  | 'ob'
  | 'set'
  | 'backup'
  | 'unknown';

/** 解析结果 */
export interface ParsedCommand {
  type: CommandType;
  /** 原始命令动词，如 "r"、"ra" */
  verb: string;
  /** 参数（表达式/技能名等） */
  args: string[];
  /** 原始整串 */
  raw: string;
}

/**
 * 帮助文本（纯文字兜底版）。
 *
 * 正常情况下 `.help` 会发送指令图；只有在图片缺失（未部署或上传失败）时，
 * 才会退化成这段文字。因此这里保持精简，只列最常用的指令。
 */
export const HELP_TEXT = [
  '【AleaBot 指令表】（发送 .help 可查看图示版）',
  '',
  '■ 提示：所有指令都支持「紧贴写法」——动词与参数间的空格可省略，如 .r3d100 / .ra侦查60 / .boton / .sn张三',
  '.r <表达式>       如 .r 3d6+2 / .r 4d6k3 / .r 2d20kh1 / .r d20优势',
  '.r 3#2d50         多轮掷骰（重复 3 次）',
  '.r f / .r 5a6     Fate 命运骰 / WoD 无限骰（4c3 = 双十字）',
  '.rh <表达式>      暗骰（群里只提示，结果私聊）',
  '.rb <技能> [值]   奖励骰检定（十位骰取小）',
  '.rp <技能> [值]   惩罚骰检定（十位骰取大）',
  '',
  '■ COC 检定',
  '.ra <技能> [值]   COC 检定，如 .ra 侦查 60（省略值则读角色卡）',
  '.ra 侦查+10        属性调整；.ra 困难侦查 难度前缀（困难/极难/大成功）',
  '.rc <技能> [值]    规则书检定（大成功/大失败按规则书，不看房规）',
  '.ra 3#p手枪       多列检定：3# 重复 3 次，p 惩罚骰 / b 奖励骰',
  '.sc [成功扣/失败扣] 理智检定（默认 1/1d6，自动写回卡）',
  '.sc 1/1d6 --cap=3  理智损失上限；加 --half 减半（可同用）',
  '.rav @对手 技能   对抗检定（双方读卡各掷）',
  '.setcoc 0..5|dg   切换房规（.setcoc details 看全表）',
  '.hp / .san        查看；.hp+1 / .san-1d4 增减并写回',
  '.en <技能>...     技能成长（可一次多个）；+0/1d6 自定义成长点数',
  '.ti / .li         临时性疯狂 / 长期性疯狂表',
  '',
  '■ 角色卡',
  '.coc / .coc7      生成 COC 7 版角色卡',
  '.coc 5            一次掷 5 组主属性（只主属性，技能自定，不写卡）',
  '.coc5 / .coc5 5   COC 5 版（天命）；带数字＝掷多组主属性',
  '.dnd / .dnd 4     D&D 5e 角色卡；带数字＝掷多组属性',
  '.st <键> [值]     设置/查看属性；.st show 看全卡；.st hp+1 增减',
  '.st 力量88 体质70  一次录入多个属性（空格可省，如 .st力量88体质70）',
  '.st 60 50 70 ...  按属性顺序录入（免键名，顺序见 .st show）',
  '.st show <属性>   只看某项；.st del <属性>... 删属性；.st clr 全清',
  '.st export        导出属性（可复制到别的骰子）',
  '.st &名=表达式    保存表达式，之后 .r 名 调用（如 .st &手枪伤害=1d6+1）',
  '.st name <名字> / .sn <名字>  设置角色卡名字（同时也是 bot 称呼你的昵称）',
  '.st new <标题>    新建角色卡并切换（多卡）',
  '.st list          列出全部角色卡（* 为当前卡）',
  '.st switch <标题或编号>  切换角色卡',
  '.pc new/tag/list/del/show/nn  角色卡管理（删卡用 .pc del）',
  '.ri <值>          设定自己的先攻值（+2 视为 D20+2）',
  '',
  '■ 跑团工具',
  '.init add <名> <值>  加入先攻；.init list 查看；.init clr 清空',
  '.draw [牌堆] [数量]  抽牌（塔罗 / 扑克）',
  '.drawlist         查看可用牌堆',
  '.coin             抛硬币',
  '.name <cn|en|jp> [数量]  随机名字',
  '.who A B C        随机打乱顺序',
  '',
  '■ 统计与娱乐',
  '.stat [今日]      本群掷骰统计',
  '.hiy [今日]       我的掷骰统计',
  '.jrrp             今日人品',
  '.gugu             咕咕咕',
  '',
  '■ 跑团日志',
  '.log new [名称]   新建日志并开始记录（同群同时只能有一个）',
  '.log on / .log off   继续 / 暂停记录',
  '.log end [json]   结束记录并导出（json = 主流骰娘格式，可丢染色器）',
  '.log get [json]   导出当前/最后一场日志',
  '.log list / del / stat   列表 / 删除 / 统计',
  '.ob               切换观众模式（发言标记为隐藏）',
  '',
  '■ 查询与管理',
  '.help <词条>      查询规则，如 .help 成功等级 / .help 侦查',
  '.bot on / off     群内开关骰子；.bot bye 退群',
  '.set <键> <值>    群配置（管理员）',
  '.bak              备份数据（管理员私聊）',
].join('\n');

/**
 * 指令前缀的等价字符表。
 * 玩家用中文输入法时句号会打成全角「。」，所以当群前缀是英文句点「.」时，
 * 「。」同样可以触发指令（例如 。r 3d6 ≡ .r 3d6）。
 */
const PREFIX_ALIASES: Record<string, string[]> = {
  '.': ['.', '。'],
  '。': ['。', '.'],
};

/** 取某个群配置前缀对应的全部等价前缀（去重） */
export function prefixAliases(prefix = '.'): string[] {
  const p = prefix || '.';
  return Array.from(new Set(PREFIX_ALIASES[p] ?? [p]));
}

/**
 * 解析一条消息。若不以命令前缀开头，返回 null（表示无需处理）。
 * 前缀支持全角「。」等价（见 PREFIX_ALIASES）。
 * @param text 消息正文
 * @param prefix 命令前缀（默认 "."）
 */
export function parseCommand(text: string, prefix = '.'): ParsedCommand | null {
  const trimmed = text.trim();
  // 逐个尝试等价前缀（"." 与 "。" 互认），取最长匹配的那个，
  // 避免多字符前缀（如 "!!"）被短前缀提前吃掉一部分。
  const aliases = prefixAliases(prefix)
    .filter((a) => trimmed.startsWith(a))
    .sort((a, b) => b.length - a.length);
  if (aliases.length === 0) return null;
  const usedPrefix = aliases[0];

  const body = trimmed.slice(usedPrefix.length).trim();
  if (!body) return null;

  // 拆分：第一个词是动词，其余为参数
  const sp = body.search(/\s/);
  const verb = (sp === -1 ? body : body.slice(0, sp)).toLowerCase();
  const rest = sp === -1 ? '' : body.slice(sp + 1).trim();
  const args = rest ? rest.split(/\s+/) : [];

  const raw = trimmed;

  switch (verb) {
    // ---------- 掷骰 ----------
    case 'r':
    case 'roll':
      if (args.length === 0) return { type: 'roll-default', verb, args, raw };
      return { type: 'roll', verb, args, raw };

    case 'rb':
    case '奖励骰':
      return { type: 'roll-bonus', verb, args, raw };

    case 'rp':
    case '惩罚骰':
      return { type: 'roll-penalty', verb, args, raw };

    // 暗骰：群里只提示，结果私聊给掷骰者
    case 'rh':
    case '暗骰':
      return { type: 'roll-hidden', verb, args, raw };

    // ---------- COC 检定 ----------
    case 'ra':
      return { type: 'check', verb, args, raw };

    // .rc 规则书检定（主流骰娘语义：大成功/大失败按规则书，不看房规）
    case 'rc':
      return { type: 'check-rc', verb, args, raw };

    case 'en':
    case '成长':
    case '成长检定':
      return { type: 'growth', verb, args, raw };

    case 'ti':
    case '临时疯狂':
      return { type: 'madness-ti', verb, args, raw };

    case 'li':
    case '长期疯狂':
    case '总结疯狂':
      return { type: 'madness-li', verb, args, raw };

    // ---------- COC 扩展（v1.2）----------
    // 理智检定：.sc [成功扣][/失败扣] [原因]
    case 'sc':
    case '理智检定':
      return { type: 'sc', verb, args, raw };

    // 房规切换：.setcoc [0|1|2|details]
    case 'setcoc':
    case '房规':
      return { type: 'setcoc', verb, args, raw };

    // HP / SAN 快捷查看与增减：.hp / .hp+1 / .san-1d4
    case 'hp':
    case '生命':
    case '生命值':
      return { type: 'hp', verb, args, raw };

    case 'san':
    case '理智值':
      return { type: 'san', verb, args, raw };

    // ---------- 骰子开关 / 娱乐 ----------
    // .bot on / .bot off / .bot bye（也接受 .boton / .botoff / .botbye 无空格形式）
    case 'bot':
    case 'boton':
    case 'botoff':
    case 'botbye': {
      // .bot on / .botoff 等价：无空格形式拆成子命令
      let sub: string[] = args;
      if (verb === 'boton') sub = ['on'];
      else if (verb === 'botoff') sub = ['off'];
      else if (verb === 'botbye') sub = ['bye'];
      return { type: 'bot', verb, args: sub, raw };
    }

    // 抛硬币：.coin [数量]
    case 'coin':
    case '硬币':
      return { type: 'coin', verb, args, raw };

    // ---------- 角色卡 ----------
    case 'coc':
    case 'coc7':
      return { type: 'coc', verb, args, raw };

    case 'coc5':
    case '天命':
      return { type: 'coc5', verb, args, raw };

    case 'dnd':
    case 'dnd5e':
    case 'dnd5':
      return { type: 'dnd', verb, args, raw };

    case 'st':
    case '属性': {
      const sub = args[0];
      const subLower = (sub || '').toLowerCase();
      // 列出属性：`.st show` 全卡 / `.st show 侦查` 单项（带属性名时只显示该项）
      if (sub === 'show' || sub === '全部') {
        return { type: 'st-show', verb, args: args.slice(1), raw };
      }
      if (subLower === 'show') {
        return { type: 'st-show', verb, args: args.slice(1), raw };
      }
      // 清空所有属性
      if (subLower === 'clr' || sub === '清空') {
        return { type: 'st-clr', verb, args: [], raw };
      }
      // 删除指定属性（主流骰娘语义：.st del <属性>...，不是删卡）
      if (subLower === 'del' || subLower === 'delete' || sub === '删除') {
        return { type: 'st-delattr', verb, args: args.slice(1), raw };
      }
      // 导出属性（.st export）
      if (subLower === 'export' || sub === '导出') {
        return { type: 'st-export', verb, args: [], raw };
      }
      // 保存计算表达式 .st &名=表达式
      if (sub === '&' || subLower === 'expr') {
        return { type: 'st-expr', verb, args: args.slice(1), raw };
      }
      // 多卡管理子命令（本项目扩展，主流骰娘用 .pc 系列）
      if (sub === 'new' || sub === '新建') {
        return { type: 'st-new', verb, args: args.slice(1), raw };
      }
      if (sub === 'switch' || sub === 'use' || sub === '切换') {
        return { type: 'st-switch', verb, args: args.slice(1), raw };
      }
      if (sub === 'list' || sub === '列表' || sub === 'ls') {
        return { type: 'st-list', verb, args: [], raw };
      }
      return { type: 'st-set', verb, args, raw };
    }

    // 角色卡名字（同时是玩家昵称）的简写：.sn <名字> ≡ .st name <名字>
    case 'sn':
      return { type: 'st-set', verb, args: ['name', ...args], raw };

    // ---------- 先攻 ----------
    case 'init':
    case '先攻': {
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'add' || sub === 'a' || sub === '加入') {
        return { type: 'init-add', verb, args: args.slice(1), raw };
      }
      if (sub === 'list' || sub === 'l' || sub === '查看' || sub === '') {
        return { type: 'init-list', verb, args: [], raw };
      }
      if (sub === 'clr' || sub === 'clear' || sub === '清空') {
        return { type: 'init-clear', verb, args: [], raw };
      }
      return { type: 'unknown', verb, args, raw };
    }

    // 先攻子命令简写（紧贴写法）：.initadd / .initlist / .initclr
    case 'initadd':
      return { type: 'init-add', verb, args, raw };
    case 'initlist':
      return { type: 'init-list', verb, args, raw };
    case 'initclr':
      return { type: 'init-clear', verb, args, raw };

    // ---------- 跑团工具 ----------
    case 'draw':
    case '抽牌':
    case '牌':
      return { type: 'draw', verb, args, raw };

    case 'drawlist':
    case '牌堆':
    case '牌堆列表':
      return { type: 'drawlist', verb, args, raw };

    case 'name':
    case '名字':
    case '随机名字':
      return { type: 'name', verb, args, raw };

    case 'who':
    case '重排':
    case '排序':
    case '顺序重排':
      return { type: 'who', verb, args, raw };

    // ---------- 统计与娱乐 ----------
    case 'stat':
    case 'stats':
    case '统计':
      return { type: 'stat', verb, args, raw };

    case 'hiy':
    case '我的统计':
    case '个人统计':
      return { type: 'hiy', verb, args, raw };

    case 'jrrp':
    case '人品':
    case '今日人品':
      return { type: 'jrrp', verb, args, raw };

    case 'gugu':
    case '咕咕':
      return { type: 'gugu', verb, args, raw };

    // ---------- 查询与帮助 ----------
    case 'help':
    case '帮助':
      // 带参数 → 查词条；无参数 → 发指令图
      return args.length > 0
        ? { type: 'help-kw', verb, args, raw }
        : { type: 'help', verb, args, raw };

    case 'rule':
    case '规则':
    case '查询':
      return { type: 'help-kw', verb, args, raw };

    // .find（主流骰娘：全文搜索词条）→ 与 .help <关键词> 等价
    case 'find':
    case '搜索':
      return { type: 'help-kw', verb, args, raw };

    // .dismiss ≡ .bot bye（移出骰子）
    case 'dismiss':
      return { type: 'bot', verb, args: ['bye'], raw };

    // ---------- 角色卡管理（主流骰娘 .pc 系列） ----------
    // .pc new/tag/list/del/save/show/nn/... 本项目把多卡能力挂在这里
    case 'pc':
    case '角色卡':
      return { type: 'pc', verb, args, raw };

    // .nn（主流骰娘：角色名/名片），本项目 ≡ .st name（卡名=昵称）
    case 'nn':
      return { type: 'st-set', verb, args: ['name', ...args], raw };

    // .ri（主流骰娘 D&D：设定自己的先攻值）
    case 'ri':
      return { type: 'ri', verb, args, raw };

    // ---------- 跑团日志 ----------
    // 兼容两种写法：`.log new` 与 `.lognew`（参考图用的是后者）
    case 'lognew':
    case '日志新建':
      return { type: 'log-new', verb, args, raw };

    case 'logon':
    case '日志继续':
      return { type: 'log-on', verb, args, raw };

    case 'logoff':
    case '日志暂停':
      return { type: 'log-off', verb, args, raw };

    case 'logend':
    case '日志结束':
      return { type: 'log-end', verb, args, raw };

    case 'loglist':
    case '日志列表':
      return { type: 'log-list', verb, args, raw };

    case 'logget':
    case '日志导出':
      return { type: 'log-get', verb, args, raw };

    case 'logdel':
    case '日志删除':
      return { type: 'log-del', verb, args, raw };

    case 'logstat':
      return { type: 'log-stat', verb, args, raw };

    case 'log':
    case '日志':
    case '记录': {
      const sub = (args[0] || '').toLowerCase();
      const rest = args.slice(1);
      switch (sub) {
        case 'new': case 'n': case '新建': case '开始':
          return { type: 'log-new', verb, args: rest, raw };
        case 'on': case '开启': case '继续':
          return { type: 'log-on', verb, args: rest, raw };
        case 'off': case '关闭': case '暂停':
          return { type: 'log-off', verb, args: rest, raw };
        case 'end': case '结束':
          return { type: 'log-end', verb, args: rest, raw };
        case 'list': case 'ls': case '列表':
          return { type: 'log-list', verb, args: rest, raw };
        case 'get': case 'dl': case '导出':
          return { type: 'log-get', verb, args: rest, raw };
        case 'del': case 'delete': case 'rm': case '删除':
          return { type: 'log-del', verb, args: rest, raw };
        case 'stat': case 'stats': case '统计':
          return { type: 'log-stat', verb, args: rest, raw };
        case '':
          return { type: 'log-status', verb, args: rest, raw };
        default:
          return { type: 'unknown', verb, args, raw };
      }
    }

    case 'ob':
    case '观众':
    case '旁观':
      return { type: 'ob', verb, args, raw };

    // ---------- 管理 ----------
    case 'set':
    case 'config':
      return { type: 'set', verb, args, raw };

    case 'bak':
    case 'backup':
      return { type: 'backup', verb, args, raw };

    default:
      return parseStickyVerb(verb, args, raw, usedPrefix);
  }
}

/**
 * 「紧贴写法」通用支持（主流骰娘 / Dice! 玩家的高频习惯）：
 * 所有「动词 + 空格 + 参数」的指令，都可以把空格省掉直接连写，例如：
 *   .r3d100  ≡ .r 3d100        .ra侦查60 ≡ .ra 侦查 60
 *   .st力量88 ≡ .st 力量 88      .setprefix ! ≡ .set prefix !
 *   .boton   ≡ .bot on          .initadd张三 15 ≡ .init add 张三 15
 *   .sn张三   ≡ .st name 张三     .draw塔罗3 ≡ .draw 塔罗 3
 *
 * 做法：把入参动词与「已知动词表」逐一比对，取「最长且严格为前缀」的那个拆分，
 * 剩余部分拼回「动词 + 空格 + 参数」重新走一遍标准解析（递归一层即止，不会死循环）。
 * 数组按长度降序排列，保证最长前缀优先（rav 先于 ra、lognew 先于 log、initadd 先于 init）。
 * 仅含动词、不含子命令关键字（new/on/off 等由各自 handler 处理）。
 */
const STICKY_VERBS = [
  // 长动词优先（含子命令简写与具体系统）
  'initlist', 'initadd', 'initclr', 'logstat', 'loglist', 'logget', 'logdel', 'lognew', 'logend', 'logon', 'logoff',
  'setcoc', 'drawlist', 'dnd5e', 'coc7', 'coc5', 'dnd5', 'roll', 'rule', 'name', 'draw', 'help', 'gugu', 'coin',
  'jrrp', 'stat', 'hiy', 'who', 'set', 'init', 'logs', 'log', 'bot', 'dnd', 'coc', 'bak', 'rah', 'rav', 'san',
  'ob', 'rc', 'rb', 'rp', 'rh', 'rv', 'ti', 'li', 'hp', 'sc', 'sn', 'en', 'ra', 'st', 'r',
  // 中文动词（同款紧贴写法，如 .属性力量88）
  '奖励骰', '惩罚骰', '暗骰', '成长检定', '临时疯狂', '长期疯狂', '总结疯狂', '理智检定', '生命值',
  '理智值', '先攻', '抽牌', '牌堆', '牌堆列表', '随机名字', '顺序重排', '今日人品', '我的统计',
  '个人统计', '日志新建', '日志继续', '日志暂停', '日志结束', '日志列表', '日志导出', '日志删除',
  '观众', '旁观', '属性', '名字', '统计', '帮助', '规则', '查询', '日志', '记录', '成长', '咕咕', '硬币', '天命',
].sort((a, b) => b.length - a.length);

function parseStickyVerb(verb: string, args: string[], raw: string, prefix: string): ParsedCommand {
  const sticky = STICKY_VERBS.find((v) => verb.startsWith(v) && verb.length > v.length);
  if (!sticky) {
    return { type: 'unknown', verb, args, raw };
  }
  const tail = verb.slice(sticky.length);
  const restAll = args.length > 0 ? `${tail} ${args.join(' ')}` : tail;
  // 合成回标准「动词 + 空格 + 参数」形式，重新走一遍解析（只递归一层，tail 不再含动词前缀）
  const reparsed = parseCommand(`${prefix}${sticky} ${restAll}`.trim(), prefix);
  return reparsed ?? { type: 'unknown', verb, args, raw };
}

/**
 * 解析多列检定语法：`3#p手枪` / `5#b2侦查` / `4#力量`
 *
 * 返回 null 表示不是多列语法（交给普通检定处理）。
 */
export interface MultiCheckSpec {
  /** 重复次数 */
  times: number;
  /** 奖励/惩罚骰：'b' 奖励，'p' 惩罚，undefined 普通 */
  bonus?: 'b' | 'p';
  /** 额外骰数量（默认 1） */
  bonusCount: number;
  /** 剩余的技能名 / 目标值部分 */
  rest: string;
}

export function parseMultiCheck(s: string): MultiCheckSpec | null {
  const m = /^(\d+)#(?:(b|p)(\d*))?(.*)$/i.exec(s);
  if (!m) return null;
  const times = parseInt(m[1], 10);
  if (!Number.isFinite(times) || times < 1) return null;
  const bonus = m[2] ? (m[2].toLowerCase() as 'b' | 'p') : undefined;
  const bonusCount = m[3] ? parseInt(m[3], 10) : 1;
  return {
    times: Math.min(times, 20), // 上限 20 次，避免刷屏
    bonus,
    bonusCount: Math.max(1, Math.min(5, bonusCount)),
    rest: m[4] || '',
  };
}
