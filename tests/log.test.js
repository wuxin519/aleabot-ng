/**
 * 跑团日志（.log 系列 + .ob）专项测试
 * 运行：npm run test:log
 *
 * 覆盖四块：
 *   1. 消息层：CQ 码 / 数组格式解析后 @ 与图片段是否被保留（这是过去做不了功能的根因）
 *   2. 记录器：分类（普通/场外/指令/图片）、符号渲染、ob 角色、开关与暂停止写
 *   3. 会话管理：同群唯一、暂停恢复、结束、删除、权限
 *   4. 导出格式：QQ 风格 txt 的条头正则、主流骰娘 JSON 的字段与时区
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const DIST = path.join(__dirname, '..', 'dist');
const { Engine } = require(path.join(DIST, 'core', 'engine.js'));
const { Store } = require(path.join(DIST, 'core', 'store.js'));
const { parseCommand } = require(path.join(DIST, 'core', 'command.js'));
const recorder = require(path.join(DIST, 'core', 'recorder.js'));
const { OneBotAdapter } = require(path.join(DIST, 'platforms', 'onebot.js'));

// ==================== 脚手架 ====================

let seq = 0;
const tmpRoots = [];

/** 造一个独立环境：临时数据库 + 临时导出目录 */
function makeEnv(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `alea-log-${seq++}-`));
  tmpRoots.push(root);
  const db = path.join(root, 'test.db');
  const store = new Store(db);
  const engine = new Engine(store, {
    admins: opts.admins || [],
    backupDir: path.join(root, 'bak'),
    logDir: path.join(root, 'logs'),
  });
  return { store, engine, db, root, logDir: path.join(root, 'logs') };
}

