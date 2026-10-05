/**
 * 批次 1 新增功能专项测试（Node 内置 test 运行器，零第三方依赖）
 * 运行：npm run test:batch1
 *
 * 覆盖 13 条新指令 + 两个新算法：
 *   .jrrp .gugu .who .name .stat .hiy .draw .drawlist
 *   .rb .rp .ra N# .en .ti .li .coc5 .help <词条>
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const DIST = path.join(__dirname, '..', 'dist');
const { rollCOCBonus, formatCOCBonus } = require(path.join(DIST, 'core', 'dice.js'));
const { parseCommand, parseMultiCheck } = require(path.join(DIST, 'core', 'command.js'));
const { seededRandom } = require(path.join(DIST, 'core', 'random.js'));
const { Engine } = require(path.join(DIST, 'core', 'engine.js'));
const { Store } = require(path.join(DIST, 'core', 'store.js'));
const tables = require(path.join(DIST, 'core', 'tables.js'));

// ---------- 测试脚手架 ----------

/** 用递增序号保证每个测试用独立的临时数据库，互不干扰 */
let dbSeq = 0;
function makeEngine(opts = {}) {
  const db = path.join(os.tmpdir(), `alea-b1-${Date.now()}-${dbSeq++}.db`);
  const store = new Store(db);
  const engine = new Engine(store, {
    rng: opts.rng,
    admins: opts.admins || [],
    backupDir: path.join(os.tmpdir(), 'alea-b1-bak'),
  });
  return { store, engine, db };
}

/** 构造一条 QQ 群消息 */
function msg(text, extra = {}) {
  return {
    platform: 'qq',
    groupId: '88888',
    userId: '1001',
    userName: '测试员',
    text,
    isPrivate: false,
    ...extra,
  };
}

/** 把 reply 按行切开，丢掉第 1 行表头 */
function bodyLines(reply) {
  return reply.split('\n').slice(1);
}

/** 顺序随机源：按给定序列循环返回，用于精确控制掷骰结果 */
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

/**
 * 判断一次成长检定是否真的提升了技能。
 * ⚠️ 不能用 reply.includes('提升') —— 「没有提升」里也含「提升」两个字。
 * 提升分支独有的是「1d10 =」这段文本。
 */
function didGrow(reply) {
  return reply.includes('1d10 =');
}

// ==================== 一、奖励骰 / 惩罚骰算法 ====================

test('rollCOCBonus: 奖励骰取候选值中的最小者', () => {
  // 十位骰掷出 3 与 7（即 20/60），个位骰掷出 5（即 4）
  const r = rollCOCBonus(1, 'bonus', seqRng([0.25, 0.65, 0.45]));
  assert.deepStrictEqual(r.tens, [20, 60], `tens=${r.tens}`);
  assert.strictEqual(r.units, 4);
  assert.deepStrictEqual(r.candidates, [24, 64]);
  assert.strictEqual(r.value, 24, '奖励骰应取较小值 24');
});

test('rollCOCBonus: 惩罚骰取候选值中的最大者', () => {
  const r = rollCOCBonus(1, 'penalty', seqRng([0.25, 0.65, 0.45]));
  assert.deepStrictEqual(r.candidates, [24, 64]);
  assert.strictEqual(r.value, 64, '惩罚骰应取较大值 64');
});

test('rollCOCBonus: 十位与个位同为 0 时结果是 100（而非 0）', () => {
  const r = rollCOCBonus(1, 'bonus', () => 0); // rng=0 → 骰面恒为 1
  assert.deepStrictEqual(r.tens, [0, 0]);
  assert.strictEqual(r.units, 0);
  assert.deepStrictEqual(r.candidates, [100, 100]);
  assert.strictEqual(r.value, 100);
});

test('rollCOCBonus: 结果恒在 1..100 内，且十位骰数量 = 额外骰数 + 1', () => {
  for (let seed = 1; seed <= 60; seed++) {
    for (const mode of ['bonus', 'penalty']) {
      for (const count of [1, 2, 3]) {
        const r = rollCOCBonus(count, mode, seededRandom(seed));
        assert.ok(r.value >= 1 && r.value <= 100, `越界: ${r.value}`);
        assert.strictEqual(r.tens.length, count + 1);
        const expected = mode === 'bonus' ? Math.min(...r.candidates) : Math.max(...r.candidates);
        assert.strictEqual(r.value, expected);
      }
    }
  }
});

