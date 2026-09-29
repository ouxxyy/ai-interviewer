/** Public BYOK boundary. Each visitor has a separate store, settings and manager.
 * Bearer identity never appears in URLs/logs; only its SHA-256 digest is stored.
 * Credentials use AES-256-GCM, with a private master key outside the repository.
 */
import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { AppError } from './errors.js';
import type { CredentialConfigStatus } from './credentials.js';
import type { SessionManager } from './manager.js';
import type { Store } from './store.js';
import type { SettingsStore } from './settings.js';
import type { WebPaths } from './paths.js';

export interface CredentialStore {
  status(): CredentialConfigStatus;
  update(raw: string): CredentialConfigStatus;
}
export interface VisitorContext {
  manager: SessionManager; store: Store; settings: SettingsStore;
  credentials: CredentialStore; paths: WebPaths; close(): void;
}
const COOKIE = '__Host-interview-visitor';
const LOCAL_COOKIE = 'interview-visitor';
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');

export class VisitorRegistry {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private readonly contexts = new Map<string, { value: VisitorContext; used: number }>();
  private issued: number[] = [];
  private readonly requests = new Map<string, { at: number; count: number }>();
  readonly origin: string;
  private readonly secure: boolean;

  constructor(private readonly root: string, origin: string,
    private readonly factory: (root: string, credentials: CredentialStore, key: () => string) => VisitorContext) {
    const url = new URL(origin);
    if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
      throw new Error('AI_INTERVIEWER_PUBLIC_ORIGIN 必须是精确 HTTPS 源站（仅回环测试允许 HTTP）');
    }
    this.origin = origin;
    this.secure = url.protocol === 'https:';
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const keyFile = path.join(root, 'credential-master.key');
    const dbFile = path.join(root, 'visitors.sqlite');
    if (!existsSync(keyFile)) {
      if (existsSync(dbFile)) throw new Error('访客凭证主密钥缺失；请恢复备份，不能生成新密钥覆盖');
      writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
    }
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error('访客凭证主密钥格式错误');
    this.db = new DatabaseSync(dbFile);
    chmodSync(dbFile, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY, credential TEXT, created_at TEXT NOT NULL);');
  }

  checkOrigin(req: IncomingMessage, required = false): void {
    const origin = req.headers.origin;
    if (req.headers['sec-fetch-site'] === 'cross-site' || (origin !== undefined && origin !== this.origin) || (required && origin !== this.origin)) {
      throw new AppError('E_FORBIDDEN', '请求来源不受信任');
    }
    if (req.headers.host !== new URL(this.origin).host) throw new AppError('E_FORBIDDEN', '请求域名不匹配');
  }

  private id(req: IncomingMessage): string | null {
    const header = req.headers['x-visitor-token'];
    const cookieName = this.secure ? COOKIE : LOCAL_COOKIE;
    const token = typeof header === 'string' ? header : (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!token || !/^[0-9a-f-]{36}$/.test(token)) return null;
    const id = digest(token);
    return this.db.prepare('SELECT id FROM visitors WHERE id = ?').get(id) ? id : null;
  }

  bootstrap(req: IncomingMessage, res: ServerResponse): { mode: { public: true; keyConfigured: boolean } } {
    this.checkOrigin(req);
    let id = this.id(req);
    if (id === null) {
      const now = Date.now();
      this.issued = this.issued.filter(at => now - at < 60_000);
      const total = (this.db.prepare('SELECT COUNT(*) AS n FROM visitors').get() as { n: number }).n;
      if (this.issued.length >= 20 || total >= 5000) throw new AppError('E_QUOTA', '访客创建繁忙，请稍后再试');
      const token = randomUUID();
      id = digest(token);
      this.db.prepare('INSERT INTO visitors (id, created_at) VALUES (?, ?)').run(id, new Date().toISOString());
      this.issued.push(now);
      res.setHeader('Set-Cookie', `${this.secure ? COOKIE : LOCAL_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${this.secure ? '; Secure' : ''}`);
    }
    return { mode: { public: true, keyConfigured: this.readKey(id) !== '' } };
  }

  require(req: IncomingMessage, websocket = false): VisitorContext {
    const headerAuth = typeof req.headers['x-visitor-token'] === 'string';
    const id = this.id(req);
    if (!id) throw new AppError('E_UNAUTHORIZED', '访客身份无效，请刷新页面初始化');
    this.checkOrigin(req, websocket || (!headerAuth && !['GET', 'HEAD'].includes(req.method ?? 'GET')));
    const now = Date.now();
    for (const [key, counter] of this.requests) if (now - counter.at >= 60_000) this.requests.delete(key);
    const counter = this.requests.get(id) ?? { at: now, count: 0 };
    this.requests.set(id, counter);
    if (++counter.count > 240) throw new AppError('E_QUOTA', '请求过于频繁，请稍后重试');
    for (const [key, entry] of this.contexts) {
      if (now - entry.used > 30 * 60_000) { entry.value.close(); this.contexts.delete(key); }
    }
    let entry = this.contexts.get(id);
    if (!entry) {
      if (this.contexts.size >= 64) throw new AppError('E_QUOTA', '服务繁忙，请稍后重试');
      const credentials: CredentialStore = {
        status: () => ({ configured: this.readKey(id) !== '', keyName: 'DASHSCOPE_API_KEY', storage: 'visitor-encrypted' }),
        update: raw => {
          const value = raw.trim();
          if (!/^sk-[A-Za-z0-9._-]{17,509}$/.test(value)) throw new AppError('E_VALIDATION', '请填写百炼控制台的完整 API Key');
          const iv = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', this.key, iv);
          cipher.setAAD(Buffer.from(id));
          const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
          const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
          this.db.prepare('UPDATE visitors SET credential = ? WHERE id = ?').run(payload, id);
          return credentials.status();
        },
      };
      const visitorRoot = path.join(this.root, 'visitors', id);
      mkdirSync(visitorRoot, { recursive: true, mode: 0o700 });
      entry = { value: this.factory(visitorRoot, credentials, () => this.readKey(id)), used: now };
      this.contexts.set(id, entry);
    }
    entry.used = now;
    return entry.value;
  }

  private readKey(id: string): string {
    const row = this.db.prepare('SELECT credential FROM visitors WHERE id = ?').get(id) as { credential: string | null };
    if (!row?.credential) return '';
    const data = Buffer.from(row.credential, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  }

  close(): void {
    for (const entry of this.contexts.values()) entry.value.close();
    this.contexts.clear();
    this.db.close();
  }
}