function cleanupAll() {
  for (const r of tmpRoots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  tmpRoots.length = 0;
}
process.on('exit', cleanupAll);

/** 一条群消息 */
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

/** 读取某会话的全部消息 */
function messages(store, sessionId) {
  return store.listLogMessages(sessionId);
}

/** 从导出结果里读文件内容 */
function readExport(res) {
  assert.ok(res.files && res.files.length === 1, `应产出 1 个文件，实际 ${JSON.stringify(res.files)}`);
  return { text: fs.readFileSync(res.files[0].path, 'utf-8'), name: res.files[0].name, path: res.files[0].path };
}

// ==================== 一、消息层：@ 与图片不再被丢弃 ====================

test('消息层: 数组格式保留 @ 与图片段，text 仍是纯文本', () => {
  const ad = new OneBotAdapter({ onMessage() {} });
  const ev = {
    post_type: 'message',
    message_type: 'group',
    self_id: 3322540068,
    group_id: 88888,
    user_id: 1001,
    sender: { nickname: '测试员' },
    raw_message: '[CQ:at,qq=3322540068] [CQ:image,file=a.png] 我要搜查书架',
    message: [
      { type: 'at', data: { qq: '3322540068', name: '骰娘' } },
      { type: 'text', data: { text: ' ' } },
      { type: 'image', data: { file: 'a.png' } },
      { type: 'text', data: { text: ' 我要搜查书架' } },
    ],
  };
  const m = ad.normalize(ev);
  assert.ok(m, '不应被丢弃');
  // 旧语义不变：text 只含文字
  assert.strictEqual(m.text, '我要搜查书架', `text=${m.text}`);
  // 新能力：段被保留
  assert.strictEqual(m.segments.length, 4);
  assert.strictEqual(m.segments[0].type, 'at');
  assert.strictEqual(m.segments[0].targetId, '3322540068');
  assert.strictEqual(m.segments[0].targetName, '骰娘');
  assert.strictEqual(m.segments[2].type, 'image');
  assert.strictEqual(m.segments[2].file, 'a.png');
  assert.strictEqual(m.mentionsSelf, true, '应识别出 @ 了机器人自己');
});

test('消息层: CQ 字符串格式同样能解析出段', () => {
  const ad = new OneBotAdapter({ onMessage() {} });
  const m = ad.normalize({
    post_type: 'message',
    message_type: 'group',
    self_id: 3322540068,
    group_id: 88888,
    user_id: 1002,
    sender: { nickname: '阿雾' },
    raw_message: '[CQ:face,id=178] 我先走了',
  });
  assert.ok(m);
  assert.strictEqual(m.text, '我先走了');
  assert.strictEqual(m.segments[0].type, 'face');
  assert.strictEqual(m.segments[1].type, 'text');
});

test('消息层: 纯图片消息不再被整条丢掉', () => {
  const ad = new OneBotAdapter({ onMessage() {} });
  const m = ad.normalize({
    post_type: 'message',
    message_type: 'group',
    group_id: 88888,
    user_id: 1003,
    sender: { nickname: '小明' },
    raw_message: '[CQ:image,file=x.jpg]',
  });
  assert.ok(m, '旧实现在这里返回 null，导致日志缺失');
  assert.strictEqual(m.text, '');
  assert.strictEqual(m.segments[0].type, 'image');
  assert.strictEqual(m.mentionsSelf, false, '没 @ 机器人就不该标记');
});

test('消息层: CQ 字符实体正确反转义', () => {
  const ad = new OneBotAdapter({ onMessage() {} });
  const m = ad.normalize({
    post_type: 'message',
    message_type: 'group',
    group_id: 88888,
    user_id: 1004,
    raw_message: '他说&#91;好&#93;&#44;然后走了',
  });
  assert.strictEqual(m.text, '他说[好],然后走了', `text=${m.text}`);
});

test('消息层: 机器人自己发的消息被丢弃（防止日志记两遍）', () => {
  const ad = new OneBotAdapter({ onMessage() {} });
  const m = ad.normalize({
    post_type: 'message',
    message_type: 'group',
    self_id: 3322540068,
    group_id: 88888,
    user_id: 3322540068,
    raw_message: '🎲 1d100 = 42',
  });
  assert.strictEqual(m, null, '自己的消息不应进入引擎');
});

// ==================== 二、记录器：分类与符号 ====================

test('记录器: 图片/表情/@ 渲染成符号', () => {
  const body = recorder.renderLogBody('我要搜查', [
    { type: 'at', targetId: '1002', targetName: '阿雾' },
    { type: 'text', text: ' 我要搜查' },
    { type: 'image', file: 'a.png' },
    { type: 'face' },
  ]);
  assert.strictEqual(body, '@阿雾 我要搜查[图][表情]');
});

test('记录器: @全体成员 单独渲染', () => {
  const body = recorder.renderLogBody('', [{ type: 'at', targetId: 'all' }]);
  assert.strictEqual(body, '@全体成员');
});

test('记录器: 拿不到 @ 的昵称时退回账号', () => {
  const body = recorder.renderLogBody('', [{ type: 'at', targetId: '1002' }]);
  assert.strictEqual(body, '@1002');
});

test('记录器: 分类规则', () => {
  const { classifyMessage } = recorder;
  assert.strictEqual(classifyMessage('.r 3d6'), 'command');
  assert.strictEqual(classifyMessage('。ra 侦查'), 'command');
  assert.strictEqual(classifyMessage('（我先喝口水）'), 'ooc');
  assert.strictEqual(classifyMessage('【旁白】夜色渐深'), 'ooc');
  assert.strictEqual(classifyMessage('我要搜查书架'), 'chat');
  // 省略号不能误判成指令（主流实现的共同处理）
  assert.strictEqual(classifyMessage('...那个'), 'chat');
  assert.strictEqual(classifyMessage('..'), 'chat');
  // 纯图片
  assert.strictEqual(classifyMessage('', [{ type: 'image' }]), 'image');
});

// ==================== 三、会话生命周期 ====================

test('.log new 新建并开始记录', async () => {
  const { store, engine } = makeEnv();
  const r = await engine.handle(msg('.log new 第一次跑团'));
  assert.ok(r.reply.includes('第一次跑团'), r.reply);
  assert.ok(r.reply.includes('开始记录'), r.reply);

  const s = store.getCurrentSession('qq', '88888');
  assert.ok(s, '应存在进行中的会话');
  assert.strictEqual(s.name, '第一次跑团');
  assert.strictEqual(s.status, 'recording');
});

test('同群只能有一个未结束的日志', async () => {
  const { engine } = makeEnv();
  await engine.handle(msg('.log new 第一场'));
  const r = await engine.handle(msg('.log new 第二场'));
  assert.ok(r.reply.includes('已有未结束的日志'), r.reply);
});

test('记录中：普通发言 / 场外 / 指令都能入账', async () => {
  const { store, engine } = makeEnv();
  await engine.handle(msg('.log new 测试场'));
  await engine.handle(msg('我要搜查书架', { userId: '1001', userName: '木落' }));
  await engine.handle(msg('（先喝口水）', { userId: '1002', userName: '阿雾' }));
  await engine.handle(msg('.r 1d6', { userId: '1001', userName: '木落' }));

  const s = store.getCurrentSession('qq', '88888');
  const list = messages(store, s.id);
  const kinds = list.map((m) => m.kind);
  assert.deepStrictEqual(kinds, ['chat', 'ooc', 'command', 'dice'], `实际 ${JSON.stringify(kinds)}`);
  assert.strictEqual(list[0].userName, '木落');
  assert.strictEqual(list[2].isDice, false, '玩家打的指令不是骰子输出');
  assert.strictEqual(list[3].isDice, true, '骰子的回复应标记 isDice');
});

test('.log 控制指令本身不写进日志', async () => {
  const { store, engine } = makeEnv();
  await engine.handle(msg('.log new 测试场'));
  await engine.handle(msg('.log off'));
  await engine.handle(msg('.log on'));
  const s = store.getCurrentSession('qq', '88888');
  assert.strictEqual(messages(store, s.id).length, 0, '控制指令不该出现在日志正文里');
});

test('.log off 暂停后不再记录，.log on 恢复', async () => {
  const { store, engine } = makeEnv();
  await engine.handle(msg('.log new 测试场'));
  await engine.handle(msg('开始前的发言'));
  await engine.handle(msg('.log off'));
  await engine.handle(msg('暂停期间的发言'));
  const s = store.getCurrentSession('qq', '88888');
  assert.strictEqual(s.status, 'paused');
  assert.strictEqual(messages(store, s.id).length, 1);

  await engine.handle(msg('.log on'));
  await engine.handle(msg('恢复后的发言'));
  assert.strictEqual(store.getCurrentSession('qq', '88888').status, 'recording');
  assert.strictEqual(messages(store, s.id).length, 2);
});

test('没有日志时不写库', async () => {
  const { store, engine } = makeEnv();
  // 没有 .log new，发一堆消息
  await engine.handle(msg('路人甲说话'));
  await engine.handle(msg('.r 1d100'));
  assert.strictEqual(store.listLogSessions({ platform: 'qq', groupId: '88888' }).length, 0);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) as c FROM messages').get().c, 0);
});