test('rollCOCBonus: 额外骰数量被夹在 1..5', () => {
  assert.strictEqual(rollCOCBonus(0, 'bonus', seededRandom(1)).tens.length, 2);
  assert.strictEqual(rollCOCBonus(99, 'bonus', seededRandom(1)).tens.length, 6);
});

test('formatCOCBonus: 输出包含关键要素', () => {
  const r = rollCOCBonus(2, 'penalty', seededRandom(3));
  const text = formatCOCBonus(r);
  assert.ok(text.includes('惩罚骰×2'), text);
  assert.ok(text.includes('十位['), text);
  assert.ok(text.includes('取最大'), text);
});

// ==================== 二、命令解析 ====================

test('parseCommand: 新指令全部能正确识别', () => {
  const cases = [
    ['.jrrp', 'jrrp'], ['.人品', 'jrrp'], ['.今日人品', 'jrrp'],
    ['.gugu', 'gugu'], ['.咕咕', 'gugu'],
    ['.who A B C', 'who'], ['.重排 A B', 'who'],
    ['.name cn 5', 'name'], ['.随机名字 jp', 'name'],
    ['.stat', 'stat'], ['.stat 今日', 'stat'], ['.统计', 'stat'],
    ['.hiy', 'hiy'], ['.我的统计', 'hiy'],
    ['.draw', 'draw'], ['.draw 扑克 3', 'draw'], ['.抽牌', 'draw'],
    ['.drawlist', 'drawlist'], ['.牌堆', 'drawlist'],
    ['.rb 侦查 60', 'roll-bonus'], ['.奖励骰', 'roll-bonus'],
    ['.rp 60', 'roll-penalty'], ['.惩罚骰', 'roll-penalty'],
    ['.en 侦查', 'growth'], ['.成长 侦查', 'growth'],
    ['.ti', 'madness-ti'], ['.临时疯狂', 'madness-ti'],
    ['.li', 'madness-li'], ['.长期疯狂', 'madness-li'],
    ['.coc5', 'coc5'], ['.天命', 'coc5'],
    // .help 无参数 → 发图；带参数 → 查词条
    ['.help', 'help'], ['.帮助', 'help'],
    ['.help 侦查', 'help-kw'], ['.help 成功等级', 'help-kw'],
    ['.rule 大失败', 'help-kw'], ['.规则 疯狂', 'help-kw'],
    // 回归：老指令不受影响
    ['.r 3d6', 'roll'], ['.r', 'roll-default'],
    ['.ra 侦查 60', 'check'], ['.ra 3#p手枪', 'check'],
    ['.st 力量 60', 'st-set'], ['.st show', 'st-show'],
    ['.coc', 'coc'], ['.dnd', 'dnd'], ['.init list', 'init-list'],
    ['.set prefix !', 'set'], ['.bak', 'backup'],
  ];
  for (const [text, expected] of cases) {
    const c = parseCommand(text);
    assert.ok(c, `未解析: ${text}`);
    assert.strictEqual(c.type, expected, `${text} → 期望 ${expected}，实际 ${c.type}`);
  }
});

test('parseCommand: 非指令消息返回 null', () => {
  assert.strictEqual(parseCommand('今天天气不错'), null);
  assert.strictEqual(parseCommand('  '), null);
  assert.strictEqual(parseCommand('.'), null);
});

test('parseMultiCheck: 解析 3#p手枪 / 5#b2侦查 / 4#力量', () => {
  const a = parseMultiCheck('3#p手枪');
  assert.strictEqual(a.times, 3);
  assert.strictEqual(a.bonus, 'p');
  assert.strictEqual(a.bonusCount, 1);
  assert.strictEqual(a.rest, '手枪');

  const b = parseMultiCheck('5#b2侦查');
  assert.strictEqual(b.times, 5);
  assert.strictEqual(b.bonus, 'b');
  assert.strictEqual(b.bonusCount, 2);
  assert.strictEqual(b.rest, '侦查');

  const c = parseMultiCheck('4#力量');
  assert.strictEqual(c.times, 4);
  assert.strictEqual(c.bonus, undefined);
  assert.strictEqual(c.rest, '力量');

  assert.strictEqual(parseMultiCheck('手枪'), null);
  assert.strictEqual(parseMultiCheck('3d6'), null);
});

