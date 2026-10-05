/**
 * 骰点表达式引擎（零第三方依赖）
 * 支持语法：
 *   3d6            3 个 6 面骰求和
 *   3d6+2 / 2d8-1  带常量加减
 *   4d6k3          4d6 取最高的 3 个（keep highest）
 *   4d6kl1         4d6 去掉最低的 1 个（keep lowest 的反面，drop lowest）
 *   2d20kh1        优势（2d20 取高）
 *   2d20kl1        劣势（2d20 取低）
 *   d20优势        D&D 优势骰（= 2d20kh1，中文写法）
 *   d20劣势        D&D 劣势骰（= 2d20kl1）
 *   1d100 / 1d100<=50  COC 检定（带目标值，返回成功等级）
 *   d6 / D6        省略数量默认为 1
 *   d / D          省略面数 → 用 defaultSides（群默认骰面，默认 100）
 *   3d6+1d4        多组骰子混合
 *   f / 4df        Fate 命运骰（4 个 [-1,0,1]，如 [---+]=-2）
 *   5a6            WoD 无限骰：5 个 d10，≥6 加骰、≥8 成功（成功线默认 8、面数默认 10）
 *   10a6k4m9       同上，可指定成功线 k4、面数 m9（q 代替 k 则成功判定反转为 ≤N）
 *   4c3m7          双十字骰：4 个 d10，≥3 暴击续轮，结果 = 轮数×10 + 末轮最大点
 * 结果对象包含明细，便于生成可读的输出文本。
 */
import { RandomFn, defaultRandom, rollDice, rollDie } from './random';

/** 单个骰子组的求解结果 */
export interface DiceGroup {
  /** 原始表达式片段，如 "4d6k3" */
  raw: string;
  /** 骰子数量 */
  count: number;
  /** 骰面数 */
  sides: number;
  /** 全部掷出的点数 */
  rolls: number[];
  /** 被保留参与计和的点数（应用 k/kl 规则后） */
  kept: number[];
  /** 被丢弃的点数 */
  dropped: number[];
  /** 该组小计 */
  subtotal: number;
  /** 保留规则（用于展示） */
  keepRule?: string;
  /**
   * 特殊骰法（Fate / WoD / 双十字）的整段渲染文本。
   * 命中特殊骰法时，常规的「N 个骰子求和」展示不适用，直接用这段文本。
   */
  special?: string;
}

/** 常量项 */
export interface ConstantTerm {
  raw: string;
  value: number;
}

/** 完整表达式求解结果 */
export interface RollResult {
  /** 原表达式 */
  expression: string;
  /** 骰子组明细 */
  groups: DiceGroup[];
  /** 常量项 */
  constants: ConstantTerm[];
  /** 最终总值 */
  total: number;
  /** 人类可读的展示文本 */
  detail: string;
  /** COC 检定信息（若表达式为检定式） */
  check?: CheckResult;
}

/** COC 检定结果 */
export interface CheckResult {
  target: number;
  roll: number;
  level: '大成功' | '极难成功' | '困难成功' | '成功' | '失败' | '大失败';
  success: boolean;
}

/** 骰子组词法：可选的 数量、d/D、可选的面数、以及可选的 k/kh/kl/klN/dh/dl 后缀 */
const DICE_RE = /^(\d*)[dD](\d*)((?:k|kh|kl|dh|dl)\d*)?$/;

/** Fate 命运骰：`f`（= 4df）、`df`、`4df` */
const FATE_RE = /^(?:(\d+)[dD])?[fF]$/;

/** WoD 骰：`5a6` / `10a6k4m9` / `5a6q4`（q = 成功判定反转为 ≤N） */
const WOD_RE = /^(\d+)a(\d+)(?:m(\d+))?(?:k(\d+)|q(\d+))?$/;

/** 双十字骰：`4c3` / `4c3m7` */
const CROSS_RE = /^(\d+)c(\d+)(?:m(\d+))?$/;

/**
 * 预处理表达式里的中文优势/劣势：`d20优势` → `2d20kh1`、`2d劣势` → `2d(默认面)kl1`。
 * 必须带 `d` 前缀（单纯「优势」两个字不做转换，避免误伤聊天内容）。
 */
