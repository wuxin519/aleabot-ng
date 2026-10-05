/**
 * AleaBot NG 主入口
 *
 * 启动流程：
 *   1. 加载 .env 配置
 *   2. 初始化 SQLite 数据层
 *   3. 创建业务引擎
 *   4. 启动平台适配器（QQ OneBot / KOOK）
 *   5. 启动网页管理后台（Express）
 *   6. 注册定时备份、优雅退出
 */
import 'dotenv/config';
import * as path from 'path';
import { Store } from './core/store';
import { Engine } from './core/engine';
import { AdapterManager } from './platforms/manager';
import { createWebServer } from './web/server';
import { startAutoBackup } from './core/backup';

function envBool(key: string, def = false): boolean {
  const v = (process.env[key] || '').toLowerCase();
  if (!v) return def;
  return v === 'true' || v === '1' || v === 'yes';
}

async function main(): Promise<void> {
  console.log('========================================');
  console.log('  AleaBot NG - TRPG 骰子机器人');
  console.log('  支持 QQ(OneBot) + KOOK 双平台');
  console.log('========================================');

  // 数据路径
  const dataDir = process.env.ALEABOT_DATA_DIR || path.join(process.cwd(), 'data');
  const dbPath = process.env.ALEABOT_DB || path.join(dataDir, 'aleabot.db');
  const backupDir = process.env.ALEABOT_BACKUP_DIR || path.join(dataDir, 'backups');

  // 1. 数据层
  const store = new Store(dbPath);
  console.log(`[store] 数据库: ${dbPath}`);

  // 2. 业务引擎
  const admins = (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const engine = new Engine(store, { admins, backupDir });
  if (admins.length) console.log(`[engine] 管理员: ${admins.join(', ')}`);

  // 3. 平台适配器
  const manager = new AdapterManager(engine);
  await manager.startAll();

  // 4. 网页后台
  const port = parseInt(process.env.WEB_PORT || '8787', 10);
  const webServer = createWebServer({
    store,
    manager,
    backupDir,
    port,
    adminToken: process.env.ADMIN_TOKEN || '',
  });
  const httpServer = webServer.listen(port, () => {
    console.log(`[web] 管理后台已启动: http://0.0.0.0:${port}/`);
    if (process.env.ADMIN_TOKEN) {
      console.log(`[web] 已启用口令保护（通过 ?token=xxx 访问）`);
    }
  });

  // 5. 定时备份
  const backupIntervalHours = parseFloat(process.env.BACKUP_INTERVAL_HOURS || '24');
  const backupKeep = parseInt(process.env.BACKUP_KEEP || '14', 10);
  const stopBackup = startAutoBackup(store, backupDir, backupIntervalHours, backupKeep);
  if (backupIntervalHours > 0) {
    console.log(`[backup] 自动备份已启用: 每 ${backupIntervalHours} 小时，保留 ${backupKeep} 份`);
  }

  // 6. 优雅退出
  const shutdown = async (sig: string): Promise<void> => {
    console.log(`\n[main] 收到 ${sig}，正在退出...`);
    stopBackup();
    try {
      // 退出前做一次备份，防止数据丢失
      const f = await store.backup(backupDir);
      console.log(`[backup] 退出前备份: ${f}`);
    } catch (e) {
      console.error(`[backup] 退出备份失败: ${(e as Error).message}`);
    }
    await manager.stopAll();
    httpServer.close();
    store.close();
    console.log('[main] 已安全退出');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.log('[main] 启动完成，等待消息...');
}

main().catch((e) => {
  console.error('[main] 启动失败:', e);
  process.exit(1);
});