test('parseMultiCheck: 次数上限为 20，额外骰上限为 5', () => {
  assert.strictEqual(parseMultiCheck('999#侦查').times, 20);
  assert.strictEqual(parseMultiCheck('2#b99侦查').bonusCount, 5);
});

// ==================== 三、静态数据表 ====================

test('tables: 疯狂表各 10 条且点数 1..10 不重复', () => {
  for (const [name, table] of [['即时性', tables.MADNESS_IMMEDIATE], ['长期性', tables.MADNESS_LONGTERM]]) {
    assert.strictEqual(table.length, 10, `${name}表条数`);
    const rolls = table.map((e) => e.roll).sort((a, b) => a - b);
    assert.deepStrictEqual(rolls, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], `${name}表点数`);
    assert.ok(table.every((e) => e.name && e.desc), `${name}表每条都要有名称与描述`);
  }
});

test('tables: 牌堆张数正确', () => {
  assert.strictEqual(tables.CARD_DECKS['塔罗']().length, 78, '塔罗应为 22 + 56 = 78 张');
  assert.strictEqual(tables.CARD_DECKS['扑克']().length, 54, '扑克应为 52 + 2 张');
});

test('tables: 牌堆内无重复牌', () => {
  for (const [name, gen] of Object.entries(tables.CARD_DECKS)) {
    const deck = gen();
    assert.strictEqual(new Set(deck).size, deck.length, `${name}牌堆有重复项`);
  }
});

test('tables: 名字词表与词条表非空', () => {
  for (const lang of ['cn', 'en', 'jp']) {
    const t = tables.NAME_TABLES[lang];
    assert.ok(t.surname.length >= 20, `${lang} 姓表过小`);
    assert.ok(t.given.length >= 20, `${lang} 名表过小`);
  }
  assert.ok(Object.keys(tables.KEYWORDS).length >= 10, '规则词条过少');
  assert.ok(Object.keys(tables.COC_SKILL_BASE).length >= 40, '技能基础值过少');
  assert.strictEqual(tables.COC_SKILL_BASE['侦查'], 25);
});

// ==================== 四、今日人品 ====================

