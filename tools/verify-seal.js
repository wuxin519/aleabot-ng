/**
 * v1.4 主流骰娘对齐验证脚本
 * 覆盖：批量制卡 / .st 全套子命令 / 检定调整与难度 / .sc 标志 / .en 多技能 / 完整房规 / .pc 卡片管理
 */
const { Engine } = require('../dist/core/engine.js');
const { Store } = require('../dist/core/store.js');

let pass = 0, fail = 0;
function check(label, reply, expect) {
  const got = reply || '';
  const ok = expect.every((e) => got.includes(e));
  if (ok) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label, '\n     期望含:', expect.join(' | '), '\n     实际:', got.slice(0, 150)); }
}
function checkNot(label, reply, forbid) {
  const got = reply || '';
  const ok = !got.includes(forbid);
  if (ok) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label, '（不该含', forbid, '）:', got.slice(0, 120)); }
}

(async () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, {});
  const mk = (t) => ({ platform: 'qq', groupId: 'g1', groupName: 'T', userId: 'u1', userName: '甲', text: t, isPrivate: false });
  const send = async (t) => (await engine.handle(mk(t)))?.reply || '';

  console.log('\n=== 1) 批量制卡 .coc N（只主属性）===');
  const coc5 = await send('.coc 5');
  check('.coc 5 出 5 组', coc5, ['× 5', '1.', '5.', 'HP:', '只含主属性']);
  check('.coc 5 含总值', coc5, ['[']);
  // 批量制卡只出主属性：不应出现技能列表行（技能: xxx 形式）
  checkNot('.coc 5 无技能列表', coc5, '技能:');
  check('.coc 3 正常', await send('.coc 3'), ['× 3']);
  check('.coc 25 拒绝', await send('.coc 25'), ['最多生成 20']);
  check('.coc 1 走建卡', await send('.coc'), ['角色卡']);

  console.log('\n=== 2) .st 全套子命令（主流骰娘语义）===');
  await send('.st 力量70 体质60 敏捷55 幸运50 侦查40 魔法30');
  check('.st show 全卡', await send('.st show'), ['力量', '体质']);
  check('.st show 侦查 单项', await send('.st show 侦查'), ['侦查']);
  const exp = await send('.st export');
  check('.st export', exp, ['主属性', '.st 力量70']);
  check('.st &表达式', await send('.st &手枪伤害=1d6+1'), ['手枪伤害']);
  check('.r 调表达式', await send('.r 手枪伤害'), ['手枪伤害']);
  check('.st del 单个', await send('.st del 魔法'), ['已删除属性', '魔法']);
  check('.st del 多属性', await send('.st del 幸运 敏捷'), ['已删除属性']);
  check('.st clr 全清', await send('.st clr'), ['已清空']);

  console.log('\n=== 3) 检定：调整 + 难度 + .rc ===');
  await send('.st 侦查40 敏捷55 力量70');
  check('.ra 基础', await send('.ra 侦查'), ['侦查']);
  const adj = await send('.ra 侦查+10');
  check('.ra +10 目标50', adj, ['/ 50']);
  check('.ra -5 目标35', await send('.ra 侦查-5'), ['/ 35']);
  check('.ra 困难前缀', await send('.ra 困难侦查'), ['需困难成功']);
  check('.ra 极难前缀', await send('.ra 极难侦查'), ['需极难成功']);
  check('.ra 大成功前缀', await send('.ra 大成功侦查'), ['需大成功']);
  check('.ra 困难+10 组合', await send('.ra 困难侦查+10'), ['/ 50', '需困难成功']);
  check('.rc 规则书检定', await send('.rc 侦查'), ['侦查']);

  console.log('\n=== 4) .sc 标志 --cap / --half ===');
  await send('.st 理智60');
  check('.sc --cap', await send('.sc 60 1/1d6 --cap=2'), ['--cap=2']);
  check('.sc --half', await send('.sc 60 1/1d6 --half'), ['--half', '减半']);
  check('.sc cap+half 同用', await send('.sc 60 1/1d6 --cap=3 --half'), ['--half']);

  console.log('\n=== 5) .en 多技能 + 自定义成长 ===');
  await send('.st 侦查40 聆听35 图书馆使用50');
  check('.en 单技能', await send('.en 侦查'), ['侦查']);
  const multi = await send('.en 聆听 图书馆使用');
  check('.en 多技能', multi, ['技能成长 ×2', '聆听', '图书馆使用']);
  check('.en 指定点数', await send('.en 侦查 50'), ['1d100']);
  check('.en 自定义成长', await send('.en 侦查 +0/1d6'), ['1d6']);
  check('.en 重复技能拒绝', await send('.en 侦查 侦查'), ['重复']);

  console.log('\n=== 6) .setcoc 完整房规 ===');
  check('.setcoc details 全表', await send('.setcoc details'), ['0 =', '1 =', '2 =', '3 =', '4 =', '5 =', 'dg']);
  for (const r of ['0', '1', '2', '3', '4', '5', 'dg']) {
    check(`.setcoc ${r} 可切`, await send(`.setcoc ${r}`), [`已切换房规为 ${r}`]);
  }
  check('.setcoc 非法拒绝', await send('.setcoc 9'), ['不支持的房规']);

  console.log('\n=== 7) .pc 卡片管理 ===');
  check('.pc 帮助', await send('.pc'), ['.pc new', '.pc tag', '.pc del']);
  check('.pc new', await send('.pc new 卡A'), ['已新建', '卡A']);
  check('.pc list', await send('.pc list'), ['卡A']);
  check('.pc tag 切换', await send('.pc tag 卡A'), ['已切换']);
  check('.pc show', await send('.pc show'), ['角色卡']);
  check('.pc nn 改名', await send('.pc nn 乙'), ['乙']);
  check('.pc del 删卡', await send('.pc del 卡A'), ['已删除']);
  check('.st del 不再删卡（删属性）', await send('.st del 不存在属性'), ['未找到属性']);

  console.log('\n=== 8) 杂项小指令 ===');
  check('.nn = .st name', await send('.nn 丙'), ['丙']);
  check('.find = .help kw', await send('.find 成功等级'), ['成功']);
  check('.dismiss = bot bye', await send('.dismiss'), ['退群']);
  check('.ri 设定先攻', await send('.ri 15'), ['先攻']);
  check('.ri 调整值', await send('.ri +2'), ['先攻']);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
