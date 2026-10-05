// 验证：角色卡名字=玩家昵称（.st name / .sn）+ 通用紧贴写法
const { Engine } = require('../dist/core/engine.js');
const { Store } = require('../dist/core/store.js');

const mk = (t, uid = 'u1', uname = '平台昵称') => ({
  platform: 'qq', groupId: 'g1', groupName: '测试群',
  userId: uid, userName: uname, text: t, isPrivate: false,
});

let pass = 0, fail = 0;
function check(label, got, expectIncludes) {
  const ok = expectIncludes.every((e) => got.includes(e));
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) { fail++; console.log('   期望包含:', JSON.stringify(expectIncludes), '\n   实际:', JSON.stringify(got.slice(0, 120))); }
  else pass++;
  return ok;
}

(async () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, { admins: ['u1'] });

  // 1) 设置角色卡名字 = 昵称
  let r = await engine.handle(mk('.st name 张三'));
  check('.st name 张三 设置昵称', r.reply, ['张三', '昵称']);

  // 2) 之后掷骰署名用昵称
  r = await engine.handle(mk('.r 2d6'));
  check('.r 2d6 署名用昵称', r.reply, ['【张三】']);

  // 3) .st show 显示名字
  r = await engine.handle(mk('.coc'));  // 生成卡，应保留昵称
  check('.coc 生成卡保留昵称', r.reply, ['张三']);
  r = await engine.handle(mk('.st show'));
  check('.st show 含名字', r.reply, ['张三']);

  // 4) .sn 简写改昵称
  r = await engine.handle(mk('.sn 李四'));
  check('.sn 李四 改昵称', r.reply, ['李四']);
  r = await engine.handle(mk('.r 1d20'));
  check('.r 1d20 署名=李四', r.reply, ['【李四】']);

  // 5) .sn 无参查看
  r = await engine.handle(mk('.sn'));
  check('.sn 查看昵称', r.reply, ['李四']);

  // 6) 紧贴写法：检定
  r = await engine.handle(mk('.ra侦查60'));
  check('.ra侦查60 紧贴', r.reply, ['侦查检定']);

  // 7) 紧贴：属性连写
  r = await engine.handle(mk('.st力量88'));
  check('.st力量88 紧贴连写', r.reply, ['力量', '88']);

  // 8) 紧贴：掷骰
  r = await engine.handle(mk('.r3d100'));
  check('.r3d100 紧贴', r.reply, ['3d100']);

  // 9) 紧贴：.bot on
  r = await engine.handle(mk('.boton'));
  check('.boton 紧贴', r.reply, ['启用']);

  // 11) 紧贴：.init add（子命令）
  r = await engine.handle(mk('.initadd张三 15'));
  check('.initadd张三 15 紧贴子命令', r.reply, ['张三', '15']);

  // 12) 紧贴：.draw 塔罗
  r = await engine.handle(mk('.draw塔罗3'));
  check('.draw塔罗3 紧贴', r.reply, ['塔罗']);

  // 13) 紧贴：.help 词条
  r = await engine.handle(mk('.help成功等级'));
  check('.help成功等级 紧贴', r.reply, ['成功等级']);

  // 14) 紧贴：.log new
  r = await engine.handle(mk('.lognew黑圣杯'));
  check('.lognew黑圣杯 紧贴', r.reply, ['黑圣杯', '日志']);

  // 15) 紧贴：.sn 无空格
  r = await engine.handle(mk('.sn王五'));
  check('.sn王五 紧贴无空格', r.reply, ['王五']);

  // 16) 回归：普通带空格指令仍正常
  r = await engine.handle(mk('.ra 侦查 60'));
  check('.ra 侦查 60 普通', r.reply, ['侦查检定']);
  r = await engine.handle(mk('.hp+3'));
  check('.hp+3 增减HP', r.reply, ['HP']);

  // 17) 紧贴：.set prefix !（动词与参数紧贴，参数内部仍留空格）—— 放最后，因其会改变本群前缀
  r = await engine.handle(mk('.setprefix !'));
  check('.setprefix ! 紧贴', r.reply, ['prefix', '!']);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
