/**
 * 部署后冒烟：在服务器本地用真实 dist 跑一遍批次 1 的新指令。
 * 使用独立临时数据库，绝不碰线上 data/aleabot.db。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const DIST = '<安装目录>/dist';
const { Engine } = require(path.join(DIST, 'core', 'engine.js'));
const { Store } = require(path.join(DIST, 'core', 'store.js'));

const db = path.join(os.tmpdir(), 'alea-smoke-' + Date.now() + '.db');
const store = new Store(db);
const engine = new Engine(store, { backupDir: path.join(os.tmpdir(), 'alea-smoke-bak') });

function msg(text, extra) {
  return Object.assign({
    platform: 'qq', groupId: '99999', userId: '1', userName: '冒烟',
    text, isPrivate: false,
  }, extra || {});
}

const cases = [
  ['.jrrp', '今日人品'],
  ['.gugu', null],
  ['.who 甲 乙 丙', '随机顺序'],
  ['.name cn 3', '随机中文名'],
  ['.name jp 3', '随机日文名'],
  ['.rb 侦查 60', '奖励骰'],
  ['.rp 侦查 60', '惩罚骰'],
  ['.ra 3#60', '连发'],
  ['.ra 3#p手枪 55', '惩罚骰×1'],
  ['.en 侦查 0', '成长检定'],
  ['.ti', '临时性疯狂'],
  ['.li', '长期性疯狂'],
  ['.coc5', 'COC 5版'],
  ['.draw 塔罗 3', '塔罗'],
  ['.drawlist', '牌堆'],
  ['.stat', null],
  ['.hiy', null],
  ['.help 成功等级', '大成功'],
  ['.help 侦查', '基础值: 25'],
];

(async () => {
  let pass = 0, fail = 0;
  for (const [cmd, expect] of cases) {
    try {
      const r = await engine.handle(msg(cmd));
      const text = (r && r.reply) || '';
      const hasImg = !!(r && r.images && r.images.length);
      const ok = expect === null ? (text.length > 0 || hasImg) : text.includes(expect);
      if (ok) { pass++; console.log(`OK   ${cmd}`); }
      else { fail++; console.log(`FAIL ${cmd} -> ${JSON.stringify(text.slice(0, 120))}`); }
    } catch (e) {
      fail++;
      console.log(`ERR  ${cmd} -> ${e.message}`);
    }
  }

  // .help 发图
  const h = await engine.handle(msg('.help'));
  const imgOk = !!(h.images && h.images.length && fs.existsSync(h.images[0]) && fs.statSync(h.images[0]).size > 100000);
  if (imgOk) { pass++; console.log('OK   .help 发图 -> ' + h.images[0]); }
  else { fail++; console.log('FAIL .help 发图 -> ' + JSON.stringify(h)); }

  // 抽样看两条真实输出
  console.log('\n--- 样例输出 ---');
  for (const c of ['.jrrp', '.rb 侦查 60', '.ra 3#p手枪 55', '.ti', '.help 成功等级']) {
    const r = await engine.handle(msg(c));
    console.log(`\n> ${c}\n${r.reply}`);
  }

  store.close();
  try { fs.unlinkSync(db); } catch (e) { /* 忽略 */ }

  console.log(`\n===== 部署冒烟: ${pass}/${pass + fail} 通过 =====`);
  process.exit(fail === 0 ? 0 : 1);
})();