test('私聊不能建日志', async () => {
  const { engine } = makeEnv();
  const r = await engine.handle(msg('.log new x', { isPrivate: true, groupId: '' }));
  assert.ok(r.reply.includes('只能在群里使用'), r.reply);
});

test('配了 ADMIN_IDS 后只有管理员能建日志', async () => {
  const { engine } = makeEnv({ admins: ['999'] });
  const bad = await engine.handle(msg('.log new x', { userId: '1001' }));
  assert.ok(bad.reply.includes('只有管理员'), bad.reply);
  const ok = await engine.handle(msg('.log new x', { userId: '999' }));
  assert.ok(ok.reply.includes('已新建'), ok.reply);
});

test('未配管理员时不锁死功能（admins 为空即可用）', async () => {
  const { engine } = makeEnv({ admins: [] });
  const r = await engine.handle(msg('.log new x', { userId: '123456' }));
  assert.ok(r.reply.includes('已新建'), r.reply);
});

// ==================== 四、.ob 观众模式 ====================

test('.ob 切换观众模式，发言记为隐藏角色', async () => {
  const { store, engine } = makeEnv();
  await engine.handle(msg('.log new 测试场'));

  const on = await engine.handle(msg('.ob', { userId: '1002' }));
  assert.ok(on.reply.includes('已开启观众模式'), on.reply);

  await engine.handle(msg('我在旁边看着', { userId: '1002', userName: '阿雾' }));
  const s = store.getCurrentSession('qq', '88888');
  const list = messages(store, s.id);
  assert.strictEqual(list[0].role, '隐藏', `role=${list[0].role}`);

  const off = await engine.handle(msg('.ob', { userId: '1002' }));
  assert.ok(off.reply.includes('已关闭观众模式'), off.reply);

  await engine.handle(msg('我加入了', { userId: '1002', userName: '阿雾' }));
  assert.strictEqual(messages(store, s.id)[1].role, '角色');
});

