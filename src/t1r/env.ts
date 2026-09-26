/**
 * T1-R 凭证与配置加载。
 *
 * 规则（Mika 本轮派单）：
 * - **显式从项目根 `.env` 读取**，不依赖 shell 是否加载 `~/.zshrc`（agent 的 shell 通常不加载）。
 * - 密钥值绝不进入日志、报告、证据文件或评论；本模块不提供任何打印密钥的接口。
 * - 证据落盘前统一过 `assertNoSecret()` 防线。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 编译后位于 dist/src/t1r/，源码位于 src/t1r/，两种情形都指回仓库根。 */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

export interface DotEnvReport {
  /** 实际注入 process.env 的键名（只有键名，没有值）。 */
  injectedKeys: string[];
  /** 文件里存在但值为空、被跳过的键名。 */
  emptyKeys: string[];
  /** 文件是否存在。 */
  filePresent: boolean;
  path: string;
}

/** 极简 .env 解析：KEY=VALUE、`#` 注释、可选引号；不支持分片/命令替换（本项目不需要）。 */
export function loadDotEnv(file = path.join(REPO_ROOT, '.env')): DotEnvReport {
  const report: DotEnvReport = { injectedKeys: [], emptyKeys: [], filePresent: existsSync(file), path: file };
  if (!report.filePresent) return report;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value === '') {
      report.emptyKeys.push(key);
      continue;
    }
    // 已存在的环境变量优先（便于临时覆盖），但 .env 是权威来源这件事要在报告里可见。
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
      report.injectedKeys.push(key);
    } else {
      report.injectedKeys.push(`${key}(已由 shell 提供，保留 shell 值)`);
    }
  }
  return report;
}

/** 取凭证；只回传值，调用方不得打印。缺失时抛错并只提及键名。 */
export function requireCredential(key = 'DASHSCOPE_API_KEY'): string {
  const v = process.env[key];
  if (v === undefined || v.trim() === '') {
    throw new Error(`缺少凭证 ${key}：请写入项目根 .env 或本机环境变量（不要发进对话）`);
  }
  return v.trim();
}

/**
 * 落盘防线：写任何证据文本前调用。命中凭证值即抛错，且**不打印该值**。
 * 这是「密钥不进日志/报告/证据/评论」这条红线的机械保障，而不是靠人记得住。
 */
export function assertNoSecret(text: string): void {
  const key = process.env.DASHSCOPE_API_KEY;
  if (key !== undefined && key.length >= 8 && text.includes(key)) {
    throw new Error('拒绝写入：内容中包含凭证值（已拦截，未打印内容）');
  }
  if (/sk-[A-Za-z0-9._-]{12,}/.test(text)) {
    throw new Error('拒绝写入：内容中匹配到疑似密钥模式 sk-*（已拦截，未打印内容）');
  }
}

/** 供报告使用的配置快照：只暴露键名与是否就绪，不暴露值。 */
export function credentialStatus(): { key: string; present: boolean; length: number } {
  const v = process.env.DASHSCOPE_API_KEY ?? '';
  return { key: 'DASHSCOPE_API_KEY', present: v.trim() !== '', length: v.trim().length };
}