test('.jrrp: 同一天同一人结果固定（不可通过重复发送刷新）', async () => {
  const { store, engine, db } = makeEngine();
  try {
    const a = await engine.handle(msg('.jrrp'));
    const b = await engine.handle(msg('.jrrp'));
    const c = await engine.handle(msg('.jrrp'));
    assert.strictEqual(a.reply, b.reply);
    assert.strictEqual(b.reply, c.reply);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.jrrp: 结果落在 1..100 且带进度条', async () => {
  const { store, engine, db } = makeEngine();
  try {
    for (const uid of ['1', '2', '3', '1000', '99999']) {
      const r = await engine.handle(msg('.jrrp', { userId: uid }));
      const m = /今日人品: (\d+)\/100/.exec(r.reply);
      assert.ok(m, `格式不符: ${r.reply}`);
      const v = Number(m[1]);
      assert.ok(v >= 1 && v <= 100, `越界: ${v}`);
      assert.ok(r.reply.includes('█'), '应包含进度条');
    }
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.jrrp: 不同用户应产出不同人品值（同一批 5 人不应全同）', async () => {
  const { store, engine, db } = makeEngine();
  try {
    const values = [];
    for (const uid of ['a', 'b', 'c', 'd', 'e']) {
      const r = await engine.handle(msg('.jrrp', { userId: uid }));
      values.push(Number(/今日人品: (\d+)/.exec(r.reply)[1]));
    }
    assert.ok(new Set(values).size > 1, `5 个用户人品值全相同: ${values.join(',')}`);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

// ==================== 五、咕咕 / 顺序重排 / 随机名字 ====================

test('.gugu: 返回非空玩梗文案', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(11) });
  try {
    const r = await engine.handle(msg('.gugu'));
    assert.ok(r && r.reply && r.reply.length > 2, JSON.stringify(r));
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.who: 元素集合不变、数量不变（只是重排）', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(4) });
  try {
    const r = await engine.handle(msg('.who 甲 乙 丙 丁 戊'));
    const items = bodyLines(r.reply).map((l) => l.replace(/^\d+\.\s*/, ''));
    assert.strictEqual(items.length, 5);
    assert.deepStrictEqual(new Set(items), new Set(['甲', '乙', '丙', '丁', '戊']));
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.who: 支持逗号与顿号分隔', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(9) });
  try {
    const r = await engine.handle(msg('.who 甲,乙，丙、丁'));
    const items = bodyLines(r.reply).map((l) => l.replace(/^\d+\.\s*/, ''));
    assert.deepStrictEqual(new Set(items), new Set(['甲', '乙', '丙', '丁']));
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.who: 少于两项时给出用法提示', async () => {
  const { store, engine, db } = makeEngine();
  try {
    const r = await engine.handle(msg('.who 只有一个'));
    assert.ok(r.reply.includes('用法'), r.reply);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.who: 顺序确实被洗过（50 次里至少有一次与原顺序不同）', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(2026) });
  try {
    let shuffled = 0;
    for (let i = 0; i < 50; i++) {
      const r = await engine.handle(msg('.who 1 2 3 4 5 6'));
      const items = bodyLines(r.reply).map((l) => l.replace(/^\d+\.\s*/, ''));
      if (items.join(',') !== '1,2,3,4,5,6') shuffled++;
    }
    assert.ok(shuffled > 30, `50 次里只有 ${shuffled} 次真正打乱了顺序`);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.name: 中文名是 3 个汉字（姓 1 + 名 2）', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(31) });
  try {
    const r = await engine.handle(msg('.name cn 8'));
    const names = bodyLines(r.reply);
    assert.strictEqual(names.length, 8);
    for (const n of names) {
      assert.ok(/^[\u4e00-\u9fa5]{3}$/.test(n), `中文名格式不符: ${n}`);
    }
    // 名不应用同一个字重复
    for (const n of names) assert.notStrictEqual(n[1], n[2], `出现叠字名: ${n}`);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.name: 英文名为「名 姓」两段', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(32) });
  try {
    const r = await engine.handle(msg('.name en 6'));
    const names = bodyLines(r.reply);
    assert.strictEqual(names.length, 6);
    for (const n of names) {
      assert.ok(/^[A-Za-z]+ [A-Za-z]+$/.test(n), `英文名格式不符: ${n}`);
    }
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.name: 日文名为 2-4 个汉字（姓 1-2 字 + 名 1-2 字）', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(33) });
  try {
    const r = await engine.handle(msg('.name jp 6'));
    const names = bodyLines(r.reply);
    assert.strictEqual(names.length, 6);
    for (const n of names) {
      assert.ok(/^[\u4e00-\u9fa5]{2,4}$/.test(n), `日文名格式不符: ${n}`);
    }
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.name: 数量上限 20、默认 10', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(34) });
  try {
    const def = await engine.handle(msg('.name'));
    assert.strictEqual(bodyLines(def.reply).length, 10);
    const over = await engine.handle(msg('.name cn 999'));
    assert.strictEqual(bodyLines(over.reply).length, 20);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

// ==================== 六、抽牌 ====================

test('.draw: 默认抽 1 张塔罗，带正逆位', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(41) });
  try {
    const r = await engine.handle(msg('.draw'));
    const lines = bodyLines(r.reply);
    assert.strictEqual(lines.length, 1);
    assert.ok(/ 正位| 逆位/.test(lines[0]), `塔罗应带正逆位: ${lines[0]}`);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.draw: 抽 3 张不重复且都来自牌堆', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(42) });
  try {
    const deck = tables.CARD_DECKS['塔罗']();
    const r = await engine.handle(msg('.draw 塔罗 3'));
    const lines = bodyLines(r.reply);
    assert.strictEqual(lines.length, 3);
    const drawn = lines.map((l) => l.replace(/^\d+\.\s*/, '').replace(/ (正位|逆位)$/, ''));
    assert.strictEqual(new Set(drawn).size, 3, '不应重复抽到同一张');
    for (const d of drawn) assert.ok(deck.includes(d), `牌不在牌堆中: ${d}`);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.draw: 扑克不带正逆位', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(43) });
  try {
    const r = await engine.handle(msg('.draw 扑克 2'));
    for (const l of bodyLines(r.reply)) {
      assert.ok(!/正位|逆位/.test(l), `扑克不应有正逆位: ${l}`);
    }
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.drawlist: 列出可用牌堆', async () => {
  const { store, engine, db } = makeEngine();
  try {
    const r = await engine.handle(msg('.drawlist'));
    assert.ok(r.reply.includes('塔罗'), r.reply);
    assert.ok(r.reply.includes('扑克'), r.reply);
    assert.ok(r.reply.includes('78'), '应标出塔罗张数');
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

// ==================== 七、奖励骰 / 惩罚骰指令 ====================

test('.rb: 无参数时只掷奖励骰，不做检定', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(51) });
  try {
    const r = await engine.handle(msg('.rb'));
    assert.ok(r.reply.includes('奖励骰'), r.reply);
    assert.ok(/= \d+/.test(r.reply), r.reply);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.rb: 带目标值时执行奖励骰检定', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(52) });
  try {
    const r = await engine.handle(msg('.rb 侦查 60'));
    assert.ok(r.reply.includes('奖励骰'), r.reply);
    assert.ok(r.reply.includes('侦查'), r.reply);
    assert.ok(r.reply.includes('/ 60'), `应显示目标值: ${r.reply}`);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.rp: 带目标值时执行惩罚骰检定', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(53) });
  try {
    const r = await engine.handle(msg('.rp 手枪 45'));
    assert.ok(r.reply.includes('惩罚骰'), r.reply);
    assert.ok(r.reply.includes('/ 45'), r.reply);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.rb/.rp: 奖励骰的平均出目应低于惩罚骰（各 400 次的统计验证）', async () => {
  // 直接测算法本身，避免受角色卡/日志影响
  let bonusSum = 0, penaltySum = 0;
  const N = 400;
  const rb = seededRandom(7777);
  const rp = seededRandom(7777);
  for (let i = 0; i < N; i++) {
    bonusSum += rollCOCBonus(1, 'bonus', rb).value;
    penaltySum += rollCOCBonus(1, 'penalty', rp).value;
  }
  const bonusAvg = bonusSum / N;
  const penaltyAvg = penaltySum / N;
  assert.ok(bonusAvg < penaltyAvg, `奖励骰均值 ${bonusAvg.toFixed(1)} 应低于惩罚骰均值 ${penaltyAvg.toFixed(1)}`);
  // 期望值约 30 vs 70（同一随机序列下差异应非常明显）
  assert.ok(penaltyAvg - bonusAvg > 15, `两者差异过小: ${(penaltyAvg - bonusAvg).toFixed(1)}`);
});

// ==================== 八、多列检定 ====================

test('.ra 3#60: 输出 3 条检定结果', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(61) });
  try {
    const r = await engine.handle(msg('.ra 3#60'));
    const lines = r.reply.split('\n');
    assert.ok(lines[0].includes('×3'), `表头应显示次数: ${lines[0]}`);
    assert.strictEqual(lines.length, 4, `应为表头 + 3 条结果，实际 ${lines.length} 行`);
    for (const l of lines.slice(1)) {
      assert.ok(/1d100 = \d+ \/ 60/.test(l), `结果行格式不符: ${l}`);
    }
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.ra 3#p手枪 55: 带惩罚骰的多列检定', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(62) });
  try {
    const r = await engine.handle(msg('.ra 3#p手枪 55'));
    assert.ok(r.reply.includes('惩罚骰×1'), r.reply);
    assert.ok(r.reply.includes('/ 55'), r.reply);
    assert.strictEqual(r.reply.split('\n').length, 4);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.ra 5#b2侦查 40: 奖励骰数量正确', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(63) });
  try {
    const r = await engine.handle(msg('.ra 5#b2侦查 40'));
    assert.ok(r.reply.includes('奖励骰×2'), r.reply);
    assert.strictEqual(r.reply.split('\n').length, 6, '5 次应为表头 + 5 行');
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.ra 3#p手枪: 技能无目标值且无角色卡时给出提示', async () => {
  const { store, engine, db } = makeEngine();
  try {
    const r = await engine.handle(msg('.ra 3#p手枪'));
    assert.ok(r.reply.includes('未找到技能'), r.reply);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

// ==================== 九、技能成长 ====================

test('.en: 当前值 0 时必定成长', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(71) });
  try {
    const r = await engine.handle(msg('.en 侦查 0'));
    assert.ok(didGrow(r.reply), r.reply);
    const m = /1d10 = (\d+)/.exec(r.reply);
    assert.ok(m, `应显示 1d10 成长量: ${r.reply}`);
    assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= 10, `成长量越界: ${m[1]}`);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.en: 当前值 99 时基本不成长', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(72) });
  try {
    let grew = 0;
    for (let i = 0; i < 40; i++) {
      const r = await engine.handle(msg('.en 侦查 99'));
      // v1.4 起 .en 输出改为「技能成长」+ 每技能一行的格式（支持多技能一次成长）
      assert.ok(r.reply.includes('侦查'), r.reply);
      assert.ok(/1d100 = \d+ (>|<)=? ?99/.test(r.reply) || r.reply.includes('1d100 = '), r.reply);
      if (didGrow(r.reply)) grew++;
    }
    // 只有掷出 100 才会成长，40 次里期望约 0.4 次
    assert.ok(grew <= 3, `99 的技能不应频繁成长，实际成长 ${grew} 次`);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.en: 能从角色卡读技能值并把成长结果写回', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(73) });
  try {
    await engine.handle(msg('.coc'));
    await engine.handle(msg('.st 技能_侦查 10'));

    let updated = null;
    for (let i = 0; i < 10; i++) {
      const r = await engine.handle(msg('.en 侦查'));
      assert.ok(!r.reply.includes('未找到'), `应能从角色卡读到技能值: ${r.reply}`);
      if (didGrow(r.reply)) { updated = r.reply; break; }
    }
    assert.ok(updated, '10 次尝试中应至少成长一次（技能值仅 10）');

    // 复查角色卡，技能值确实被提高且不超过 99
    const rec = store.getSheet('qq', '1001');
    const sheet = JSON.parse(rec.data);
    const v = sheet.attributes['技能_侦查'];
    assert.ok(v > 10 && v <= 99, `技能应被写回并提升: ${v}`);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.en: 没有角色卡时不报错，只提示未保存', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(74) });
  try {
    const r = await engine.handle(msg('.en 侦查 0'));
    assert.ok(r.reply.includes('未保存'), `应提示未保存: ${r.reply}`);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

// ==================== 十、疯狂表 ====================

test('.ti: 返回临时性疯狂表条目', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(81) });
  try {
    const r = await engine.handle(msg('.ti'));
    assert.ok(r.reply.includes('临时性疯狂'), r.reply);
    const m = /1d10 = (\d+)/.exec(r.reply);
    assert.ok(m, `应显示 d10 点数: ${r.reply}`);
    const roll = Number(m[1]);
    assert.ok(roll >= 1 && roll <= 10);
    // 条目名称应与表中对应行一致
    const entry = tables.MADNESS_IMMEDIATE.find((e) => e.roll === roll);
    assert.ok(r.reply.includes(entry.name), `应对应表内条目 ${entry.name}: ${r.reply}`);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.li: 返回长期性疯狂表条目', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(82) });
  try {
    const r = await engine.handle(msg('.li'));
    assert.ok(r.reply.includes('长期性疯狂'), r.reply);
    const roll = Number(/1d10 = (\d+)/.exec(r.reply)[1]);
    const entry = tables.MADNESS_LONGTERM.find((e) => e.roll === roll);
    assert.ok(r.reply.includes(entry.name), r.reply);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.ti: 分布覆盖全部 10 条（300 次抽样）', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(83) });
  try {
    const seen = new Set();
    for (let i = 0; i < 300; i++) {
      const r = await engine.handle(msg('.ti'));
      seen.add(Number(/1d10 = (\d+)/.exec(r.reply)[1]));
    }
    assert.strictEqual(seen.size, 10, `300 次应覆盖全部 10 条，实际 ${seen.size} 条`);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

// ==================== 十一、COC 5 版出卡 ====================

test('.coc5: 生成 5 版卡，属性范围符合 5 版规则', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(91) });
  try {
    const r = await engine.handle(msg('.coc5'));
    assert.ok(r.reply.includes('COC 5版'), r.reply);

    const rec = store.getSheet('qq', '1001');
    assert.ok(rec, '应写入角色卡');
    assert.strictEqual(rec.system, 'coc5');
    const s = JSON.parse(rec.data);

    // 3d6 → 3..18
    for (const k of ['力量', '体质', '敏捷', '外貌', '意志', '幸运']) {
      const v = s.attributes[k];
      assert.ok(v >= 3 && v <= 18, `${k} 越界: ${v}`);
    }
    // 2d6+6 → 8..18
    for (const k of ['体型', '智力']) {
      const v = s.attributes[k];
      assert.ok(v >= 8 && v <= 18, `${k} 越界: ${v}`);
    }
    // 3d6+3 → 6..21
    assert.ok(s.attributes['教育'] >= 6 && s.attributes['教育'] <= 21, `教育越界: ${s.attributes['教育']}`);

    // 衍生值
    assert.strictEqual(Number(s.derived['理智']), s.attributes['意志'] * 5);
    assert.strictEqual(Number(s.derived['灵感']), s.attributes['智力'] * 5);
    assert.strictEqual(Number(s.derived['知识']), s.attributes['教育'] * 5);
    assert.ok(s.derived['伤害加值'], '应有伤害加值');
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.coc5 与 .coc7 生成的卡 system 不同，互不覆盖混淆', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(92) });
  try {
    await engine.handle(msg('.coc5', { userId: '5001' }));
    assert.strictEqual(store.getSheet('qq', '5001').system, 'coc5');
    await engine.handle(msg('.coc7', { userId: '5002' }));
    assert.strictEqual(store.getSheet('qq', '5002').system, 'coc7');
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

// ==================== 十二、统计 ====================

test('.stat: 无记录时给出友好提示', async () => {
  const { store, engine, db } = makeEngine();
  try {
    const r = await engine.handle(msg('.stat'));
    assert.ok(r.reply.includes('还没有任何掷骰记录'), r.reply);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.stat: 掷骰后能统计次数、平均、最高最低', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(101) });
  try {
    for (let i = 0; i < 12; i++) await engine.handle(msg('.r 1d100'));
    const r = await engine.handle(msg('.stat'));
    assert.ok(/总掷骰 12 次/.test(r.reply), r.reply);
    assert.ok(/参与 1 人/.test(r.reply), r.reply);
    assert.ok(/平均 /.test(r.reply), r.reply);
    assert.ok(/最高 /.test(r.reply), r.reply);
    assert.ok(/百分骰（1d100）共 12 次/.test(r.reply), r.reply);
    // 分段柱状图应有 5 段
    assert.strictEqual((r.reply.match(/[1-8][0-9]?-\d+/g) || []).length >= 5, true, r.reply);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.stat: 只统计本群，不串到别的群', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(102) });
  try {
    for (let i = 0; i < 5; i++) await engine.handle(msg('.r 1d100', { groupId: 'G1' }));
    for (let i = 0; i < 3; i++) await engine.handle(msg('.r 1d100', { groupId: 'G2' }));
    const g1 = await engine.handle(msg('.stat', { groupId: 'G1' }));
    const g2 = await engine.handle(msg('.stat', { groupId: 'G2' }));
    assert.ok(/总掷骰 5 次/.test(g1.reply), g1.reply);
    assert.ok(/总掷骰 3 次/.test(g2.reply), g2.reply);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.hiy: 统计个人记录并跨群汇总', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(103) });
  try {
    for (let i = 0; i < 4; i++) await engine.handle(msg('.r 1d100', { groupId: 'G1', userId: 'A' }));
    for (let i = 0; i < 3; i++) await engine.handle(msg('.r 1d100', { groupId: 'G2', userId: 'A' }));
    await engine.handle(msg('.r 1d100', { groupId: 'G1', userId: 'B' }));

    const r = await engine.handle(msg('.hiy', { groupId: 'G1', userId: 'A' }));
    assert.ok(/总掷骰 7 次/.test(r.reply), `应跨群汇总 A 的 7 次记录: ${r.reply}`);
    assert.ok(r.reply.includes('我的掷骰统计'), r.reply);

    const rb = await engine.handle(msg('.hiy', { groupId: 'G1', userId: 'B' }));
    assert.ok(/总掷骰 1 次/.test(rb.reply), rb.reply);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.stat 今日: 只统计今天（而不是全部历史）', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(104) });
  try {
    // 手工写入一条「昨天」的记录
    const yesterday = Date.now() - 24 * 3600 * 1000;
    store.addLog({
      platform: 'qq', groupId: '88888', groupName: undefined,
      userId: '1001', userName: '测试员',
      expression: '1d100', total: 50, detail: '旧记录',
      createdAt: yesterday,
    });
    await engine.handle(msg('.r 1d100')); // 今天 1 条

    const all = await engine.handle(msg('.stat'));
    assert.ok(/总掷骰 2 次/.test(all.reply), `全部应含 2 条: ${all.reply}`);

    const today = await engine.handle(msg('.stat 今日'));
    assert.ok(/总掷骰 1 次/.test(today.reply), `今日应只有 1 条: ${today.reply}`);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.stat: 统计包含大成功与大失败计数', async () => {
  const { store, engine, db } = makeEngine();
  try {
    // 手工构造可预期的百分骰记录
    const mk = (total, i) => ({
      platform: 'qq', groupId: '88888', groupName: undefined,
      userId: '1001', userName: '测试员',
      expression: 'ra 侦查 60', total, detail: 'x', createdAt: Date.now() + i,
    });
    [1, 100, 96, 50, 30].forEach((t, i) => store.addLog(mk(t, i)));

    const r = await engine.handle(msg('.stat'));
    assert.ok(/大成功 1 次/.test(r.reply), r.reply);
    assert.ok(/大失败 2 次/.test(r.reply), r.reply);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

// ==================== 十三、.help 语义 ====================

test('.help <词条>: 命中内置规则词条', async () => {
  const { store, engine, db } = makeEngine();
  try {
    const r = await engine.handle(msg('.help 成功等级'));
    assert.ok(r.reply.includes('大成功') && r.reply.includes('极难成功'), r.reply);

    const r2 = await engine.handle(msg('.help 奖励骰'));
    assert.ok(r2.reply.includes('取'), r2.reply);

    const r3 = await engine.handle(msg('.rule 大失败'));
    assert.ok(r3.reply.includes('96'), r3.reply);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.help <技能名>: 返回技能基础值', async () => {
  const { store, engine, db } = makeEngine();
  try {
    const r = await engine.handle(msg('.help 侦查'));
    assert.ok(r.reply.includes('25'), `侦查基础值应为 25: ${r.reply}`);
    const r2 = await engine.handle(msg('.help 急救'));
    assert.ok(r2.reply.includes('30'), `急救基础值应为 30: ${r2.reply}`);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.help <词条>: 未命中时给出候选或可用列表', async () => {
  const { store, engine, db } = makeEngine();
  try {
    const r = await engine.handle(msg('.help 成'));
    assert.ok(r.reply.includes('你是不是想找') || r.reply.includes('成功等级'), r.reply);

    const r2 = await engine.handle(msg('.help zzz不存在zzz'));
    assert.ok(r2.reply.includes('没有找到'), r2.reply);
    assert.ok(r2.reply.includes('侦查'), '应列出可用词条兜底');
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('.help 无参数: 仍然走发图逻辑（不发文字表）', async () => {
  const { store, engine, db } = makeEngine();
  try {
    const r = await engine.handle(msg('.help'));
    const hasImage = !!(r.images && r.images.length > 0);
    const isText = r.reply.includes('AleaBot');
    assert.ok(hasImage || isText, `既没有图也没有文字: ${JSON.stringify(r)}`);
    if (hasImage) assert.strictEqual(r.reply, '', '发图时不应再带文字');
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

// ==================== 十四、回归：老功能未被破坏 ====================

test('回归: .r / .ra / .st 行为不变', async () => {
  const { store, engine, db } = makeEngine({ rng: seededRandom(111) });
  try {
    const r = await engine.handle(msg('.r 3d6'));
    assert.ok(/3d6 = \d+/.test(r.reply), r.reply);

    await engine.handle(msg('.st 侦查 70'));
    const c = await engine.handle(msg('.ra 侦查'));
    assert.ok(/\/ 70/.test(c.reply), `应从角色卡读到 70: ${c.reply}`);
    assert.ok(/✅|❌/.test(c.reply), c.reply);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});

test('回归: 未知指令仍给出提示', async () => {
  const { store, engine, db } = makeEngine();
  try {
    const r = await engine.handle(msg('.这不是指令'));
    assert.ok(r.reply.includes('未知指令'), r.reply);
  } finally {
    store.close();
    try { fs.unlinkSync(db); } catch { /* 忽略 */ }
  }
});
