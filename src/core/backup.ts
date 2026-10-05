/**
 * 自动备份：定时生成数据库快照，并按保留数量清理旧备份。
 */
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';

/**
 * 启动自动备份定时器。
 * @param store 数据层
 * @param backupDir 备份目录
 * @param intervalHours 间隔小时（<=0 表示不启用）
 * @param keep 保留最近 N 份
 * @returns 停止函数
 */
export function startAutoBackup(
  store: Store,
  backupDir: string,
  intervalHours: number,
  keep: number,
): () => void {
  if (intervalHours <= 0) {
    return () => {};
  }
  const doBackup = async (): Promise<void> => {
    try {
      const file = await store.backup(backupDir);
      console.log(`[backup] 已自动备份: ${path.basename(file)}`);
      pruneOldBackups(backupDir, keep);
    } catch (e) {
      console.error(`[backup] 自动备份失败: ${(e as Error).message}`);
    }
  };

  // 启动时先备份一次（若当天还没备份过）
  const existing = store.listBackups(backupDir);
  const today = new Date().toDateString();
  const hasToday = existing.some((b) => new Date(b.mtime).toDateString() === today);
  if (!hasToday) void doBackup();

  const timer = setInterval(() => void doBackup(), intervalHours * 3600 * 1000);
  return () => clearInterval(timer);
}

/** 清理旧备份，仅保留最近 keep 份 */
export function pruneOldBackups(backupDir: string, keep: number): void {
  if (!fs.existsSync(backupDir)) return;
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith('aleabot-backup-') && f.endsWith('.db'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (let i = keep; i < files.length; i++) {
    try {
      fs.unlinkSync(path.join(backupDir, files[i].f));
      console.log(`[backup] 清理旧备份: ${files[i].f}`);
    } catch {
      /* ignore */
    }
  }
}
