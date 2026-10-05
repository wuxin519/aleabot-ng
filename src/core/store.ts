/**
 * 数据层：基于 better-sqlite3 的同步持久化。
 * 数据库文件默认 data/aleabot.db，可用环境变量 ALEABOT_DB 覆盖。
 *
 * 表结构：
 *   sheets      角色卡（按 platform+user_id 唯一）
 *   bindings    群与用户绑定关系（可扩展）
 *   settings    群级配置（键值对）
 *   initiative  先攻列表（按 platform+group_id）
 *   logs        掷骰日志（主表）
 *   log_lines   日志明细（骰子组/结果，与 logs 一对多）
 *   log_sessions 跑团日志会话（.lognew 系列，同群同时只有一个进行中）
 *   messages    跑团日志正文（全量群消息，含对话/骰点/场外/图片）
 *   meta        元信息（版本号、备份时间等）
 *
 * 所有查询以 (platform, group_id, user_id) 三元组隔离，
 * 保证多平台（QQ/KOOK）数据互不串扰。
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

/** 平台标识 */
export type Platform = 'qq' | 'kook';

/** 掷骰日志条目 */
export interface LogEntry {
  id?: number;
  platform: Platform;
  groupId: string;
  groupName?: string;
  userId: string;
  userName?: string;
  expression: string;
  total: number;
  detail: string;
  createdAt: number;
}

/** 先攻项 */
export interface InitiativeItem {
  id?: number;
  platform: Platform;
  groupId: string;
  name: string;
  value: number;
  createdAt: number;
}

/** 角色卡记录 */
export interface SheetRecord {
  id?: number;
  platform: Platform;
  userId: string;
  userName?: string;
  system: string;
  data: string; // JSON 字符串
  /** 角色卡标题（多卡切换用，如「调查员A」）；旧数据为 null，按「默认」处理 */
  title?: string | null;
  updatedAt: number;
}

/**
 * 跑团日志会话。
 *
 * 一个群同时只允许一个「进行中」的日志（recording/paused），
 * 这是主流骰娘 / Dice! 的共同约定 —— 否则记录会互相污染。
 */
export interface LogSession {
  id: number;
  platform: Platform;
  groupId: string;
  groupName?: string;
  /** 日志名（玩家可读） */
  name: string;
  /** recording 记录中 / paused 已暂停 / ended 已结束 */
  status: 'recording' | 'paused' | 'ended';
  /** 创建者 ID */
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  /** 附带的消息条数（列表查询时填充） */
  messageCount?: number;
}

/**
 * 跑团日志中的一条消息。
 *
 * `body` 是**带符号的正文**（@名字 / [图] / [表情]），
 * `kind` 是按符号规则判定的性质，染色器靠它做「一键剔除场外」。
 */
export interface LogMessageRecord {
  id?: number;
  sessionId: number;
  platform: Platform;
  groupId: string;
  userId: string;
  userName?: string;
  /** chat 普通发言 / dice 骰子输出 / ooc 场外 / command 指令 / image 纯图片 */
  kind: string;
  /** 正文（已带符号） */
  body: string;
  /** 是不是骰子自己说的（主流骰娘的 isDice 语义） */
  isDice: boolean;
  /** 角色：角色 / 主持人 / 骰子 / 隐藏 */
  role?: string;
  messageId?: string;
  createdAt: number;
}

/** 掷骰统计聚合结果 */
export interface RollStats {  /** 掷骰总次数 */
  count: number;
  /** 参与人数 */
  users: number;
  /** 平均值 */
  avg: number;
  /** 最大值 */
  max: number;
  /** 最小值 */
  min: number;
  /** 掷骰最多的前 5 位用户 */
  topUsers: Array<{ userId: string; userName: string; count: number }>;
  /** 百分骰（1d100 / .ra）的分布统计 */
  d100: {
    count: number;
    /** 大成功次数（出目 1） */
    crits: number;
    /** 大失败次数（出目 ≥96） */
    fumbles: number;
    /** 5 个等宽分段的次数：1-20 / 21-40 / 41-60 / 61-80 / 81-100 */
    buckets: number[];
  };
  /** 最近若干条记录 */
  recent: LogEntry[];
}