// ==================== 五、导出格式 ====================

test('导出 txt: 条头格式与原版一致（名字(账号) 时间）', async () => {
  const { engine, store } = makeEnv();
  await engine.handle(msg('.log new 导出场'));
  await engine.handle(msg('我要搜查书架', { userId: '1001', userName: '木落' }));
  await engine.handle(msg('（先喝口水）', { userId: '1002', userName: '阿雾' }));
  await engine.handle(msg('.ob', { userId: '1003' }));
  await engine.handle(msg('围观', { userId: '1003', userName: '路人' }));

  const res = await engine.handle(msg('.log end'));
  const { text } = readExport(res);

  // 条头必须能被染色器的正则识别
  const headRe = /^(.+?)\((\d+)\) (\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})$/m;
  assert.ok(headRe.test(text), `找不到合法条头:\n${text}`);
  assert.ok(text.includes('木落(1001)'), '应带账号');
  assert.ok(text.includes('我要搜查书架'));
  assert.ok(text.includes('阿雾(1002)'));
  assert.ok(text.includes('（先喝口水）'), '场外原文保留');
  assert.ok(text.includes('ob路人(1003)'), `隐藏角色应带 ob 前缀:\n${text}`);
});

test('导出 JSON: 主流骰娘格式必需字段齐备（isDice / message）', async () => {
  const { engine } = makeEnv();
  await engine.handle(msg('.log new 导出场'));
  await engine.handle(msg('我要搜查书架', { userId: '1001', userName: '木落' }));
  await engine.handle(msg('.r 1d100', { userId: '1001', userName: '木落' }));

  const res = await engine.handle(msg('.log get json'));
  const { text, name } = readExport(res);
  assert.ok(name.endsWith('.json'), `文件名 ${name}`);

  const data = JSON.parse(text);
  assert.ok(Array.isArray(data.items) && data.items.length > 0);
  const keys = Object.keys(data.items[0]);
  assert.ok(keys.includes('isDice') && keys.includes('message'), '染色器靠这两个键识别格式');
  assert.strictEqual(data.version, 1);
  assert.strictEqual(data.items[0].IMUserId, '1001');
  assert.strictEqual(data.items[0].nickname, '木落');

  // time 必须是**秒**，用毫秒会导致染色器时间跳到 5 万年以后
  const nowSec = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(data.items[0].time - nowSec) < 300, `time 应为秒，实际 ${data.items[0].time}`);
});

test('.log get 在结束后仍可导出最后一场', async () => {
  const { engine } = makeEnv();
  await engine.handle(msg('.log new 已结束场'));
  await engine.handle(msg('一句话'));
  await engine.handle(msg('.log end'));
  const res = await engine.handle(msg('.log get'));
  const { text } = readExport(res);
  assert.ok(text.includes('一句话'), text);
});

test('空日志导出会给出明确提示而不是空文件', async () => {
  const { engine } = makeEnv();
  await engine.handle(msg('.log new 空场'));
  const res = await engine.handle(msg('.log end'));
  assert.ok(!res.files, '不该产出空文件');
  assert.ok(res.reply.includes('没有任何记录'), res.reply);
});

