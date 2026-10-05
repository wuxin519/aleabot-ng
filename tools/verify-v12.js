/**
 * v1.2 新功能手动验证脚本
 * 用固定随机源跑一遍所有新增指令，逐条打印回复，便于人工核对文案。
 * 用法：node tools/verify-v12.js
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { Engine } = require(path.join(ROOT, 'dist/core/engine.js'));
const { Store } = require(path.join(ROOT, 'dist/core/store.js'));

const store = new Store(':memory:');
// 固定随机源：0.42 → 每次落点一致，结果可复现
const engine = new Engine(store, { rng: () => 0.42 });

function mk(text, extra = {}) {
  return {
    platform: 'qq', groupId: 'g1', groupName: '测试群',
    userId: 'u1', userName: '测试员', text, isPrivate: false, ...extra,
  };
}

/** 把多行回复压成单行并截断，避免刷屏 */
function oneLine(s, n = 200) {
  if (!s) return '(无回复)';
  const t = String(s).replace(/\n/g, ' / ');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

(async () => {
  const cases = [
    // —— 紧贴写法（用户截图里的核心诉求）——
    '.r3d100',
    '.r3#2d50',
    '.r 3#2d10',
    '.st力量88',
    '.ra侦查 60',
    '.ra侦查60',
    // —— 中文优势/劣势 ——
    '.r d20优势', '.r d20劣势', '.r d劣势',
    // —— 省略面数 ——
    '.r d', '.r 2d',
    // —— 特殊骰法 ——
    '.r f', '.r 5a6', '.r 4c3', '.r 4c3m7',
    // —— 奖励/惩罚骰裸掷 ——
    '.r b3', '.r p2',
    // —— 暗骰 ——
    '.rh 1d20',
    // —— 理智检定 ——
    '.st 理智 55', '.sc', '.sc 0/1d10', '.sc 60 1/1d6',
    // —— HP / SAN 快捷 ——
    '.hp', '.hp+3', '.hp-1d4', '.san-1d4',
    // —— 房规 ——
    '.setcoc', '.setcoc 1', '.setcoc 2',
    // —— 群开关 ——
    '.bot',
  ];

  for (const c of cases) {
    let r = null;
    try {
      r = await engine.handle(mk(c));
    } catch (e) {
      console.log(`\n>> ${c}\n   !! 抛异常: ${e.message}`);
      continue;
    }
    console.log(`\n>> ${c}`);
    console.log(`   ${oneLine(r && r.reply)}`);
    if (r && r.groupHint) console.log(`   [群提示] ${oneLine(r.groupHint, 80)} | 私聊=${!!r.privateReply}`);
    if (r && r.bye) console.log(`   [退群] bye=true`);
  }

  // —— 关/开 全链路 ——
  console.log('\n===== .bot 开关全链路 =====');
  console.log('>> .bot off →', oneLine((await engine.handle(mk('.bot off'))).reply, 80));
  const silent = await engine.handle(mk('.r 1d6'));
  console.log('>> off 后 .r 1d6 →', silent === null ? 'null（已静默，符合预期）' : oneLine(silent.reply));
  console.log('>> .bot on  →', oneLine((await engine.handle(mk('.bot on'))).reply, 80));
  console.log('>> 恢复后 .r 1d6 →', oneLine((await engine.handle(mk('.r 1d6'))).reply, 80));

  // —— .bot bye 退群 ——
  console.log('\n===== .bot bye 退群 =====');
  const bye = await engine.handle(mk('.bot bye'));
  console.log('>> .bot bye →', oneLine(bye && bye.reply, 80), '| bye =', !!(bye && bye.bye));
})();