function preprocessChineseDice(s: string, defaultSides: number): string {
  return s.replace(/(\d*)[dD](\d*)(优势|劣势)/g, (_m, cnt, sides, word) => {
    const n = sides ? parseInt(sides, 10) : defaultSides;
    const c = cnt ? parseInt(cnt, 10) : 1;
    // 优势 = 骰两次取高；若用户写了数量（如 2d20优势），取 min(2, count*2) 无意义，直接 2 骰
    return `${Math.max(2, c)}d${n}${word === '优势' ? 'kh1' : 'kl1'}`;
  });
}

/**
 * 解析并求值一个骰点表达式。
 * @param expr 表达式字符串（不含前缀 .r 等命令词）
 * @param rng 随机源
 * @param defaultSides `d` 这种省略面数的写法使用的默认骰面（群配置的默认骰，默认 100）
 */
export function roll(expr: string, rng: RandomFn = defaultRandom, defaultSides = 100): RollResult {
  let cleaned = expr.trim().replace(/\s+/g, '');
  if (!cleaned) {
    throw new Error('表达式为空');
  }

  // 中文优势/劣势先转成标准写法
  cleaned = preprocessChineseDice(cleaned, defaultSides);

  // 统一小写用于解析，但保留原始展示
  const groups: DiceGroup[] = [];
  const constants: ConstantTerm[] = [];

  // 以 + 或 - 切分为若干项，同时记录符号
  const tokens = tokenize(cleaned);
  if (tokens.length === 0) {
    throw new Error('无法解析表达式');
  }

  for (const tok of tokens) {
    const term = tok.term;
    const diceMatch = DICE_RE.exec(term);
    if (diceMatch && diceMatch[2] !== '') {
      const count = diceMatch[1] === '' ? 1 : parseInt(diceMatch[1], 10);
      const sides = parseInt(diceMatch[2], 10);
      const keepSuffix = diceMatch[3];
      const group = resolveDiceGroup(term, count, sides, keepSuffix, rng);
      // 应用符号：负数骰子组（少见）直接对其小计取负
      if (tok.sign < 0) {
        group.subtotal = -group.subtotal;
      }
      groups.push(group);
    } else if (diceMatch && diceMatch[2] === '') {
      // 形如 `d` / `2d`：省略面数 → 使用群默认骰面
      const count = diceMatch[1] === '' ? 1 : parseInt(diceMatch[1], 10);
      const group = resolveDiceGroup(term, count, defaultSides, diceMatch[3], rng);
      if (tok.sign < 0) {
        group.subtotal = -group.subtotal;
      }
      groups.push(group);
    } else if (/^\d+$/.test(term)) {
      const value = parseInt(term, 10) * tok.sign;
      constants.push({ raw: (tok.sign < 0 ? '-' : '+') + term, value });
    } else {
      // 特殊骰法：Fate / WoD / 双十字（都不支持作为负数项，直接按符号取负）
      const g = resolveSpecialTerm(term, rng);
      if (g) {
        if (tok.sign < 0) {
          g.subtotal = -g.subtotal;
        }
        groups.push(g);
      } else {
        throw new Error(`无法识别的项: ${term}`);
      }
    }
  }

  const diceSum = groups.reduce((a, g) => a + g.subtotal, 0);
  const constSum = constants.reduce((a, c) => a + c.value, 0);
  const total = diceSum + constSum;

  const result: RollResult = {
    expression: cleaned,
    groups,
    constants,
    total,
    detail: buildDetail(groups, constants, total),
  };
  return result;
}

/** 词法切分：拆成带符号的项 */
function tokenize(s: string): Array<{ sign: number; term: string }> {
  const out: Array<{ sign: number; term: string }> = [];
  let i = 0;
  let sign = 1;
  // 允许开头就是 - 号
  if (s[0] === '+') i = 1;
  else if (s[0] === '-') {
    sign = -1;
    i = 1;
  }
  let buf = '';
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === '+' || ch === '-') {
      if (buf) {
        out.push({ sign, term: buf });
        buf = '';
      }
      sign = ch === '-' ? -1 : 1;
    } else {
      buf += ch;
    }
  }
  if (buf) out.push({ sign, term: buf });
  return out;
}

