/**
 * 落盘 T3 产物：Skill 包（SKILL.md ＋ references）与简版 Prompt。
 * 内容全部由 `src/t3/content.ts` 从规则单源渲染，本文件只负责写文件与自检。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../t1r/env.js';
import { t3Artifacts } from './content.js';

const files: Array<{ path: string; bytes: number }> = [];
for (const a of t3Artifacts()) {
  const full = path.join(REPO_ROOT, a.path);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, a.content);
  files.push({ path: a.path, bytes: Buffer.byteLength(a.content) });
}
console.log(JSON.stringify({ ok: true, written: files }, null, 2));
