/**
 * 网页入口的 SQLite 层（node:sqlite 内置模块，不引入原生依赖）。
 *
 * 约定：
 * - 一律走迁移脚本：`MIGRATIONS` 按版本号顺序执行，`schema_migrations` 记录已应用版本；
 *   **已发布的迁移不再修改**，后续变更追加新版本（可回滚＝保留前向脚本＋能重建库）。
 * - 外键开启（`PRAGMA foreign_keys = ON`），删除会话靠 `ON DELETE CASCADE` + 显式文件清理。
 * - 查询用到的列都建索引（见 001 迁移）。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-sessions-turns-feedbacks-settings',
    sql: `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL,                -- active | report | ended
  state TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 1, -- 1＝虚构演示；演示会话不进真实统计（D9）
  save_audio INTEGER NOT NULL,
  rule_version TEXT NOT NULL,
  realtime_model TEXT,
  text_model TEXT,
  materials_json TEXT,
  plan_json TEXT,
  report_json TEXT,
  completed_questions INTEGER NOT NULL DEFAULT 0,
  delete_requested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_created_at ON sessions (created_at DESC);
CREATE INDEX idx_sessions_synthetic ON sessions (synthetic);

CREATE TABLE turns (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  speaker TEXT NOT NULL,               -- user | interviewer
  turn_type TEXT NOT NULL,             -- question | answer | followup | rewrite
  seq INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  raw_transcript TEXT NOT NULL,
  revised_text TEXT,
  audio_file TEXT,                     -- 相对数据根；null＝本场未保存录音
  audio_bytes INTEGER,
  audio_sample_rate INTEGER,
  audio_sha256 TEXT,
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);
CREATE INDEX idx_turns_session_seq ON turns (session_id, seq);
CREATE INDEX idx_turns_question ON turns (session_id, question_id);

CREATE TABLE feedbacks (
  session_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- feedback | rewrite_delta
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, question_id, kind),
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
];

export interface MigrationResult {
  applied: number[];
  alreadyApplied: number[];
  version: number;
}

export class InterviewDb {
  readonly raw: DatabaseSync;
  constructor(readonly file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA journal_mode = WAL');
  }

  migrate(migrations: Migration[] = MIGRATIONS): MigrationResult {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const done = new Set(
      (this.raw.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => Number(r.version)),
    );
    const applied: number[] = [];
    const alreadyApplied: number[] = [];
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (done.has(m.version)) {
        alreadyApplied.push(m.version);
        continue;
      }
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(m.sql);
        this.raw.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
        this.raw.exec('COMMIT');
      } catch (e) {
        this.raw.exec('ROLLBACK');
        throw new Error(`迁移 ${m.version}（${m.name}）失败：${(e as Error).message}`);
      }
      applied.push(m.version);
    }
    const version = (this.raw.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v;
    return { applied, alreadyApplied, version: Number(version) };
  }

  /** 当前已应用的最高迁移版本。 */
  version(): number {
    const row = this.raw.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number } | undefined;
    return Number(row?.v ?? 0);
  }

  close(): void {
    try {
      this.raw.close();
    } catch {
      /* 重复 close 忽略 */
    }
  }
}