/** 求解单个骰子组，处理 keep/drop 规则 */
function resolveDiceGroup(
  raw: string,
  count: number,
  sides: number,
  keepSuffix: string | undefined,
  rng: RandomFn,
): DiceGroup {
  const rolls = rollDice(count, sides, rng);
  let kept = rolls.slice();
  let dropped: number[] = [];
  let keepRule: string | undefined;

  if (keepSuffix) {
    const m = /^(k|kh|kl|dh|dl)(\d*)$/.exec(keepSuffix)!;
    const kind = m[1];
    const n = m[2] === '' ? 1 : parseInt(m[2], 10);
    if (n > count) {
      throw new Error(`保留/丢弃数量 ${n} 超过骰子总数 ${count}（${raw}）`);
    }
    // 已排序索引，用于按值取高/低
    const indexed = rolls.map((v, idx) => ({ v, idx }));
    const byValueDesc = indexed.slice().sort((a, b) => b.v - a.v || a.idx - b.idx);
    const byValueAsc = indexed.slice().sort((a, b) => a.v - b.v || a.idx - b.idx);

    const keepIdx = new Set<number>();
    if (kind === 'k' || kind === 'kh') {
      // 保留最高的 n 个
      for (let i = 0; i < n; i++) keepIdx.add(byValueDesc[i].idx);
      keepRule = `取高${n}`;
    } else if (kind === 'kl') {
      // 保留最低的 n 个
      for (let i = 0; i < n; i++) keepIdx.add(byValueAsc[i].idx);
      keepRule = `取低${n}`;
    } else if (kind === 'dh') {
      // 丢弃最高的 n 个
      const dropIdx = new Set<number>();
      for (let i = 0; i < n; i++) dropIdx.add(byValueDesc[i].idx);
      for (const it of indexed) if (!dropIdx.has(it.idx)) keepIdx.add(it.idx);
      keepRule = `去高${n}`;
    } else if (kind === 'dl') {
      // 丢弃最低的 n 个
      const dropIdx = new Set<number>();
      for (let i = 0; i < n; i++) dropIdx.add(byValueAsc[i].idx);
      for (const it of indexed) if (!dropIdx.has(it.idx)) keepIdx.add(it.idx);
      keepRule = `去低${n}`;
    }

    kept = [];
    dropped = [];
    rolls.forEach((v, idx) => {
      if (keepIdx.has(idx)) kept.push(v);
      else dropped.push(v);
    });
  }

  const subtotal = kept.reduce((a, b) => a + b, 0);
  return { raw, count, sides, rolls, kept, dropped, subtotal, keepRule };
}

/** 生成人类可读的明细文本 */
function buildDetail(groups: DiceGroup[], constants: ConstantTerm[], total: number): string {
  const parts: string[] = [];
  for (const g of groups) {
    // 特殊骰法（Fate/WoD/双十字）直接用整段文本，不套「N 个骰子求和」格式
    if (g.special) {
      parts.push(`${g.raw}=${g.special}`);
      continue;
    }
    const rollStr = g.rolls.join('+');
    let seg = `${g.count}d${g.sides}[${rollStr}]`;
    if (g.keepRule) {
      seg += ` ${g.keepRule}→[${g.kept.join('+')}]`;
    }
    parts.push(seg);
  }
  for (const c of constants) {
    parts.push(c.raw);
  }
  return `${parts.join(' ')} = ${total}`;
}

// ==================== 特殊骰法：Fate / WoD / 双十字 ====================

/**
 * 特殊骰法轮次上限：防止极端参数（面数 2、暴击线极低等）导致无限续轮。
 * 命中上限时会用 `…(+N轮)` 提示还有多少轮被省略。
 */
const SPECIAL_MAX_ROUNDS = 30;
/** 展示时最多渲染前若干轮的明细，超出的用省略号收尾 */
const SPECIAL_SHOW_ROUNDS = 6;

/**
 * 把「每轮文本」压缩成适合在聊天里展示的一行。
 * 轮数少时全量展示；轮数多时只展示前 N 轮 + 省略提示，避免消息刷屏。
 */
function joinRoundTexts(rounds: string[]): string {
  if (rounds.length <= SPECIAL_SHOW_ROUNDS) return rounds.join('');
  const head = rounds.slice(0, SPECIAL_SHOW_ROUNDS).join('');
  return `${head}…(+${rounds.length - SPECIAL_SHOW_ROUNDS}轮)`;
}

/**
 * 尝试把一个「项」解析成特殊骰法并求解。
 * 命中返回带 special 文本的骰子组；不命中返回 null。
 */
