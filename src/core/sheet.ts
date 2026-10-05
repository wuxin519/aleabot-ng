/**
 * 角色卡生成器：COC 7 版 与 D&D 5e。
 * 使用确定性随机源便于测试。
 */
import { RandomFn, defaultRandom, rollDie, rollDice } from './random';

/** 角色卡结构（通用） */
export interface CharacterSheet {
  /** 规则系统 */
  system: 'coc7' | 'coc5' | 'dnd5e';
  /** 玩家昵称（bot 称呼玩家用，跨角色卡唯一） */
  name?: string;
  /** 角色卡标题（多卡切换用，如「调查员A」）；缺省「默认」 */
  title?: string;
  /** 属性键值对 */
  attributes: Record<string, number>;
  /** 衍生值（如 HP/MP/DB） */
  derived: Record<string, string>;
  /** 保存的计算表达式（.st &名=表达式），可用 .r 名 调用 */
  expressions?: Record<string, string>;
  /** 生成时间戳 */
  createdAt: number;
}

/**
 * 各系统的「标准属性顺序」，用于 `.st` 的「按位置无键名录入」。
 * 顺序与 `.st show` 显示的属性顺序保持一致，方便照着抄。
 */
export const COC7_ORDER = ['力量', '体质', '敏捷', '外貌', '意志', '体型', '智力', '教育', '幸运'];
export const COC5_ORDER = ['力量', '体质', '体型', '敏捷', '外貌', '智力', '意志', '教育', '幸运'];
export const DND5E_ORDER = ['力量', '敏捷', '体质', '智力', '感知', '魅力'];

/** 按系统返回属性顺序数组（未知系统回退 COC7） */
export function attributeOrder(system: string): string[] {
  if (system === 'coc5') return COC5_ORDER;
  if (system === 'dnd5e') return DND5E_ORDER;
  return COC7_ORDER;
}

/** 各系统主属性的生成方式（决定用什么骰子算） */
type AttrGen = 'coc7' | 'coc5' | 'dnd5e';

/**
 * 只掷「主属性」的一组数值（主流骰娘 `.coc` / `.coc5` / `.dnd` 的制卡模式）。
 * 不含任何技能、衍生值，也不写入角色卡 —— 纯粹给玩家挑一组用。
 */
export function rollMainAttributes(
  system: 'coc7' | 'coc5' | 'dnd5e',
  rng: RandomFn = defaultRandom,
): Record<string, number> {
  const attrs: Record<string, number> = {};
  if (system === 'dnd5e') {
    for (const a of DND_ATTRS) attrs[a] = dndStat(rng);
    return attrs;
  }
  if (system === 'coc5') {
    attrs['力量'] = sumDice(3, 6, rng);
    attrs['体质'] = sumDice(3, 6, rng);
    attrs['体型'] = sumDice(2, 6, rng) + 6;
    attrs['敏捷'] = sumDice(3, 6, rng);
    attrs['外貌'] = sumDice(3, 6, rng);
    attrs['智力'] = sumDice(2, 6, rng) + 6;
    attrs['意志'] = sumDice(3, 6, rng);
    attrs['教育'] = sumDice(3, 6, rng) + 3;
    attrs['幸运'] = sumDice(3, 6, rng);
    return attrs;
  }
  // COC 7 版：8 项主属性 + 幸运
  for (const a of COC7_ORDER) attrs[a] = cocAttr(rng);
  return attrs;
}

/**
 * 主属性组的附加信息：HP 与两个总值（主流骰娘 `.coc` 输出的 `[8项/8项+幸运]`）。
 * COC7/5：HP = (体质+体型)/10（COC5 不做除 10），总值不含幸运与含幸运各一份。
 * D&D：无 HP 概念，只给总和。
 */
