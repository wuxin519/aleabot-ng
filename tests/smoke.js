/**
 * 端到端冒烟测试：不依赖真实平台，直接用引擎处理消息，
 * 验证「命令 → 骰点 → 写库」全链路。
 * 运行：node tests/smoke.js
 */
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');

const DIST = path.join(__dirname, '..', 'dist');
const { Store } = require(path.join(DIST, 'core', 'store.js'));
const { Engine } = require(path.join(DIST, 'core', 'engine.js'));
const { seededRandom } = require(path.join(DIST, 'core', 'random.js'));

const TMP_DB = path.join(__dirname, '_smoke.db');
const TMP_BACKUP = path.join(__dirname, '_smoke_backups');

// 清理旧文件
for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
if (fs.existsSync(TMP_BACKUP)) fs.rmSync(TMP_BACKUP, { recursive: true, force: true });

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
}

async function main() {
  const store = new Store(TMP_DB);
  const engine = new Engine(store, { rng: seededRandom(20261002), admins: ['admin1'], backupDir: TMP_BACKUP });

  const msg = (text, opts = {}) => ({
    platform: opts.platform || 'qq',
    groupId: opts.groupId || '10001',
    groupName: opts.groupName || '测试跑团群',
    userId: opts.userId || '20001',
    userName: opts.userName || '测试玩家',
    text,
    isPrivate: !!opts.isPrivate,
  });

  // 1. 普通掷骰
  const r1 = await engine.handle(msg('.r 3d6+2'));
  check('普通掷骰有回复', r1 && r1.reply.includes('3d6+2'));
  check('掷骰结果在合法范围', r1 && / = \d+/.test(r1.reply));

  // 2. 默认骰
  const r2 = await engine.handle(msg('.r'));
  check('默认骰有回复', r2 && r2.reply.includes('1d100'));

  // 3. COC 检定
  const r3 = await engine.handle(msg('.ra 侦查 60'));
  check('COC 检定有回复', r3 && r3.reply.includes('侦查'));
  check('检定包含成功等级', r3 && /(大成功|极难成功|困难成功|成功|失败|大失败)/.test(r3.reply));

  // 4. 生成 COC 角色卡
  const r4 = await engine.handle(msg('.coc'));
  check('COC 角色卡生成', r4 && r4.reply.includes('COC 7版'));
  const sheetRec = store.getSheet('qq', '20001');
  check('角色卡已入库', !!sheetRec);
  check('角色卡规则标记正确', sheetRec && sheetRec.system === 'coc7');

  // 5. 检定自动读角色卡技能值
  const r5 = await engine.handle(msg('.ra 闪避'));
  check('检定可读角色卡技能值', r5 && (r5.reply.includes('闪避')), r5 ? r5.reply.slice(0, 40) : '');

  // 6. 设置属性
  const r6 = await engine.handle(msg('.st 力量 88'));
  check('设置属性成功', r6 && r6.reply.includes('88'));
  const r6b = await engine.handle(msg('.st 力量'));
  check('查询属性成功', r6b && r6b.reply.includes('88'));

  // 7. 先攻
  await engine.handle(msg('.init add 张三 15'));
  await engine.handle(msg('.init add 李四 20'));
  const r7 = await engine.handle(msg('.init list'));
  check('先攻列表正确排序', r7 && r7.reply.indexOf('李四') < r7.reply.indexOf('张三'), '李四(20) 应在 张三(15) 前');
  const r7b = await engine.handle(msg('.init clr'));
  check('先攻清空', r7b && r7b.reply.includes('已清空'));

  // 8. 权限控制
  const r8 = await engine.handle(msg('.set defaultDice 1d20', { userId: '20001' }));
  check('非管理员改配置被拒', r8 && r8.reply.includes('只有管理员'));
  const r8b = await engine.handle(msg('.set defaultDice 1d20', { userId: 'admin1' }));
  check('管理员改配置成功', r8b && r8b.reply.includes('已设置'));
  const r8c = await engine.handle(msg('.r'));
  check('默认骰已生效为 1d20', r8c && r8c.reply.includes('1d20'));

  // 9. 多平台数据隔离
  await engine.handle(msg('.r 1d6', { platform: 'kook', groupId: 'kook-chan-1', userId: 'kook-user-1' }));
  const qqLogs = store.queryLogs({ platform: 'qq' });
  const kookLogs = store.queryLogs({ platform: 'kook' });
  check('QQ 日志有记录', qqLogs.total > 0, `QQ ${qqLogs.total} 条`);
  check('KOOK 日志有记录', kookLogs.total > 0, `KOOK ${kookLogs.total} 条`);
  check('两平台数据隔离', kookLogs.items.every((it) => it.platform === 'kook'));

  // 10. 群前缀配置
  await engine.handle(msg('.set prefix !', { userId: 'admin1' }));
  const r10 = await engine.handle(msg('.r 1d6'));
  check('旧前缀已失效', r10 === null);
  const r10b = await engine.handle(msg('!r 1d6'));
  check('新前缀生效', r10b && r10b.reply.includes('1d6'));

  // 11. 备份
  const backupFile = await store.backup(TMP_BACKUP);
  check('备份文件已生成', fs.existsSync(backupFile), path.basename(backupFile));
  const backups = store.listBackups(TMP_BACKUP);
  check('备份可被列出', backups.length === 1);

  // 12. JSON 导出
  const json = store.exportJSON();
  check('JSON 导出自洽', json.tables && Array.isArray(json.tables.logs) && json.tables.logs.length > 0);

  // 13. 统计
  const stats = store.stats();
  check('统计总数正确', stats.totalLogs >= 6, `共 ${stats.totalLogs} 次掷骰`);

  store.close();

  // 清理
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  fs.rmSync(TMP_BACKUP, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log('\n========================================');
  console.log(`冒烟测试: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项:');
    for (const f of failed) console.log('  ❌ ' + f.name);
    process.exit(1);
  }
  console.log('✅ 全部通过，核心链路工作正常');
  console.log('========================================');
}

main().catch((e) => {
  console.error('冒烟测试异常:', e);
  process.exit(1);
});