function resolveSpecialTerm(term: string, rng: RandomFn): DiceGroup | null {
  let m: RegExpExecArray | null;

  // ---- Fate 命运骰：f / df / 4df（默认 4 枚）----
  m = FATE_RE.exec(term);
  if (m) {
    const n = m[1] ? parseInt(m[1], 10) : 4;
    const rolls = Array.from({ length: n }, () => rollDie(3, rng) - 2);
    const sym = (v: number) => (v < 0 ? '-' : v > 0 ? '+' : '0');
    const subtotal = rolls.reduce((a, b) => a + b, 0);
    const totalText = subtotal > 0 ? `+${subtotal}` : `${subtotal}`;
    return {
      raw: term, count: n, sides: 3, rolls, kept: rolls, dropped: [],
      subtotal, special: `[${rolls.map(sym).join('')}] = ${totalText}`,
    };
  }

  // ---- WoD 无限骰：XaY[kN][mZ] / XaYqN ----
  m = WOD_RE.exec(term);
  if (m) {
    const pool = parseInt(m[1], 10);
    const again = parseInt(m[2], 10);
    const sides = m[3] ? parseInt(m[3], 10) : 10;
    const failMode = m[5] !== undefined; // q 模式：≤N 算成功
    const line = m[4] ? parseInt(m[4], 10) : m[5] ? parseInt(m[5], 10) : 8;

    const allRolls: number[] = [];
    const roundTexts: string[] = [];
    let totalSuccess = 0;
    let extra = pool;
    let rounds = 0;
    // 上限轮数，防止极端参数（面数 2 之类）死循环
    while (extra > 0 && rounds < SPECIAL_MAX_ROUNDS) {
      rounds++;
      const rs = rollDice(Math.min(extra, 200), sides, rng);
      allRolls.push(...rs);
      let succ = 0;
      let newExtra = 0;
      const parts = rs.map((v) => {
        const hit = failMode ? v <= line : v >= line;
        const bonus = !failMode && v >= again;
        if (hit) succ++;
        if (bonus) newExtra++;
        // <v> = 触发加骰；v* = 触发成功；<v*> = 两者都触发（主流骰娘同款标记）
        return bonus ? `<${v}${hit ? '*' : ''}>` : hit ? `${v}*` : `${v}`;
      });
      roundTexts.push(`{${parts.join(',')}}`);
      totalSuccess += succ;
      extra = newExtra;
    }
    const spec = `成功${totalSuccess}/${allRolls.length} 轮数:${rounds} ${joinRoundTexts(roundTexts)}`;
    return {
      raw: term, count: pool, sides, rolls: allRolls, kept: [], dropped: [],
      subtotal: totalSuccess, special: spec,
    };
  }

  // ---- 双十字骰：XcY[mZ]（≥Y 暴击续轮，出目 = 暴击轮数×10 + 末轮最大点）----
  m = CROSS_RE.exec(term);
  if (m) {
    const pool = parseInt(m[1], 10);
    const critLine = parseInt(m[2], 10);
    const sides = m[3] ? parseInt(m[3], 10) : 10;

    const allRolls: number[] = [];
    const roundTexts: string[] = [];
    let critRounds = 0;
    let extra = pool;
    let rounds = 0;
    let lastMax = 0;
    while (extra > 0 && rounds < SPECIAL_MAX_ROUNDS) {
      rounds++;
      const rs = rollDice(Math.min(extra, 200), sides, rng);
      allRolls.push(...rs);
      const crits = rs.filter((v) => v >= critLine).length;
      lastMax = Math.max(...rs);
      if (crits > 0) critRounds++;
      roundTexts.push(`{${rs.map((v) => (v >= critLine ? `<${v}>` : `${v}`)).join(',')}}`);
      extra = crits;
    }
    // 出目：暴击发生的轮数 ×10 + 最后一轮最大点（首轮即无暴击 = 0×10 + 最大点）
    const result = critRounds * 10 + lastMax;
    const spec = `出目${result}/${allRolls.length} 轮数:${rounds} ${joinRoundTexts(roundTexts)}`;
    return {
      raw: term, count: pool, sides, rolls: allRolls, kept: [], dropped: [],
      subtotal: result, special: spec,
    };
  }

  return null;
}