export function mainAttributesMeta(
  system: 'coc7' | 'coc5' | 'dnd5e',
  attrs: Record<string, number>,
): { hp?: number; sum8?: number; sumAll?: number } {
  if (system === 'dnd5e') {
    const sumAll = DND_ATTRS.reduce((s, k) => s + (attrs[k] || 0), 0);
    return { sumAll };
  }
  if (system === 'coc5') {
    const hp = Math.floor((attrs['体质'] + attrs['体型']) / 2);
    const sum8 = COC5_ORDER.filter((k) => k !== '幸运').reduce((s, k) => s + attrs[k], 0);
    return { hp, sum8, sumAll: sum8 + attrs['幸运'] };
  }
  const hp = Math.floor((attrs['体质'] + attrs['体型']) / 10);
  const sum8 = COC7_ORDER.filter((k) => k !== '幸运').reduce((s, k) => s + attrs[k], 0);
  return { hp, sum8, sumAll: sum8 + attrs['幸运'] };
}

/** COC 7 版 技能列表（常用） */
const COC_SKILLS = [
  '会计', '人类学', '估价', '考古学', '取悦', '攀爬', '计算机使用', '信用评级',
  '克苏鲁神话', '乔装', '闪避', '汽车驾驶', '电气维修', '电子学', '话术', '格斗',
  '射击', '急救', '历史', '恐吓', '跳跃', '母语', '外语', '法律', '图书馆使用',
  '聆听', '锁匠', '机械维修', '医学', '博物学', '导航', '神秘学', '操作重型机械',
  '说服', '精神分析', '心理学', '骑术', '科学', '妙手', '侦查', '潜行', '生存',
  '游泳', '投掷', '追踪', '潜水', '爆破', '读唇', '催眠',
];

/** COC 7 版判定：属性 = (3d6)*5，幸运 = (3d6)*5 */
function cocAttr(rng: RandomFn): number {
  const dice = rollDice(3, 6, rng);
  return dice.reduce((a, b) => a + b, 0) * 5;
}

/** COC 7 版力量/体质/敏捷/外貌/意志/教育 为 3d6*5，体型/智力/教育等 */
function cocSizIntEdu(rng: RandomFn): number {
  const dice = rollDice(3, 6, rng);
  return dice.reduce((a, b) => a + b, 0) * 5;
}

/**
 * 生成 COC 7 版角色卡。
 */
export function generateCOC(name: string | undefined, rng: RandomFn = defaultRandom, title = '默认'): CharacterSheet {
  const str = cocAttr(rng);      // 力量 STR
  const con = cocAttr(rng);      // 体质 CON
  const dex = cocAttr(rng);      // 敏捷 DEX
  const app = cocAttr(rng);      // 外貌 APP
  const pow = cocAttr(rng);      // 意志 POW
  const siz = cocSizIntEdu(rng); // 体型 SIZ
  const int = cocSizIntEdu(rng); // 智力 INT
  const edu = cocSizIntEdu(rng); // 教育 EDU
  const luck = cocAttr(rng);     // 幸运 LUCK

  // 衍生值
  const hp = Math.floor((con + siz) / 10);
  const mp = Math.floor(pow / 5);
  const san = pow;
  // 伤害加值 DB 与体格 Build
  const strSiz = str + siz;
  let db: string;
  let build: number;
  if (strSiz <= 64) { db = '-2'; build = -2; }
  else if (strSiz <= 84) { db = '-1'; build = -1; }
  else if (strSiz <= 124) { db = '0'; build = 0; }
  else if (strSiz <= 164) { db = '+1d4'; build = 1; }
  else { db = '+1d6'; build = 2; }
  const mov = (dex < siz && str < siz) ? 7 : (dex > siz && str > siz ? 9 : 8);

  // 技能：以属性为基础 + 少量加点
  const skills: Record<string, number> = {};
  for (const sk of COC_SKILLS) {
    skills[sk] = 1; // 基础值简化
  }
  skills['闪避'] = Math.floor(dex / 2);
  skills['母语'] = edu;
  // 随机三个职业技能加点（不放回抽取：Fisher-Yates 打乱下标后取前 3 个，
  // 这样即使随机源退化成固定值也不会死循环）
  const idxPool = COC_SKILLS.map((_, i) => i);
  for (let k = idxPool.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    [idxPool[k], idxPool[j]] = [idxPool[j], idxPool[k]];
  }
  const picks = idxPool.slice(0, 3);
  for (const i of picks) {
    skills[COC_SKILLS[i]] = Math.min(90, skills[COC_SKILLS[i]] + rollDie(60, rng));
  }

  const attributes: Record<string, number> = {
    力量: str, 体质: con, 敏捷: dex, 外貌: app, 意志: pow,
    体型: siz, 智力: int, 教育: edu, 幸运: luck,
  };
  for (const [k, v] of Object.entries(skills)) {
    attributes[`技能_${k}`] = v;
  }

  const derived: Record<string, string> = {
    生命值: `${hp}`,
    魔法值: `${mp}`,
    理智: `${san}`,
    伤害加值: db,
    体格: `${build}`,
    移动力: `${mov}`,
  };

  return {
    system: 'coc7',
    name,
    title,
    attributes,
    derived,
    createdAt: Date.now(),
  };
}

