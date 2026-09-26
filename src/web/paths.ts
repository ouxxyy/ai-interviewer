/**
 * 网页入口（MYW-85）本地服务的目录与运行参数。
 *
 * 边界：
 * - 服务只绑 `127.0.0.1`，不做公网监听（PM §4）。
 * - 所有本机数据落在 `data/web/`（已被 .gitignore 排除）：SQLite、录音、上传临时文件。
 * - 用户名下的真实数据与验收证据跑（`data/web-evidence/`）分开，证据跑不碰用户数据。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 编译后位于 dist/src/web/，源码位于 src/web/，两种情形都指回仓库根。 */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** 数据根目录：默认 `data/web`，可用 `AI_INTERVIEWER_DATA_DIR` 覆盖（相对路径按仓库根解析）。 */
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.AI_INTERVIEWER_DATA_DIR?.trim();
  if (!raw) return path.join(REPO_ROOT, 'data', 'web');
  return path.isAbsolute(raw) ? raw : path.join(REPO_ROOT, raw);
}

export interface WebPaths {
  root: string;
  dbFile: string;
  audioDir: string;
  tmpDir: string;
  uploadTmpDir: string;
}

export function webPaths(root = dataRoot()): WebPaths {
  return {
    root,
    dbFile: path.join(root, 'interview.sqlite'),
    audioDir: path.join(root, 'audio'),
    tmpDir: path.join(root, 'tmp'),
    uploadTmpDir: path.join(root, 'tmp', 'uploads'),
  };
}

/** 单会话音频目录；sid 只允许 `[A-Za-z0-9_-]`，避免路径穿越。 */
export function sessionAudioDir(paths: WebPaths, sid: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sid)) throw new Error(`非法会话 id：${sid}`);
  return path.join(paths.audioDir, sid);
}

/**
 * 实时模型：默认仍是 T1-R/T2 冻结的 `qwen3.8-omni-flash-realtime`（见 REALTIME_DEFAULTS）。
 * 允许用 `AI_INTERVIEWER_REALTIME_MODEL` 覆盖——用于「冻结模型在上游侧故障时」如实换用同代可用模型，
 * 覆盖情况必须写进验收记录，不许悄悄换默认值。
 */
export function realtimeModelOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env.AI_INTERVIEWER_REALTIME_MODEL?.trim();
  return v === undefined || v === '' ? undefined : v;
}

export const SERVER_DEFAULTS = {
  host: '127.0.0.1',
  /** 8917 归 T1-S prototype，8787 曾被本机 ActivityWatch 占用。 */
  port: 8918,
} as const;
