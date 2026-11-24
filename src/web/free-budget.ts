/** Persistent daily call ceiling plus a process-wide concurrency ceiling for the shared key. */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { AppError } from './errors.js';
import type { CallGuard } from '../clients/openai-compatible.js';
export class FreeBudget {
  private readonly db: DatabaseSync;
  private active = 0;
  constructor(file: string, private readonly dailyCalls = 1000, private readonly concurrentCalls = 4) {
    this.db = new DatabaseSync(file); chmodSync(file, 0o600);
    this.db.exec('CREATE TABLE IF NOT EXISTS free_calls(day TEXT PRIMARY KEY, calls INTEGER NOT NULL)');
  }
  sessionGuard(maxCalls = 80): CallGuard {
    let calls = 0;
    return () => {
      if (calls >= maxCalls) throw new AppError('E_QUOTA', '本场免费训练已达调用上限，请结束本场');
      if (this.active >= this.concurrentCalls) throw new AppError('E_QUOTA', '免费训练正在服务较多用户，请稍后重试');
      const day = new Date().toISOString().slice(0, 10);
      this.db.prepare('INSERT OR IGNORE INTO free_calls(day,calls) VALUES (?,0)').run(day);
      const updated = this.db.prepare('UPDATE free_calls SET calls=calls+1 WHERE day=? AND calls<?').run(day, this.dailyCalls);
      if (updated.changes !== 1) throw new AppError('E_QUOTA', '今日免费额度已用完，请明日再试或配置自己的百炼 API Key');
      calls++; this.active++;
      let released = false;
      return () => { if (!released) { released = true; this.active--; } };
    };
  }
  close(): void { this.db.close(); }
}