/**
 * COC 检定：给定掷骰结果与目标值，返回成功等级。
 *
 * @param rule 房规号（`.setcoc` 设置，默认 0），与主流骰娘一致：
 *   0 = 默认（CoC7th 规则书）：1 大成功；目标<50 时 ≥96 大失败，目标≥50 时 100 恒大失败
 *   1 = 不满 50 出 1 大成功；不满 50 出 96-100 大失败，满 50 出 100 大失败
 *   2 =（常用）出 1-5 且判定成功为大成功；出 96-100 且判定失败为大失败
 *   3 = 出 1-5 恒大成功；出 96-100 恒大失败（无视判定结果）
 *   4 = 出 1-5 且 ≤成功率/10 为大成功；目标<50 时 ≥96+成功率/10 大失败，满 50 出 100
 *   5 = 出 1-2 且 ≤成功率/5 为大成功；目标<50 时 96-100 大失败，满 50 时 99-100
 *   dg = 骰运（单骰/惩罚骰）：出 1 或「成功且十位=个位」大成功；出 100 或「失败且十位=个位」大失败
 */
export function cocCheck(rollValue: number, target: number, rule: number | string = 0): CheckResult {
  let level: CheckResult['level'];
  let success = false;

  // 房规决定大成功 / 大失败的判定，其余走统一的成功等级阶梯
  let crit = false;
  let fumble = false;

  // dg（骰运房规）没有困难/极难成功阶梯，先算基础成败
  if (rule === 'dg') {
    const baseSuccess = rollValue <= target;
    const sameDigit = Math.floor(rollValue / 10) === rollValue % 10;
    crit = rollValue === 1 || (baseSuccess && sameDigit);
    fumble = rollValue === 100 || (!baseSuccess && sameDigit);
  } else {
    const r = Number(rule) || 0;
    // 成功率（0~100），房规 4/5 用它做动态阈值
    const successRate = Math.max(0, Math.min(100, 100 - target));
    if (r === 1) {
      crit = rollValue === 1 && target < 50;
      fumble = target < 50 ? rollValue >= 96 : rollValue === 100;
    } else if (r === 2) {
      crit = rollValue <= 5 && rollValue <= target;
      fumble = rollValue >= 96 && rollValue > target;
    } else if (r === 3) {
      crit = rollValue <= 5;
      fumble = rollValue >= 96;
    } else if (r === 4) {
      crit = rollValue <= 5 && rollValue <= Math.floor(successRate / 10);
      fumble = target < 50
        ? rollValue >= 96 + Math.floor(successRate / 10)
        : rollValue === 100;
    } else if (r === 5) {
      crit = rollValue <= 2 && rollValue <= Math.floor(successRate / 5);
      fumble = target < 50 ? rollValue >= 96 : rollValue >= 99;
    } else {
      // r === 0（规则书默认）
      crit = rollValue === 1;
      fumble = rollValue >= (target < 50 ? 96 : 100);
    }
  }

  if (crit) {
    level = '大成功';
    success = true;
  } else if (fumble) {
    level = '大失败';
  } else if (rule === 'dg') {
    // dg 没有困难/极难阶梯
    if (rollValue <= target) {
      level = '成功';
      success = true;
    } else {
      level = '失败';
    }
  } else if (rollValue <= Math.floor(target / 5)) {
    level = '极难成功';
    success = true;
  } else if (rollValue <= Math.floor(target / 2)) {
    level = '困难成功';
    success = true;
  } else if (rollValue <= target) {
    level = '成功';
    success = true;
  } else {
    level = '失败';
  }
  return { target, roll: rollValue, level, success };
}

/** 房规清单（`.setcoc details` 输出用），key 为 `.setcoc <key>` 的实参 */
export const COC_RULES: Array<{ key: string; desc: string }> = [
  { key: '0', desc: '（默认）出 1 大成功；目标<50 时出 96-100 大失败，目标≥50 时出 100 大失败（CoC7th 规则书）' },
  { key: '1', desc: '目标<50 时出 1 大成功、出 96-100 大失败；目标≥50 时出 1 大成功、出 100 大失败' },
  { key: '2', desc: '（常用）出 1-5 且判定成功为大成功；出 96-100 且判定失败为大失败' },
  { key: '3', desc: '出 1-5 恒大成功，出 96-100 恒大失败（大成功/大失败时无视判定结果）' },
  { key: '4', desc: '出 1-5 且 ≤成功率/10 为大成功；目标<50 时出 96+成功率/10 大失败，目标≥50 时出 100 大失败' },
  { key: '5', desc: '出 1-2 且 ≤成功率/5 为大成功；目标<50 时出 96-100 大失败，目标≥50 时出 99-100 大失败' },
  { key: 'dg', desc: '骰运：出 1 或（判定成功且十位=个位）大成功；出 100 或（判定失败且十位=个位）大失败，无困难/极难成功' },
];

