/**
 * 本机百炼凭证配置。
 *
 * 安全边界：
 * - 只写项目根 `.env`，该文件已被 gitignore；
 * - API 永远只返回「是否已配置」，不返回长度、尾号或原值；
 * - 写入采用同目录临时文件 + 原子替换，并把权限收紧为 0600；
 * - 拒绝换行、空白和非常规字符，避免把额外 `.env` 行注入配置文件。
 */
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError } from './errors.js';
import { REPO_ROOT } from './paths.js';

export const DASHSCOPE_KEY_NAME = 'DASHSCOPE_API_KEY';

export interface CredentialConfigStatus {
  configured: boolean;
  keyName: typeof DASHSCOPE_KEY_NAME;
  storage: '.env';
}

export class CredentialConfigStore {
  constructor(
    private readonly file = path.join(REPO_ROOT, '.env'),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  status(): CredentialConfigStatus {
    return {
      configured: (this.env[DASHSCOPE_KEY_NAME] ?? '').trim() !== '',
      keyName: DASHSCOPE_KEY_NAME,
      storage: '.env',
    };
  }

  update(raw: string): CredentialConfigStatus {
    const apiKey = raw.trim();
    if (apiKey.length < 20 || apiKey.length > 512 || !/^[A-Za-z0-9._-]+$/.test(apiKey)) {
      throw new AppError('E_VALIDATION', 'API Key 格式不合法', {
        hint: '请粘贴百炼控制台生成的完整 API Key，不要包含空格或换行',
      });
    }
    if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) {
      throw new AppError('E_CONFLICT', '拒绝写入符号链接形式的 .env', { hint: '请把项目根 .env 改为普通文件后重试' });
    }

    const current = existsSync(this.file) ? readFileSync(this.file, 'utf8') : '';
    const newline = current.includes('\r\n') ? '\r\n' : '\n';
    const lines = current === '' ? [] : current.replace(/\r?\n$/, '').split(/\r?\n/);
    const nextLine = `${DASHSCOPE_KEY_NAME}=${apiKey}`;
    const index = lines.findIndex((line) => line.trimStart().startsWith(`${DASHSCOPE_KEY_NAME}=`));
    if (index >= 0) lines[index] = nextLine;
    else lines.push(nextLine);
    const next = `${lines.join(newline)}${newline}`;

    const tmp = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(tmp, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(tmp, this.file);
      chmodSync(this.file, 0o600);
    } catch (error) {
      if (existsSync(tmp)) unlinkSync(tmp);
      throw error;
    }
    this.env[DASHSCOPE_KEY_NAME] = apiKey;
    return this.status();
  }
}