/** 掷 n 个 d 面骰求和 */
function sumDice(n: number, d: number, rng: RandomFn): number {
  return rollDice(n, d, rng).reduce((a, b) => a + b, 0);
}

/**
 * COC 5 版伤害加值表（与 7 版完全不同，按「力量+体型」查表）。
 */
function coc5DamageBonus(strSiz: number): string {
  if (strSiz <= 12) return '-1d6';
  if (strSiz <= 16) return '-1d4';
  if (strSiz <= 24) return '0';
  if (strSiz <= 32) return '+1d4';
  if (strSiz <= 40) return '+1d6';
  if (strSiz <= 56) return '+2d6';
  if (strSiz <= 72) return '+3d6';
  return '+4d6';
}

/**
 * 生成 COC 5 版角色卡（参考图里的「天命 .coc5」）。
 *
 * 与 7 版的关键差别：属性直接是 3d6 点数（不乘 5），
 * 体型/智力为 2d6+6，教育为 3d6+3，
 * 换算成百分制要用「×5」的衍生值（灵感/幸运/知识）。
 */
export function generateCOC5(name: string | undefined, rng: RandomFn = defaultRandom, title = '默认'): CharacterSheet {
  const str = sumDice(3, 6, rng);          // 力量
  const con = sumDice(3, 6, rng);          // 体质
  const siz = sumDice(2, 6, rng) + 6;      // 体型
  const dex = sumDice(3, 6, rng);          // 敏捷
  const app = sumDice(3, 6, rng);          // 外貌
  const int = sumDice(2, 6, rng) + 6;      // 智力
  const pow = sumDice(3, 6, rng);          // 意志
  const edu = sumDice(3, 6, rng) + 3;      // 教育
  const luck = sumDice(3, 6, rng);         // 幸运

  // 衍生值（5 版按整数运算，非百分制）
  const hp = Math.floor((con + siz) / 2);
  const mp = pow;
  const san = pow * 5;
  const idea = int * 5;    // 灵感
  const luckPct = luck * 5; // 幸运（百分制）
  const know = edu * 5;     // 知识
  const db = coc5DamageBonus(str + siz);

  // 技能基础值（5 版与 7 版略有出入，这里沿用同一套基础值表，够用且改动最小）
  const attributes: Record<string, number> = {
    力量: str, 体质: con, 体型: siz, 敏捷: dex, 外貌: app,
    智力: int, 意志: pow, 教育: edu, 幸运: luck,
  };

  const derived: Record<string, string> = {
    生命值: `${hp}`,
    魔法值: `${mp}`,
    理智: `${san}`,
    灵感: `${idea}`,
    幸运值: `${luckPct}`,
    知识: `${know}`,
    伤害加值: db,
  };

  return { system: 'coc5', name, title, attributes, derived, createdAt: Date.now() };
}

/** D&D 5e 属性名 */const DND_ATTRS = ['力量', '敏捷', '体质', '智力', '感知', '魅力'] as const;

/** D&D 5e 种族 */
const DND_RACES = ['人类', '精灵', '矮人', '半身人', '龙裔', '侏儒', '半精灵', '半兽人', '提夫林'];

/** D&D 5e 职业 */
const DND_CLASSES = ['战士', '法师', '游荡者', '牧师', '游侠', '野蛮人', '吟游诗人', '德鲁伊', '武僧', '圣武士', '术士', '邪术师'];

/** 4d6 去最低（D&D 标准生成法） */
function dndStat(rng: RandomFn): number {
  const dice = rollDice(4, 6, rng).sort((a, b) => b - a);
  return dice[0] + dice[1] + dice[2];
}

