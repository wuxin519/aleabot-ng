/**
 * 跑团日志效果演示（不连任何 IM，纯本地模拟一场团）。
 *
 * 用途：
 *   1. 直观验收 .log 系列的记录与导出效果
 *   2. 生成样例文件到 docs/，方便给玩家看「导出长什么样」
 *
 * 运行：node tools/log-demo.js
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const DIST = path.join(__dirname, '..', 'dist');
const { Engine } = require(path.join(DIST, 'core', 'engine.js'));
const { Store } = require(path.join(DIST, 'core', 'store.js'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alea-demo-'));
const store = new Store(path.join(root, 'demo.db'));
const engine = new Engine(store, {
  admins: [],
  backupDir: path.join(root, 'bak'),
  logDir: path.join(root, 'logs'),
});

const GROUP = '123456789';

/** 构造一条群消息（QQ） */
function m(text, who, extra = {}) {
  return {
    platform: 'qq',
    groupId: GROUP,
    userId: who.id,
    userName: who.name,
    text,
    isPrivate: false,
    ...extra,
  };
}

const KO = { id: '10001', name: '木落' };
const WU = { id: '10002', name: '阿雾' };
const YAN = { id: '10003', name: '言' };

/** 一条对话脚本：[消息, 发送者, 额外字段] */
const SCRIPT = [
  ['.log new 调查员之夜', KO],
  ['我们到了那栋老房子门口。', KO],
  ['.r 1d100', KO],                       // 普通掷骰
  ['【旁白】夜色沉沉，雨点打在铁门上。', WU],
  ['.ra 侦查 60', WU],                    // 检定
  ['我要先看看门有没有锁', KO, {                    // 带 @ 与图片
    segments: [
      { type: 'at', targetId: '10002', targetName: '阿雾' },
      { type: 'text', text: ' 你帮我照一下' },
      { type: 'image', file: 'door.png' },
    ],
  }],
  ['（我先去倒杯水，等我一下）', WU],       // 场外
  ['啧，这房子不对劲。', YAN],
  ['.ob', YAN],                           // 言 切观众模式
  ['（我只是路过看看）', YAN],              // 隐藏角色发言
  ['继续，我踹门。', KO],
  ['.r 1d20+3', KO],
  ['.log stat', KO],                      // 看统计
  ['.log end', KO],                       // 结束并导出
];

const outDir = process.env.DEMO_OUT || path.join(__dirname, '..', 'docs');

(async () => {
  console.log('=========== 模拟一场跑团 ===========\n');
  let exported = null;

  for (const [text, who, extra] of SCRIPT) {
    const res = await engine.handle(m(text, who, extra || {}));
    if (!res) continue;
    // 只打印玩家能看到的东西
    const tag = res.files ? '📎' : '💬';
    console.log(`${tag} > ${text}`);
    console.log(indent(res.reply));
    console.log('');
    if (res.files) exported = res;
  }

  if (!exported) {
    console.log('没有产生导出文件');
    return;
  }

  // 落一份样例到 docs/，并把文件名改成固定名字方便引用
  const txtSrc = exported.files[0].path;
  const txtDst = path.join(outDir, '跑团日志样例.txt');
  fs.copyFileSync(txtSrc, txtDst);
  console.log('=========== 导出的 txt 内容 ===========\n');
  console.log(fs.readFileSync(txtDst, 'utf-8'));

  // 再导一份 JSON
  const jsonRes = await engine.handle(m('.log get json', KO));
  const jsonDst = path.join(outDir, '跑团日志样例.json');
  fs.copyFileSync(jsonRes.files[0].path, jsonDst);
  console.log('=========== 导出的 JSON（前 40 行）===========\n');
  console.log(fs.readFileSync(jsonDst, 'utf-8').split('\n').slice(0, 40).join('\n'));

  console.log('\n样例已写入:');
  console.log('  ' + txtDst);
  console.log('  ' + jsonDst);

  store.close();
  fs.rmSync(root, { recursive: true, force: true });
})().catch((e) => {
  console.error('演示失败:', e);
  process.exit(1);
});

function indent(s) {
  return s.split('\n').map((l) => '   ' + l).join('\n');
}