test('.log get <编号> 可导出指定历史日志', async () => {
  const { engine, store } = makeEnv();
  await engine.handle(msg('.log new 第一场'));
  await engine.handle(msg('第一场的内容'));
  const end1 = await engine.handle(msg('.log end'));
  const id1 = Number(/\(#(\d+)\)/.exec(end1.reply)[1]);

  await engine.handle(msg('.log new 第二场'));
  const res = await engine.handle(msg(`.log get ${id1}`));
  const { text } = readExport(res);
  assert.strictEqual(store.getLogSession(id1).name, '第一场');
  assert.ok(text.includes('第一场的内容'), text);
});

// ==================== 六、列表 / 统计 / 删除 ====================

test('.log list 列出本群日志', async () => {
  const { engine } = makeEnv();
  await engine.handle(msg('.log new 甲场'));
  await engine.handle(msg('.log end'));
  await engine.handle(msg('.log new 乙场'));
  const r = await engine.handle(msg('.log list'));
  assert.ok(r.reply.includes('甲场'), r.reply);
  assert.ok(r.reply.includes('乙场'), r.reply);
  assert.ok(r.reply.includes('已结束'), r.reply);
});

test('.log stat 统计性质分布', async () => {
  const { engine } = makeEnv();
  await engine.handle(msg('.log new 统计场'));
  await engine.handle(msg('普通一句'));
  await engine.handle(msg('（场外一句）'));
  await engine.handle(msg('.log stat'), {});
  const r = await engine.handle(msg('.log stat'));
  assert.ok(r.reply.includes('普通发言 1'), r.reply);
  assert.ok(r.reply.includes('场外 1'), r.reply);
});

test('.log del 删除会话及其消息', async () => {
  const { store, engine } = makeEnv();
  await engine.handle(msg('.log new 待删场'));
  await engine.handle(msg('会被一起删掉'));
  const s = store.getCurrentSession('qq', '88888');
  const r = await engine.handle(msg('.log del'));
  assert.ok(r.reply.includes('已删除'), r.reply);
  assert.strictEqual(store.getLogSession(s.id), undefined);
  assert.strictEqual(store.countLogMessages(s.id), 0, '消息应被级联删除');
});

// ==================== 七、指令解析 ====================

test('无空格别名 .lognew/.logon/.logoff/.logend 均可解析', () => {
  const cases = {
    '.lognew x': 'log-new',
    '.logon': 'log-on',
    '.logoff': 'log-off',
    '.logend': 'log-end',
    '.loglist': 'log-list',
    '.logget': 'log-get',
    '.logdel': 'log-del',
    '.logstat': 'log-stat',
    '.log': 'log-status',
    '.log new x': 'log-new',
    '.log on': 'log-on',
    '.log off': 'log-off',
    '.log end': 'log-end',
    '.ob': 'ob',
  };
  for (const [input, expect] of Object.entries(cases)) {
    const c = parseCommand(input);
    assert.ok(c, `${input} 应能解析`);
    assert.strictEqual(c.type, expect, `${input} → ${c.type}，期望 ${expect}`);
  }
});

test('.log new 名称里的空格被完整保留', () => {
  const c = parseCommand('.log new 第一次 跑团 记录');
  assert.strictEqual(c.type, 'log-new');
  assert.deepStrictEqual(c.args, ['第一次', '跑团', '记录']);
});

// ==================== 八、数据层细节 ====================

test('getRecordingSession 在暂停时返回 undefined（唯一热路径判断）', async () => {
  const { store, engine } = makeEnv();
  await engine.handle(msg('.log new 场'));
  assert.ok(store.getRecordingSession('qq', '88888'), '记录中应有值');
  await engine.handle(msg('.log off'));
  assert.strictEqual(store.getRecordingSession('qq', '88888'), undefined, '暂停后必须返回 undefined，避免继续写库');
  assert.ok(store.getCurrentSession('qq', '88888'), '但当前会话仍然存在');
});

test('跨群隔离：A 群的日志不会记到 B 群', async () => {
  const { store, engine } = makeEnv();
  await engine.handle(msg('.log new A群场', { groupId: '111' }));
  await engine.handle(msg('A群的话', { groupId: '111' }));
  await engine.handle(msg('B群的闲话', { groupId: '222' }));

  const a = store.getCurrentSession('qq', '111');
  const b = store.getCurrentSession('qq', '222');
  assert.strictEqual(b, undefined, 'B 群没开日志');
  assert.strictEqual(messages(store, a.id).length, 1);
  assert.strictEqual(messages(store, a.id)[0].body, 'A群的话');
});

test('长正文（含换行）能完整存取', async () => {
  const { store, engine } = makeEnv();
  await engine.handle(msg('.log new 场'));
  const long = '第一行\n第二行\n第三行（带括号）';
  await engine.handle(msg(long));
  const s = store.getCurrentSession('qq', '88888');
  assert.strictEqual(messages(store, s.id)[0].body, long);
});