/** 属性值转调整值 */
function dndMod(v: number): number {
  return Math.floor((v - 10) / 2);
}

/**
 * 生成 D&D 5e 角色卡。
 */
export function generateDND(name: string | undefined, rng: RandomFn = defaultRandom, title = '默认'): CharacterSheet {
  const attrs: Record<string, number> = {};
  for (const a of DND_ATTRS) {
    attrs[a] = dndStat(rng);
  }
  const race = DND_RACES[Math.floor(rng() * DND_RACES.length)];
  const cls = DND_CLASSES[Math.floor(rng() * DND_CLASSES.length)];
  const level = 1;
  const conMod = dndMod(attrs['体质']);
  // 简易 HP：取职业骰均值 + 体质调整（战士 d10，其余按类）
  const hitDie = ['野蛮人'].includes(cls) ? 12
    : ['战士', '圣武士', '游侠'].includes(cls) ? 10
    : ['法师', '术士', '邪术师'].includes(cls) ? 6
    : 8;
  const hp = hitDie + conMod;
  const profBonus = 2;

  const attributes: Record<string, number> = { ...attrs };
  for (const a of DND_ATTRS) {
    attributes[`${a}调整`] = dndMod(attrs[a]);
  }

  const derived: Record<string, string> = {
    种族: race,
    职业: cls,
    等级: `${level}`,
    生命值: `${hp}`,
    护甲等级: `${10 + dndMod(attrs['敏捷'])}`,
    熟练加值: `+${profBonus}`,
    先攻: `${dndMod(attrs['敏捷']) >= 0 ? '+' : ''}${dndMod(attrs['敏捷'])}`,
  };

  return {
    system: 'dnd5e',
    name,
    title,
    attributes,
    derived,
    createdAt: Date.now(),
  };
}

/** 把角色卡渲染为可读文本 */
export function renderSheet(sheet: CharacterSheet): string {
  const lines: string[] = [];
  // 标题行：角色卡标题（多卡切换用）+ 玩家昵称
  const titleLine = sheet.title && sheet.title !== '默认' ? `「${sheet.title}」` : '';
  const nameLine = sheet.name ? ` ${sheet.name}` : '';

  if (sheet.system === 'coc5') {
    lines.push(`【COC 5版 角色卡】${titleLine}${nameLine}`);
    lines.push(`力量:${sheet.attributes['力量']} 体质:${sheet.attributes['体质']} 体型:${sheet.attributes['体型']} 敏捷:${sheet.attributes['敏捷']}`);
    lines.push(`外貌:${sheet.attributes['外貌']} 智力:${sheet.attributes['智力']} 意志:${sheet.attributes['意志']} 教育:${sheet.attributes['教育']} 幸运:${sheet.attributes['幸运']}`);
    const der = Object.entries(sheet.derived).map(([k, v]) => `${k}:${v}`).join('  ');
    lines.push(der);
    return lines.join('\n');
  }

  if (sheet.system === 'coc7') {
    lines.push(`【COC 7版 角色卡】${titleLine}${nameLine}`);
    const core = ['力量', '体质', '敏捷', '外貌', '意志', '体型', '智力', '教育', '幸运'];
    lines.push(core.map((k) => `${k}:${sheet.attributes[k]}`).join('  '));
    const der = Object.entries(sheet.derived).map(([k, v]) => `${k}:${v}`).join('  ');
    lines.push(der);
    // 列出加点过的技能（值>1）
    const skills = Object.entries(sheet.attributes)
      .filter(([k, v]) => k.startsWith('技能_') && v > 1)
      .map(([k, v]) => `${k.slice(3)}:${v}`);
    if (skills.length) lines.push('技能: ' + skills.join('  '));
    return lines.join('\n');
  }

  lines.push(`【D&D 5e 角色卡】${titleLine}${nameLine}`);
  const core = DND_ATTRS.map((k) => `${k}:${sheet.attributes[k]}`).join('  ');
  lines.push(core);
  const der = Object.entries(sheet.derived).map(([k, v]) => `${k}:${v}`).join('  ');
  lines.push(der);
  return lines.join('\n');
}