/**
 * 解析形如 "3d6+2" 或 "1d100<=50"（含检定目标值）的表达式并求值。
 * @param defaultSides `d` 省略面数时使用的默认骰面
 * @param rule COC 房规（影响 `<=` 检定式的大成功/大失败判定）
 */
export function rollExpression(
  expr: string,
  rng: RandomFn = defaultRandom,
  defaultSides = 100,
  rule: number | string = 0,
): RollResult {
  // 检测 COC 检定型：形如 x 或 xd100<=target
  const checkMatch = /^(\d*)[dD](\d*)<=(\d+)$/.exec(expr.trim().replace(/\s+/g, ''));
  if (checkMatch) {
    const count = checkMatch[1] === '' ? 1 : parseInt(checkMatch[1], 10);
    const sides = checkMatch[2] ? parseInt(checkMatch[2], 10) : defaultSides;
    const target = parseInt(checkMatch[3], 10);
    const group = resolveDiceGroup(expr.trim(), count, sides, undefined, rng);
    const rollValue = group.subtotal;
    const check = cocCheck(rollValue, target, rule);
    const result: RollResult = {
      expression: expr.trim(),
      groups: [group],
      constants: [],
      total: rollValue,
      detail: `${count}d${sides}[${group.rolls.join('+')}] = ${rollValue} → ${check.level}`,
      check,
    };
    return result;
  }
  return roll(expr, rng, defaultSides);
}

// ==================== COC 奖励骰 / 惩罚骰 ====================

/** 奖励骰/惩罚骰的掷骰明细 */
export interface COCBonusResult {
  /** 掷出的全部十位骰（取值 0,10,20,...,90） */
  tens: number[];
  /** 个位骰（取值 0..9） */
  units: number;
  /** 每个十位骰与个位骰组合出的候选值（1..100） */
  candidates: number[];
  /** 最终取值 */
  value: number;
  /** 模式：奖励 / 惩罚 */
  mode: 'bonus' | 'penalty';
  /** 额外骰数量 */
  count: number;
}

/**
 * COC 7 版奖励骰 / 惩罚骰掷骰。
 *
 * 规则：正常掷 1 个十位骰 + 1 个个位骰；有 N 个奖励/惩罚骰时，
 * 额外多掷 N 个十位骰，把它们分别与**同一个**个位骰组合成 N+1 个候选值，
 * 奖励骰取其中**最小**的，惩罚骰取其中**最大**的。
 *
 * 注意十位与个位都为 0 时结果是 100（而不是 0），这是 COC 的约定。
 *
 * @param count 额外骰数量（1-5，超出会被夹到范围内）
 * @param mode  'bonus' 奖励骰 / 'penalty' 惩罚骰
 */
export function rollCOCBonus(
  count = 1,
  mode: 'bonus' | 'penalty' = 'bonus',
  rng: RandomFn = defaultRandom,
): COCBonusResult {
  const n = Math.max(1, Math.min(5, count));
  // 十位骰：1..10 → (x-1)*10 → 0,10,...,90
  const tens = rollDice(n + 1, 10, rng).map((v) => (v - 1) * 10);
  // 个位骰：1..10 → 0..9
  const units = rollDie(10, rng) - 1;
  const candidates = tens.map((t) => {
    const v = t + units;
    return v === 0 ? 100 : v;
  });
  const value = mode === 'bonus' ? Math.min(...candidates) : Math.max(...candidates);
  return { tens, units, candidates, value, mode, count: n };
}

/** 把奖励骰结果渲染成可读的明细文本 */
export function formatCOCBonus(r: COCBonusResult): string {
  const modeText = r.mode === 'bonus' ? '奖励骰' : '惩罚骰';
  const tensText = r.tens.join('/');
  const candText = r.candidates.join(' ');
  const picked = r.mode === 'bonus' ? '取最小' : '取最大';
  return `${modeText}×${r.count}: 十位[${tensText}] 个位[${r.units}] → 候选(${candText}) ${picked} → ${r.value}`;
}
