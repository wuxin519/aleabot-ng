/**
 * .help 发图链路专项验证
 *
 * 覆盖三件事：
 *   1. 图片存在时，dispatch('help') 返回 images 且 reply 为空
 *   2. 图片不存在时，自动降级为纯文字帮助（保证 .help 永远有响应）
 *   3. OneBot 适配器的消息段组装正确（file:// 前缀、图文混排、纯文本退化）
 *
 * 运行：node tests/help-image.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const IMG = path.join(ROOT, 'docs', '指令图.png');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

// ---------- 1. 图片存在时返回 images ----------
console.log('\n--- 1. 引擎侧：.help 返回图片 ---');
check('指令图文件存在', fs.existsSync(IMG), IMG);
if (!fs.existsSync(IMG)) {
  console.error('缺少指令图，无法继续测试。请先渲染 docs/指令图.png');
  process.exit(1);
}
check('图片非空', fs.statSync(IMG).size > 1000, `${fs.statSync(IMG).size} bytes`);

const { Engine } = require(path.join(DIST, 'core', 'engine.js'));
const { Store } = require(path.join(DIST, 'core', 'store.js'));

const DB = path.join(os.tmpdir(), `alea-help-test-${Date.now()}.db`);
const store = new Store(DB);
const engine = new Engine(store, { admins: ['1001'], backupDir: path.join(os.tmpdir(), 'alea-bak') });

const msg = {
  platform: 'qq', groupId: '88888', userId: '1001', userName: '测试',
  text: '.help', isPrivate: false,
};

(async () => {
  const r = await engine.handle(msg);
  check('.help 有返回', !!r);
  check('.help 返回了 images 数组', !!(r && r.images && r.images.length === 1),
    r && r.images ? r.images.join(', ') : 'undefined');
  check('.help 返回的图片路径真实存在', !!(r && r.images && fs.existsSync(r.images[0])),
    r && r.images ? r.images[0] : '');
  check('.help 文本为空（只发图）', !!(r && r.reply === ''), r ? JSON.stringify(r.reply) : '');

  // ---------- 2. 图片缺失时降级 ----------
  console.log('\n--- 2. 降级：图片缺失时回纯文字 ---');
  // 隔离手段：把 cwd 切到一个空临时目录，这样 public/ 和 docs/ 候选全部落空；
  // 同时不设 HELP_IMAGE。这才是「部署时忘了放图」的真实场景。
  const origCwd = process.cwd();
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alea-empty-'));
  const savedEnv = process.env.HELP_IMAGE;
  delete process.env.HELP_IMAGE;
  process.chdir(emptyDir);

  const engine2 = new Engine(store, { admins: [], backupDir: path.join(os.tmpdir(), 'alea-bak') });
  const r2 = await engine2.handle(msg);
  const okFallback = !!r2 && (!r2.images || r2.images.length === 0) && r2.reply.includes('AleaBot');
  check('图片缺失时降级为文字', okFallback,
    r2 ? `images=${JSON.stringify(r2.images)} reply 前20字=${r2.reply.slice(0, 20)}` : 'null');

  process.chdir(origCwd);
  if (savedEnv === undefined) delete process.env.HELP_IMAGE; else process.env.HELP_IMAGE = savedEnv;
  try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

  // ---------- 3. OneBot 消息段组装 ----------
  console.log('\n--- 3. OneBot 侧：消息段组装 ---');
  const { OneBotAdapter } = require(path.join(DIST, 'platforms', 'onebot.js'));
  const ad = new OneBotAdapter({ onMessage: () => {} });

  const segsOnlyImg = ad.buildSegments({ images: [{ file: 'C:\\path\\to\\help.png' }] });
  check('图片段类型为 image', segsOnlyImg.length === 1 && segsOnlyImg[0].type === 'image');
  check('本地路径补上 file:// 前缀', segsOnlyImg[0].data.file === 'file://C:\\path\\to\\help.png',
    segsOnlyImg[0].data.file);

  const segsHttp = ad.buildSegments({ images: [{ file: 'http://a.com/x.png' }] });
  check('http 地址原样透传', segsHttp[0].data.file === 'http://a.com/x.png', segsHttp[0].data.file);

  const segsMixed = ad.buildSegments({ text: 'hi', images: [{ file: '/tmp/a.png' }] });
  check('图文混排顺序正确', segsMixed.length === 2 && segsMixed[0].type === 'text' && segsMixed[1].type === 'image');

  const segsEmpty = ad.buildSegments({});
  check('空内容返回空数组', segsEmpty.length === 0);

  store.close();
  try { fs.unlinkSync(DB); } catch { /* 忽略 */ }

  console.log('\n========================================');
  console.log(`.help 发图测试: ${pass}/${pass + fail} 通过`);
  console.log(fail === 0 ? '✅ 全部通过' : '❌ 存在失败项');
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
})();
