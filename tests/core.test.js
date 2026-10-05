/**
 * 骰点引擎与命令解析的单元测试（使用 Node 内置 test 运行器，无需第三方依赖）。
 * 运行：npm test
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

// 载入编译后的产物
const DIST = path.join(__dirname, '..', 'dist');
const { roll, rollExpression, cocCheck } = require(path.join(DIST, 'core', 'dice.js'));
const { parseCommand } = require(path.join(DIST, 'core', 'command.js'));
const { seededRandom } = require(path.join(DIST, 'core', 'random.js'));
const { generateCOC, generateDND } = require(path.join(DIST, 'core', 'sheet.js'));

// ---------- 骰点基础 ----------
test('roll: 3d6 结果在合法范围内', () => {
  for (let i = 0; i < 50; i++) {
    const r = roll('3d6');
    assert.ok(r.total >= 3 && r.total <= 18, `3d6 结果越界: ${r.total}`);
    assert.strictEqual(r.groups[0].rolls.length, 3);
  }
});

test('roll: 常量加减正确', () => {
  const rng = seededRandom(5);
  const r = roll('2d6+5-2', rng); // 常量部分 +5-2 = +3
  assert.strictEqual(r.total, r.groups[0].subtotal + 3);
});

test('roll: 4d6k3 取最高的三个', () => {
  const rng = seededRandom(42);
  const r = roll('4d6k3', rng);
  const g = r.groups[0];
  assert.strictEqual(g.rolls.length, 4);
  assert.strictEqual(g.kept.length, 3);
  assert.strictEqual(g.dropped.length, 1);
  // kept 应等于 rolls 排序后的前三个
  const sorted = [...g.rolls].sort((a, b) => b - a);
  assert.strictEqual(g.subtotal, sorted[0] + sorted[1] + sorted[2]);
});

test('roll: 2d20kh1 优势取高', () => {
  const rng = seededRandom(7);
  const r = roll('2d20kh1', rng);
  const g = r.groups[0];
  assert.strictEqual(g.kept.length, 1);
  assert.strictEqual(g.subtotal, Math.max(...g.rolls));
});

test('roll: 2d20kl1 劣势取低', () => {
  const rng = seededRandom(7);
  const r = roll('2d20kl1', rng);
  const g = r.groups[0];
  assert.strictEqual(g.subtotal, Math.min(...g.rolls));
});

test('roll: d6 省略数量默认为 1', () => {
  const r = roll('d6');
  assert.strictEqual(r.groups[0].count, 1);
  assert.ok(r.total >= 1 && r.total <= 6);
});

test('roll: 多组骰子混合', () => {
  const r = roll('2d6+1d4');
  assert.strictEqual(r.groups.length, 2);
  assert.ok(r.total >= 3 && r.total <= 16);
});

test('roll: 非法表达式抛错', () => {
  assert.throws(() => roll('abc'));
  assert.throws(() => roll('3x6'));
  assert.throws(() => roll(''));
});

test('roll: 骰子数量上限保护', () => {
  assert.throws(() => roll('2000d6'));
});

// ---------- 确定性 ----------
test('roll: 固定种子结果可复现', () => {
  const a = roll('10d6', seededRandom(123));
  const b = roll('10d6', seededRandom(123));
  assert.deepStrictEqual(a.groups[0].rolls, b.groups[0].rolls);
});

// ---------- COC 检定 ----------
test('cocCheck: 大成功', () => {
  const c = cocCheck(1, 60);
  assert.strictEqual(c.level, '大成功');
  assert.ok(c.success);
});

test('cocCheck: 极难/困难/成功分级', () => {
  assert.strictEqual(cocCheck(10, 60).level, '极难成功'); // 60/5 = 12
  assert.strictEqual(cocCheck(30, 60).level, '困难成功'); // 60/2 = 30
  assert.strictEqual(cocCheck(55, 60).level, '成功');
  assert.strictEqual(cocCheck(90, 60).level, '失败');
});

test('cocCheck: 大失败规则(目标<50, 96+)', () => {
  assert.strictEqual(cocCheck(96, 40).level, '大失败');
  assert.strictEqual(cocCheck(95, 40).level, '失败');
});

test('rollExpression: 1d100<=50 检定式', () => {
  const r = rollExpression('1d100<=50');
  assert.ok(r.check, '应包含检定信息');
  assert.strictEqual(r.check.target, 50);
  assert.ok(r.check.roll >= 1 && r.check.roll <= 100);
});

// ---------- 命令解析 ----------
test('parseCommand: 普通掷骰', () => {
  const c = parseCommand('.r 3d6+2');
  assert.strictEqual(c.type, 'roll');
  assert.deepStrictEqual(c.args, ['3d6+2']);
});

test('parseCommand: 空参数为默认骰', () => {
  const c = parseCommand('.r');
  assert.strictEqual(c.type, 'roll-default');
});

test('parseCommand: 检定', () => {
  const c = parseCommand('.ra 侦查 60');
  assert.strictEqual(c.type, 'check');
  assert.deepStrictEqual(c.args, ['侦查', '60']);
});

test('parseCommand: 非命令返回 null', () => {
  assert.strictEqual(parseCommand('你好啊'), null);
  assert.strictEqual(parseCommand(''), null);
});

test('parseCommand: 先攻子命令', () => {
  assert.strictEqual(parseCommand('.init add 张三 15').type, 'init-add');
  assert.strictEqual(parseCommand('.init list').type, 'init-list');
  assert.strictEqual(parseCommand('.init clr').type, 'init-clear');
});

test('parseCommand: 自定义前缀', () => {
  const c = parseCommand('!r 1d20', '!');
  assert.strictEqual(c.type, 'roll');
  assert.strictEqual(parseCommand('.r 1d20', '!'), null);
});

// ---------- 角色卡 ----------
test('generateCOC: 属性在合理范围', () => {
  const rng = seededRandom(2024);
  const sheet = generateCOC('测试角色', rng);
  assert.strictEqual(sheet.system, 'coc7');
  for (const key of ['力量', '体质', '敏捷', '意志']) {
    const v = sheet.attributes[key];
    assert.ok(v >= 15 && v <= 90, `${key} 越界: ${v}`);
  }
  assert.ok(Number(sheet.derived['生命值']) > 0);
});

test('generateDND: 属性在 3-18 范围', () => {
  const rng = seededRandom(99);
  const sheet = generateDND('测试冒险者', rng);
  assert.strictEqual(sheet.system, 'dnd5e');
  for (const key of ['力量', '敏捷', '体质', '智力', '感知', '魅力']) {
    const v = sheet.attributes[key];
    assert.ok(v >= 3 && v <= 18, `${key} 越界: ${v}`);
  }
  assert.ok(sheet.derived['种族']);
  assert.ok(sheet.derived['职业']);
});

console.log('提示：以上测试若全部通过，说明核心引擎工作正常。');
