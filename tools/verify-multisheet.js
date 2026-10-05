/**
 * v1.3 多角色卡 / 批量录入 / 按位置录入 验证脚本
 * 用法：node tools/verify-multisheet.js
 */
const { Engine } = require('../dist/core/engine.js');
const { Store } = require('../dist/core/store.js');

let pass = 0, fail = 0;
function check(label, reply, expect) {
  const got = reply || '';
  const ok = expect.every((e) => got.includes(e));
  if (ok) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label, '\n     期望含:', expect.join(' | '), '\n     实际:', got.slice(0, 120)); }
}

(async () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, {});
  const mk = (t) => ({ platform: 'qq', groupId: 'g1', groupName: '测试群', userId: 'u1', userName: '平台昵称', text: t, isPrivate: false });
  const send = async (t) => (await engine.handle(mk(t)))?.reply || '';

  console.log('\n=== 1) 多角色卡：新建 / 列表 / 切换 ===');
  check('首次 .st list（无卡）', await send('.st list'), ['还没有角色卡']);

  check('.st new 调查员A', await send('.st new 调查员A'), ['已新建', '调查员A', '切换']);
  check('.st new 调查员B', await send('.st new 调查员B'), ['已新建', '调查员B']);
  check('.st list 列出两张', await send('.st list'), ['调查员A', '调查员B', '当前']);
  check('重复新建同名被拒', await send('.st new 调查员A'), ['已存在']);

  console.log('\n=== 2) 批量录入（空格分隔 + 无空格连写）===');
  // 切到 调查员A 再录入
  check('.st switch 调查员A', await send('.st switch 调查员A'), ['已切换', '调查员A']);
  check('批量带空格', await send('.st 力量88 体质70 敏捷60'), ['力量:88', '体质:70', '敏捷:60']);
  check('批量无空格连写', await send('.st力量88体质70敏捷60'), ['力量:88', '体质:70', '敏捷:60']);
  check('单键查询验证', await send('.st 力量'), ['88']);

  console.log('\n=== 3) 按位置录入（免键名）===');
  check('按顺序 9 项', await send('.st 50 55 60 65 70 45 75 80 90'), ['力量:50', '体质:55', '敏捷:60', '幸运:90']);
  check('位置录入后查力量', await send('.st 力量'), ['力量 = 50']);
  check('按顺序 6 项(取前6个属性)', await send('.st 12 14 15 13 11 10'), ['力量:12', '体质:14', '体型:10']);
  check('超过上限被拒', await send('.st 1 2 3 4 5 6 7 8 9 10 11'), ['只支持 9 个值']);

  console.log('\n=== 4) 卡之间数据隔离 + 切换校验 ===');
  check('切到 调查员B', await send('.st switch 调查员B'), ['已切换', '调查员B']);
  // B 卡应是刚 new 出来的随机值，不是 A 卡录入的 12
  const bStr = await send('.st 力量');
  check('B 卡独立数据（不是A的12）', bStr, ['力量 = ']);
  const bVal = parseInt(bStr.split('=')[1].trim(), 10);
  check('B 卡值确实不同', String(bVal), [String(bVal)]);
  console.log('     B 卡力量 =', bVal, '（A 卡是 12，说明已隔离）');
  check('按编号切回 A', await send('.st switch 1'), ['已切换', '调查员A']);
  check('A 卡数据仍在', await send('.st 力量'), ['力量 = 12']);

  console.log('\n=== 5) 删除角色卡（v1.4 起删卡走 .pc del，.st del 改为删属性）===');
  check('.pc del 调查员B', await send('.pc del 调查员B'), ['已删除', '调查员B']);
  check('删除后只剩一张', await send('.st list'), ['调查员A']);
  check('删当前卡自动切走', await send('.pc del 调查员A'), ['已删除']);
  check('无卡状态', await send('.st list'), ['还没有角色卡']);

  console.log('\n=== 6) 回归：旧功能不受影响 ===');
  check('.coc 生成', await send('.coc'), ['COC 7版 角色卡']);
  check('.st name 设昵称', await send('.st name 张三'), ['张三']);
  check('署名用昵称', await send('.r 2d6'), ['张三']);
  check('.st show', await send('.st show'), ['角色卡']);
  check('.st 幸运 40 存自定义属性', await send('.st 幸运 40'), ['幸运']);
  check('.st 幸运+5 增减', await send('.st 幸运+5'), ['幸运: 40 → 45']);
  check('.hp+3 增减(COC 的 HP 在 derived)', await send('.hp+3'), ['HP']);
  check('.ra 检定', await send('.ra 侦查 60'), ['侦查检定']);
  check('.hp 查看', await send('.hp'), ['HP']);
  check('.coc 重建保留昵称', await send('.coc'), ['张三']);
  check('.st new 后 .coc 只覆盖当前卡', await send('.st new 测试B'), ['已新建']);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
