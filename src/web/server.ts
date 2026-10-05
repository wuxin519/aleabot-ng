/**
 * 网页管理后台（Express）
 *
 * 功能：
 *   GET  /api/status           运行状态（平台连接、统计概览）
 *   GET  /api/logs             掷骰日志（分页/筛选）
 *   GET  /api/sheets           角色卡列表
 *   DELETE /api/sheets/:id     删除角色卡
 *   GET  /api/settings         群配置查询
 *   POST /api/settings         群配置修改
 *   GET  /api/backups          备份列表
 *   POST /api/backups          立即备份
 *   GET  /api/backups/download/:name  下载备份
 *   GET  /api/export           导出 JSON
 *   POST /api/send             向指定群发消息（调试用）
 *
 * 鉴权：可选的简单口令（ADMIN_TOKEN），通过 ?token= 或 X-Admin-Token 头传递。
 */
import express, { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { Store, Platform } from '../core/store';
import { AdapterManager } from '../platforms/manager';

export interface WebServerOptions {
  store: Store;
  manager: AdapterManager;
  backupDir: string;
  port?: number;
  adminToken?: string;
}

export function createWebServer(opts: WebServerOptions): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const adminToken = opts.adminToken || process.env.ADMIN_TOKEN || '';

  // 简单口令鉴权（未配置口令则不校验）
  const auth = (req: Request, res: Response, next: NextFunction): void => {
    if (!adminToken) return next();
    const token = (req.query.token as string) || (req.headers['x-admin-token'] as string) || '';
    if (token === adminToken) return next();
    res.status(401).json({ error: '未授权：请提供正确的管理口令' });
  };

  // ---------- 静态页面 ----------
  const publicDir = path.join(__dirname, '..', '..', 'public');
  app.use(express.static(publicDir));

  // ---------- API ----------

  app.get('/api/status', auth, (_req, res) => {
    const statuses = opts.manager.listStatus();
    const stats = opts.store.stats();
    const backups = opts.store.listBackups(opts.backupDir);
    const lastBackup = backups[0]?.mtime || 0;
    res.json({
      uptime: process.uptime(),
      now: Date.now(),
      platforms: statuses,
      stats,
      lastBackup,
      backupCount: backups.length,
      dbPath: (opts.store as unknown as { dbPath?: string }).dbPath || '',
    });
  });

  app.get('/api/logs', auth, (req, res) => {
    const platform = req.query.platform as Platform | undefined;
    const groupId = req.query.groupId as string | undefined;
    const userId = req.query.userId as string | undefined;
    const keyword = req.query.keyword as string | undefined;
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 500);
    const offset = parseInt((req.query.offset as string) || '0', 10);
    const out = opts.store.queryLogs({ platform, groupId, userId, keyword, limit, offset });
    res.json(out);
  });

  app.get('/api/sheets', auth, (req, res) => {
    const platform = req.query.platform as Platform | undefined;
    const items = opts.store.listSheets(platform).map((s) => {
      let summary = '';
      try {
        const parsed = JSON.parse(s.data) as { attributes?: Record<string, number> };
        const attrs = parsed.attributes || {};
        summary = Object.entries(attrs).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(' ');
      } catch {
        summary = '(解析失败)';
      }
      return { ...s, summary };
    });
    res.json({ items });
  });

  app.delete('/api/sheets/:id', auth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID 无效' });
    opts.store.deleteSheet(id);
    res.json({ ok: true });
  });

  app.get('/api/settings', auth, (req, res) => {
    const platform = (req.query.platform as Platform) || 'qq';
    const groupId = (req.query.groupId as string) || '';
    res.json({ items: opts.store.listSettings(platform, groupId) });
  });

  app.post('/api/settings', auth, (req, res) => {
    const { platform, groupId, key, value } = req.body as {
      platform: Platform; groupId: string; key: string; value: string;
    };
    if (!platform || !groupId || !key) return res.status(400).json({ error: '参数不完整' });
    opts.store.setSetting(platform, groupId, key, String(value ?? ''));
    res.json({ ok: true });
  });

  app.get('/api/backups', auth, (_req, res) => {
    res.json({ items: opts.store.listBackups(opts.backupDir) });
  });

  app.post('/api/backups', auth, async (_req, res) => {
    const file = await opts.store.backup(opts.backupDir);
    res.json({ ok: true, file: path.basename(file) });
  });

  app.get('/api/backups/download/:name', auth, (req, res) => {
    const name = path.basename(req.params.name); // 防目录穿越
    const full = path.join(opts.backupDir, name);
    if (!fs.existsSync(full)) return res.status(404).json({ error: '备份不存在' });
    res.download(full, name);
  });

  app.get('/api/export', auth, (_req, res) => {
    const data = opts.store.exportJSON();
    res.setHeader('Content-Disposition', `attachment; filename="aleabot-export-${Date.now()}.json"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(data, null, 2));
  });

  app.post('/api/send', auth, async (req, res) => {
    const { platform, groupId, text } = req.body as { platform: string; groupId: string; text: string };
    if (!platform || !groupId || !text) return res.status(400).json({ error: '参数不完整' });
    try {
      await opts.manager.send(platform, groupId, text);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ---------- 帮助图片管理 ----------
  /**
   * .help 回复图的存放位置与备份位置。
   *
   * 之所以要 .orig 备份：用户上传新图后想「恢复默认」时，
   * 默认图（渲染产出的指令图）需要有个地方留着，否则一覆盖就找不回来了。
   */
  const helpDir = path.join(publicDir, 'images');
  const helpPath = path.join(publicDir, 'help.png');
  const helpOrigPath = path.join(helpDir, 'help.default.png');
  const HELP_ORIG_URL = '/images/help.default.png';

  const ensureHelpDir = (): void => {
    if (!fs.existsSync(helpDir)) fs.mkdirSync(helpDir, { recursive: true });
  };

  /** 读取 PNG 宽高（只解析 IHDR，不引第三方库） */
  const pngSize = (buf: Buffer): { width: number; height: number } | null => {
    // PNG 签名 8 字节 + 4 字节长度 + "IHDR" + 宽(4) + 高(4)
    if (buf.length < 24) return null;
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  };

  const readHelpInfo = (): Record<string, unknown> => {
    ensureHelpDir();
    // 首次调用时把当前图片存为「默认图」
    if (fs.existsSync(helpPath) && !fs.existsSync(helpOrigPath)) {
      fs.copyFileSync(helpPath, helpOrigPath);
    }
    if (!fs.existsSync(helpPath)) {
      return { exists: false, hasDefault: fs.existsSync(helpOrigPath), url: '' };
    }
    const buf = fs.readFileSync(helpPath);
    const size = pngSize(buf);
    const orig = fs.existsSync(helpOrigPath) ? fs.readFileSync(helpOrigPath) : null;
    const st = fs.statSync(helpPath);
    return {
      exists: true,
      hasDefault: !!orig,
      // 图片的对外访问地址（带时间戳避免浏览器缓存）
      url: `/help.png?v=${st.mtimeMs}`,
      size: st.size,
      width: size?.width || 0,
      height: size?.height || 0,
      mtime: st.mtimeMs,
      isDefault: !!(orig && orig.length === st.size),
      defaultUrl: HELP_ORIG_URL,
    };
  };

  /** 查询当前 .help 图片信息 */
  app.get('/api/help-image', auth, (_req, res) => {
    try {
      res.json(readHelpInfo());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * 上传新的 .help 图片。
   *
   * 前端用 readAsDataURL 把图片转成 data:image/png;base64,xxx 提交，
   * 不用 multipart —— 省掉一个 multer 依赖，且 2MB 的 json 上限够用。
   */
  app.post('/api/help-image', auth, (req, res) => {
    try {
      const { dataUrl } = req.body as { dataUrl?: string };
      if (!dataUrl || !dataUrl.startsWith('data:image/')) {
        return res.status(400).json({ error: '请提供 data:image/... 格式的图片数据' });
      }
      const comma = dataUrl.indexOf(',');
      if (comma < 0) return res.status(400).json({ error: '图片数据格式错误' });

      const header = dataUrl.slice(0, comma);
      const b64 = dataUrl.slice(comma + 1);
      const buf = Buffer.from(b64, 'base64');
      if (buf.length === 0) return res.status(400).json({ error: '图片内容为空' });
      if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: '图片过大（上限 8MB）' });

      // 只接受 PNG：QQ 对非 PNG 的本地文件支持不稳，且我们要读 IHDR 校验
      if (!header.includes('image/png')) {
        return res.status(400).json({ error: '只支持 PNG 格式，请先转换后再上传' });
      }
      const size = pngSize(buf);
      if (!size) return res.status(400).json({ error: '不是合法的 PNG 图片' });

      ensureHelpDir();
      // 首次上传前先把原始默认图留档
      if (fs.existsSync(helpPath) && !fs.existsSync(helpOrigPath)) {
        fs.copyFileSync(helpPath, helpOrigPath);
      }
      fs.writeFileSync(helpPath, buf);
      console.log(`[web] .help 图片已更新: ${size.width}x${size.height}, ${buf.length} bytes`);
      res.json({ ok: true, ...readHelpInfo() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** 恢复默认图 */
  app.post('/api/help-image/reset', auth, (_req, res) => {
    try {
      if (!fs.existsSync(helpOrigPath)) {
        return res.status(404).json({ error: '没有可恢复的默认图（默认图只在首次上传前留档）' });
      }
      fs.copyFileSync(helpOrigPath, helpPath);
      console.log('[web] .help 图片已恢复为默认图');
      res.json({ ok: true, ...readHelpInfo() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return app;
}
