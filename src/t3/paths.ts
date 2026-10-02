import path from 'node:path';
import { CONTRACT_VERSION } from '../contracts/version.js';
import { PROMPT_VERSION } from '../prompts/prompts.js';

/** 新版免费生成/真实运行均隔离到新版目录，历史证据保持原样。 */
export function t3OutputPaths(root: string, runId?: string) {
  if (runId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(runId)) throw new Error('runId 必须是安全的单层目录名');
  const suffix = [`prompts-v${PROMPT_VERSION.replace('prompts@', '')}`, ...(runId ? ['runs', runId] : [])];
  const evidenceDir = path.join(root, 'evidence', 't3', `v${CONTRACT_VERSION}`, ...suffix);
  return { evidenceDir, dataDir: path.join(root, 'data', `t3-v${CONTRACT_VERSION}`, ...suffix), hostsDir: path.join(evidenceDir, 'hosts'), manifestPath: path.join(evidenceDir, 'manifest.json') };
}