export class Store {
  public readonly db: Database.Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || process.env.ALEABOT_DB || path.join(process.cwd(), 'data', 'aleabot.db');
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(this.dbPath);
    // WAL 提升并发读写；busy_timeout 避免多连接/备份时 SQLITE_BUSY
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  /** 建表 */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sheets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT,
        system TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, user_id)
      );

      CREATE TABLE IF NOT EXISTS bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(platform, group_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        group_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, group_id, key)
      );

      CREATE TABLE IF NOT EXISTS initiative (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        group_id TEXT NOT NULL,
        name TEXT NOT NULL,
        value INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        group_id TEXT NOT NULL,
        group_name TEXT,
        user_id TEXT NOT NULL,
        user_name TEXT,
        expression TEXT NOT NULL,
        total INTEGER NOT NULL,
        detail TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS log_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_id INTEGER NOT NULL,
        raw TEXT NOT NULL,
        rolls TEXT,
        kept TEXT,
        subtotal INTEGER,
        FOREIGN KEY(log_id) REFERENCES logs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      /* ---------- 当前角色卡指针（多卡切换） ---------- */
      CREATE TABLE IF NOT EXISTS current_sheet (
        platform TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        PRIMARY KEY (platform, user_id)
      );

      /* ---------- 跑团日志（.lognew 系列） ---------- */
      CREATE TABLE IF NOT EXISTS log_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        group_id TEXT NOT NULL,
        group_name TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        platform TEXT NOT NULL,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        is_dice INTEGER NOT NULL DEFAULT 0,
        role TEXT,
        message_id TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES log_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_logs_platform_group ON logs(platform, group_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(platform, user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_initiative_group ON initiative(platform, group_id, value DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_group ON log_sessions(platform, group_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
    `);

    // 多角色卡：把 sheets 升级为 (platform, user_id, title) 唯一，并补 title 列。
    // 旧库（UNIQUE(platform,user_id)）无法用 ALTER 改唯一约束，只能重建表。
    this.migrateSheetsMulti();

    // 写入 schema 版本
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined;
    if (!row) {
      this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('schema_version', '1');
      this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('created_at', String(Date.now()));
    }
  }

  /**
   * 把 sheets 表升级成多卡结构：
   *   - 增加 title 列（旧数据统一回填 '默认'）
   *   - 唯一约束从 (platform, user_id) 放宽为 (platform, user_id, title)
   * 幂等：已是目标结构则直接返回。
   */
  private migrateSheetsMulti(): void {
    const cols = this.db.prepare('PRAGMA table_info(sheets)').all() as Array<{ name: string }>;
    const hasTitle = cols.some((c) => c.name === 'title');
    if (hasTitle) return;

    this.db.exec(`
      CREATE TABLE sheets_multi (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT,
        system TEXT NOT NULL,
        data TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '默认',
        updated_at INTEGER NOT NULL,
        UNIQUE(platform, user_id, title)
      );
      INSERT INTO sheets_multi (id, platform, user_id, user_name, system, data, title, updated_at)
        SELECT id, platform, user_id, user_name, system, data,
               COALESCE(json_extract(data, '$.title'), '默认'), updated_at
        FROM sheets;
      DROP TABLE sheets;
      ALTER TABLE sheets_multi RENAME TO sheets;
      CREATE INDEX IF NOT EXISTS idx_sheets_user ON sheets(platform, user_id, updated_at DESC);
    `);
  }

  // ---------- 群配置 ----------

  getSetting(platform: Platform, groupId: string, key: string, fallback?: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE platform=? AND group_id=? AND key=?')
      .get(platform, groupId, key) as { value: string } | undefined;
    return row ? row.value : fallback;
  }

  setSetting(platform: Platform, groupId: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings(platform, group_id, key, value, updated_at, id)
         VALUES(?, ?, ?, ?, ?, NULL)
         ON CONFLICT(platform, group_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .run(platform, groupId, key, value, Date.now());
  }

  listSettings(platform: Platform, groupId: string): Array<{ key: string; value: string }> {
    return this.db
      .prepare('SELECT key, value FROM settings WHERE platform=? AND group_id=? ORDER BY key')
      .all(platform, groupId) as Array<{ key: string; value: string }>;
  }

  // ---------- 掷骰日志 ----------

  /** 写入一条掷骰日志（含明细） */
  addLog(entry: LogEntry & { lines?: Array<{ raw: string; rolls: number[]; kept: number[]; subtotal: number }> }): number {
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO logs(platform, group_id, group_name, user_id, user_name, expression, total, detail, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.platform, entry.groupId, entry.groupName || null, entry.userId,
          entry.userName || null, entry.expression, entry.total, entry.detail, entry.createdAt,
        );
      const logId = Number(info.lastInsertRowid);
      if (entry.lines) {
        const stmt = this.db.prepare(
          'INSERT INTO log_lines(log_id, raw, rolls, kept, subtotal) VALUES(?, ?, ?, ?, ?)',
        );
        for (const ln of entry.lines) {
          stmt.run(logId, ln.raw, JSON.stringify(ln.rolls), JSON.stringify(ln.kept), ln.subtotal);
        }
      }
      return logId;
    });
    return tx();
  }

  /** 查询日志（分页 + 平台过滤） */
  queryLogs(opts: { platform?: Platform; groupId?: string; userId?: string; keyword?: string; limit?: number; offset?: number }): {
    total: number;
    items: LogEntry[];
  } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.platform) { where.push('platform=?'); params.push(opts.platform); }
    if (opts.groupId) { where.push('group_id=?'); params.push(opts.groupId); }
    if (opts.userId) { where.push('user_id=?'); params.push(opts.userId); }
    if (opts.keyword) { where.push('(expression LIKE ? OR detail LIKE ? OR user_name LIKE ?)'); params.push(`%${opts.keyword}%`, `%${opts.keyword}%`, `%${opts.keyword}%`); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = (this.db.prepare(`SELECT COUNT(*) as c FROM logs ${whereSql}`).get(...params) as { c: number }).c;
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const items = this.db
      .prepare(`SELECT id, platform, group_id as groupId, group_name as groupName, user_id as userId, user_name as userName, expression, total, detail, created_at as createdAt FROM logs ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as LogEntry[];
    return { total, items };
  }

  /** 日志统计概览 */
  stats(): { totalLogs: number; totalGroups: number; totalUsers: number; byPlatform: Record<string, number> } {
    const totalLogs = (this.db.prepare('SELECT COUNT(*) as c FROM logs').get() as { c: number }).c;
    const totalGroups = (this.db.prepare("SELECT COUNT(DISTINCT platform || ':' || group_id) as c FROM logs").get() as { c: number }).c;
    const totalUsers = (this.db.prepare("SELECT COUNT(DISTINCT platform || ':' || user_id) as c FROM logs").get() as { c: number }).c;
    const byPlatform: Record<string, number> = {};
    const rows = this.db.prepare('SELECT platform, COUNT(*) as c FROM logs GROUP BY platform').all() as Array<{ platform: string; c: number }>;
    for (const r of rows) byPlatform[r.platform] = r.c;
    return { totalLogs, totalGroups, totalUsers, byPlatform };
  }

  // ---------- 掷骰统计（.stat / .hiy） ----------

  /**
   * 聚合掷骰统计。
   *
   * 之所以放在数据层而不是引擎里「先查日志再算」，是因为掷骰日志可能上万条，
   * 全部取回内存再统计会明显变慢；用 SQL 的 COUNT/AVG/SUM 直接出结果更快。
   */
  rollStats(opts: {
    platform?: Platform;
    groupId?: string;
    userId?: string;
    /** 起始时间戳（用于「今日」统计） */
    since?: number;
    limitRecent?: number;
  }): RollStats {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.platform) { where.push('platform=?'); params.push(opts.platform); }
    if (opts.groupId) { where.push('group_id=?'); params.push(opts.groupId); }
    if (opts.userId) { where.push('user_id=?'); params.push(opts.userId); }
    if (opts.since) { where.push('created_at>=?'); params.push(opts.since); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const agg = this.db
      .prepare(
        `SELECT COUNT(*) as count,
                COUNT(DISTINCT user_id) as users,
                AVG(total) as avg,
                MAX(total) as max,
                MIN(total) as min
         FROM logs ${whereSql}`,
      )
      .get(...params) as {
      count: number;
      users: number;
      avg: number | null;
      max: number | null;
      min: number | null;
    };

    const topUsers = this.db
      .prepare(
        `SELECT user_id as userId, COALESCE(user_name, user_id) as userName, COUNT(*) as count
         FROM logs ${whereSql}
         GROUP BY user_id ORDER BY count DESC LIMIT 5`,
      )
      .all(...params) as Array<{ userId: string; userName: string; count: number }>;

    // 百分骰分布：只统计 1d100 类掷骰（含 .ra 检定，其 expression 形如 "ra 侦查 60"）
    const d100Extra = "(expression LIKE '%d100%' OR expression LIKE 'ra %')";
    const d100Sql = where.length ? `${whereSql} AND ${d100Extra}` : `WHERE ${d100Extra}`;
    const d100Row = this.db
      .prepare(
        `SELECT COUNT(*) as count,
                COALESCE(SUM(CASE WHEN total=1 THEN 1 ELSE 0 END), 0) as crits,
                COALESCE(SUM(CASE WHEN total>=96 THEN 1 ELSE 0 END), 0) as fumbles,
                COALESCE(SUM(CASE WHEN total BETWEEN 1  AND 20 THEN 1 ELSE 0 END), 0) as b1,
                COALESCE(SUM(CASE WHEN total BETWEEN 21 AND 40 THEN 1 ELSE 0 END), 0) as b2,
                COALESCE(SUM(CASE WHEN total BETWEEN 41 AND 60 THEN 1 ELSE 0 END), 0) as b3,
                COALESCE(SUM(CASE WHEN total BETWEEN 61 AND 80 THEN 1 ELSE 0 END), 0) as b4,
                COALESCE(SUM(CASE WHEN total BETWEEN 81 AND 100 THEN 1 ELSE 0 END), 0) as b5
         FROM logs ${d100Sql}`,
      )
      .get(...params) as {
      count: number; crits: number; fumbles: number;
      b1: number; b2: number; b3: number; b4: number; b5: number;
    };

    const recent = this.db
      .prepare(
        `SELECT id, platform, group_id as groupId, group_name as groupName,
                user_id as userId, user_name as userName, expression, total, detail,
                created_at as createdAt
         FROM logs ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params, opts.limitRecent ?? 5) as LogEntry[];

    return {
      count: agg.count,
      users: agg.users,
      avg: agg.avg ?? 0,
      max: agg.max ?? 0,
      min: agg.min ?? 0,
      topUsers,
      d100: {
        count: d100Row.count,
        crits: d100Row.crits,
        fumbles: d100Row.fumbles,
        buckets: [d100Row.b1, d100Row.b2, d100Row.b3, d100Row.b4, d100Row.b5],
      },
      recent,
    };
  }

  // ---------- 先攻 ----------

  addInitiative(item: Omit<InitiativeItem, 'id'>): number {
    // 同名覆盖
    this.db.prepare('DELETE FROM initiative WHERE platform=? AND group_id=? AND name=?')
      .run(item.platform, item.groupId, item.name);
    const info = this.db
      .prepare('INSERT INTO initiative(platform, group_id, name, value, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(item.platform, item.groupId, item.name, item.value, item.createdAt);
    return Number(info.lastInsertRowid);
  }

  listInitiative(platform: Platform, groupId: string): InitiativeItem[] {
    return this.db
      .prepare('SELECT id, platform, group_id as groupId, name, value, created_at as createdAt FROM initiative WHERE platform=? AND group_id=? ORDER BY value DESC, id ASC')
      .all(platform, groupId) as InitiativeItem[];
  }

  clearInitiative(platform: Platform, groupId: string): void {
    this.db.prepare('DELETE FROM initiative WHERE platform=? AND group_id=?').run(platform, groupId);
  }

  // ---------- 角色卡（支持多卡 + 当前卡指针） ----------

  private static readonly SHEET_COLS =
    'id, platform, user_id as userId, user_name as userName, system, data, title, updated_at as updatedAt';

  /**
   * 读取角色卡。
   * - 传 title：精确读那张卡
   * - 不传 title：读「当前卡」（current_sheet 指针）；无指针时取最近更新的一张
   */
  getSheet(platform: Platform, userId: string, title?: string): SheetRecord | undefined {
    if (title) {
      return this.db
        .prepare(`SELECT ${Store.SHEET_COLS} FROM sheets WHERE platform=? AND user_id=? AND title=?`)
        .get(platform, userId, title) as SheetRecord | undefined;
    }
    const cur = this.getCurrentTitle(platform, userId);
    if (cur) {
      const hit = this.db
        .prepare(`SELECT ${Store.SHEET_COLS} FROM sheets WHERE platform=? AND user_id=? AND title=?`)
        .get(platform, userId, cur) as SheetRecord | undefined;
      if (hit) return hit;
    }
    return this.db
      .prepare(`SELECT ${Store.SHEET_COLS} FROM sheets WHERE platform=? AND user_id=? ORDER BY updated_at DESC LIMIT 1`)
      .get(platform, userId) as SheetRecord | undefined;
  }

  /** 保存角色卡（同一 platform+user+title 视为同一张卡） */
  saveSheet(rec: Omit<SheetRecord, 'id'>): void {
    const title = rec.title || '默认';
    this.db
      .prepare(
        `INSERT INTO sheets(platform, user_id, user_name, system, data, title, updated_at, id)
         VALUES(?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(platform, user_id, title) DO UPDATE SET
           user_name=excluded.user_name, system=excluded.system,
           data=excluded.data, updated_at=excluded.updated_at`,
      )
      .run(rec.platform, rec.userId, rec.userName || null, rec.system, rec.data, title, rec.updatedAt);
  }

  /** 某个玩家的全部角色卡（按更新时间倒序） */
  listSheets(platform?: Platform, userId?: string): SheetRecord[] {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (platform) {
      conds.push('platform=?');
      params.push(platform);
    }
    if (userId) {
      conds.push('user_id=?');
      params.push(userId);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT ${Store.SHEET_COLS} FROM sheets ${where} ORDER BY user_id ASC, updated_at DESC`,
      )
      .all(...params) as SheetRecord[];
  }

  /** 按标题删除某张卡；返回是否删掉了 */
  deleteSheetByTitle(platform: Platform, userId: string, title: string): boolean {
    const info = this.db
      .prepare('DELETE FROM sheets WHERE platform=? AND user_id=? AND title=?')
      .run(platform, userId, title);
    // 若删掉的正是当前卡，清掉指针（下次读取会回落到最近更新的一张）
    if (this.getCurrentTitle(platform, userId) === title) {
      this.clearCurrentTitle(platform, userId);
    }
    return info.changes > 0;
  }

  deleteSheet(id: number): void {
    this.db.prepare('DELETE FROM sheets WHERE id=?').run(id);
  }

  // ---------- 当前角色卡指针 ----------

  getCurrentTitle(platform: Platform, userId: string): string | undefined {
    const row = this.db
      .prepare('SELECT title FROM current_sheet WHERE platform=? AND user_id=?')
      .get(platform, userId) as { title: string } | undefined;
    return row?.title;
  }

  setCurrentTitle(platform: Platform, userId: string, title: string): void {
    this.db
      .prepare(
        `INSERT INTO current_sheet(platform, user_id, title) VALUES(?, ?, ?)
         ON CONFLICT(platform, user_id) DO UPDATE SET title=excluded.title`,
      )
      .run(platform, userId, title);
  }

  clearCurrentTitle(platform: Platform, userId: string): void {
    this.db.prepare('DELETE FROM current_sheet WHERE platform=? AND user_id=?').run(platform, userId);
  }

  // ---------- 跑团日志会话 ----------

  private mapSession(row: Record<string, unknown>): LogSession {
    return {
      id: Number(row.id),
      platform: row.platform as Platform,
      groupId: String(row.groupId ?? row.group_id ?? ''),
      groupName: (row.groupName ?? row.group_name) as string | undefined,
      name: String(row.name ?? ''),
      status: row.status as LogSession['status'],
      createdBy: (row.createdBy ?? row.created_by) as string | undefined,
      createdAt: Number(row.createdAt ?? row.created_at ?? 0),
      updatedAt: Number(row.updatedAt ?? row.updated_at ?? 0),
      endedAt: (row.endedAt ?? row.ended_at) as number | undefined,
      messageCount: row.messageCount !== undefined ? Number(row.messageCount) : undefined,
    };
  }

  private readonly sessionCols = `id, platform, group_id as groupId, group_name as groupName, name, status,
           created_by as createdBy, created_at as createdAt, updated_at as updatedAt, ended_at as endedAt`;

  /** 同上，但带表别名 s.（联表查条数时用） */
  private readonly sessionColsS = `s.id, s.platform, s.group_id as groupId, s.group_name as groupName, s.name, s.status,
           s.created_by as createdBy, s.created_at as createdAt, s.updated_at as updatedAt, s.ended_at as endedAt`;

  /** 新建一个日志会话（调用方需先确保该群没有进行中的会话） */
  createLogSession(opts: {
    platform: Platform;
    groupId: string;
    groupName?: string;
    name: string;
    createdBy?: string;
  }): number {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO log_sessions(platform, group_id, group_name, name, status, created_by, created_at, updated_at)
         VALUES(?, ?, ?, ?, 'recording', ?, ?, ?)`,
      )
      .run(opts.platform, opts.groupId, opts.groupName || null, opts.name, opts.createdBy || null, now, now);
    return Number(info.lastInsertRowid);
  }

  /** 取该群「当前日志」：最近一个未结束（recording / paused）的会话 */
  getCurrentSession(platform: Platform, groupId: string): LogSession | undefined {
    const row = this.db
      .prepare(
        `SELECT ${this.sessionCols} FROM log_sessions
         WHERE platform=? AND group_id=? AND status IN ('recording','paused')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(platform, groupId) as Record<string, unknown> | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  /**
   * 取该群「正在记录」的会话。
   *
   * ⚠️ 这是每条群消息都会调用的热路径：没有日志的群必须立刻返回 undefined，
   * 否则等于给群聊加了一次无谓的数据库查询。
   */
  getRecordingSession(platform: Platform, groupId: string): LogSession | undefined {
    const row = this.db
      .prepare(
        `SELECT ${this.sessionCols} FROM log_sessions
         WHERE platform=? AND group_id=? AND status='recording' ORDER BY id DESC LIMIT 1`,
      )
      .get(platform, groupId) as Record<string, unknown> | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  getLogSession(id: number): LogSession | undefined {
    const row = this.db
      .prepare(`SELECT ${this.sessionCols} FROM log_sessions WHERE id=?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  /** 把会话状态改为 recording / paused / ended；ended 时记录结束时间 */
  setLogSessionStatus(id: number, status: LogSession['status']): void {
    const now = Date.now();
    if (status === 'ended') {
      this.db.prepare('UPDATE log_sessions SET status=?, updated_at=?, ended_at=? WHERE id=?').run(status, now, now, id);
    } else {
      this.db.prepare('UPDATE log_sessions SET status=?, updated_at=?, ended_at=NULL WHERE id=?').run(status, now, id);
    }
  }

  /** 列出日志会话（可选按群过滤），附带消息条数 */
  listLogSessions(opts: { platform?: Platform; groupId?: string; limit?: number } = {}): LogSession[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.platform) { where.push('s.platform=?'); params.push(opts.platform); }
    if (opts.groupId) { where.push('s.group_id=?'); params.push(opts.groupId); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = this.db
      .prepare(
        `SELECT ${this.sessionColsS},
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as messageCount
         FROM log_sessions s ${whereSql} ORDER BY s.id DESC LIMIT ?`,
      )
      .all(...params, opts.limit ?? 20) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapSession(r));
  }

  /** 删除会话（消息由外键级联删除） */
  deleteLogSession(id: number): void {
    // 显式删一次 messages，防止某些环境未启用外键级联
    this.db.prepare('DELETE FROM messages WHERE session_id=?').run(id);
    this.db.prepare('DELETE FROM log_sessions WHERE id=?').run(id);
  }

  // ---------- 跑团日志正文 ----------

  addLogMessage(rec: LogMessageRecord): number {
    const info = this.db
      .prepare(
        `INSERT INTO messages(session_id, platform, group_id, user_id, user_name, kind, body, is_dice, role, message_id, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.sessionId, rec.platform, rec.groupId, rec.userId, rec.userName || null,
        rec.kind, rec.body, rec.isDice ? 1 : 0, rec.role || null,
        rec.messageId || null, rec.createdAt,
      );
    return Number(info.lastInsertRowid);
  }

  listLogMessages(sessionId: number, opts: { limit?: number; offset?: number } = {}): LogMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id as sessionId, platform, group_id as groupId, user_id as userId,
                user_name as userName, kind, body, is_dice as isDice, role, message_id as messageId,
                created_at as createdAt
         FROM messages WHERE session_id=? ORDER BY id ASC LIMIT ? OFFSET ?`,
      )
      .all(sessionId, opts.limit ?? 100000, opts.offset ?? 0) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      sessionId: Number(r.sessionId),
      platform: r.platform as Platform,
      groupId: String(r.groupId),
      userId: String(r.userId),
      userName: r.userName as string | undefined,
      kind: String(r.kind),
      body: String(r.body),
      isDice: Number(r.isDice) === 1,
      role: r.role as string | undefined,
      messageId: r.messageId as string | undefined,
      createdAt: Number(r.createdAt),
    }));
  }

  countLogMessages(sessionId: number): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id=?').get(sessionId) as { c: number }).c;
  }

  /** 会话内消息性质分布（.log stat 用） */
  logMessageStats(sessionId: number): { total: number; byKind: Record<string, number>; speakers: number; firstAt: number; lastAt: number } {
    const total = this.countLogMessages(sessionId);
    const byKind: Record<string, number> = {};
    const rows = this.db
      .prepare('SELECT kind, COUNT(*) as c FROM messages WHERE session_id=? GROUP BY kind')
      .all(sessionId) as Array<{ kind: string; c: number }>;
    for (const r of rows) byKind[r.kind] = r.c;
    const agg = this.db
      .prepare(
        // 参与人数只统计真人（骰子输出的 user_id 是 'bot'，不该算进人数）
        `SELECT COUNT(DISTINCT CASE WHEN is_dice=0 THEN user_id END) as speakers,
                MIN(created_at) as firstAt, MAX(created_at) as lastAt
         FROM messages WHERE session_id=?`,
      )
      .get(sessionId) as { speakers: number | null; firstAt: number | null; lastAt: number | null };
    return {
      total,
      byKind,
      speakers: agg.speakers || 0,
      firstAt: agg.firstAt || 0,
      lastAt: agg.lastAt || 0,
    };
  }

  // ---------- 备份 ----------

  /** 立即生成一份数据库快照到指定目录，返回文件路径（异步，使用 SQLite 在线备份 API） */
  async backup(dir: string): Promise<string> {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, `aleabot-backup-${stamp}.db`);
    // better-sqlite3 的 backup 返回 Promise，保证一致性快照
    await this.db.backup(target);
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('last_backup_at', String(Date.now()));
    return target;
  }

  /** 列出已有备份 */
  listBackups(dir: string): Array<{ name: string; size: number; mtime: number; path: string }> {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith('aleabot-backup-') && f.endsWith('.db'))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        return { name: f, size: st.size, mtime: st.mtimeMs, path: full };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  /** 导出为 JSON（便于人工阅读与迁移） */
  exportJSON(): object {
    const logs = this.db.prepare('SELECT * FROM logs ORDER BY created_at').all();
    const sheets = this.db.prepare('SELECT * FROM sheets').all();
    const settings = this.db.prepare('SELECT * FROM settings').all();
    const initiative = this.db.prepare('SELECT * FROM initiative').all();
    return {
      exportedAt: new Date().toISOString(),
      version: '1.0.0',
      schemaVersion: 1,
      tables: { logs, sheets, settings, initiative },
    };
  }

  close(): void {
    this.db.close();
  }
}
