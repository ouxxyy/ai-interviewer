/**
 * 宿主实测记录（Codex / Claude Code）。
 *
 * 纪律：结论**从原始终端输出里算出来**，不是手写断言——
 * `codex-raw.txt` 是 `codex exec` 的真实输出（只把家目录前缀脱敏成 `~`），
 * 边界句与规则版本号是否出现，由本文件用字符串匹配判定。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../t1r/env.js';
import { t3OutputPaths } from './paths.js';
import { RULES_VERSION } from '../rules/rules.js';

const HOSTS_DIR = t3OutputPaths(REPO_ROOT).hostsDir;

export interface HostRecord {
  host: string;
  requestedRulesVersion: string;
  observedRulesVersion: string | null;
  command: string;
  status: 'verified' | 'blocked' | 'unverified';
  exitCode: number | null;
  /**
   * 从原始输出里算出来的判定依据（R5：只扫**宿主自己的最终回答块**）。
   * 全文扫描会把「宿主回显的 SKILL.md 正文」当成「宿主自己声明了边界」——
   * 这两件事必须分开记：`matchedPhrasesOutsideAnswerBlock` 就是给读者看的对照。
   */
  checks?: {
    answerBlockFound: boolean;
    answerBlockChars: number;
    boundaryStated: boolean;
    rulesVersionCited: boolean;
    matchedPhrases: string[];
    matchedPhrasesOutsideAnswerBlock: string[];
  };
  rawOutput?: { path: string; bytes: number; redacted: boolean };
  blocker?: { kind: string; message: string; retried: boolean };
  note: string;
}

function redact(text: string): { text: string; changed: number } {
  const before = text;
  let out = text.replace(/\/Users\/[A-Za-z0-9._-]+/g, '~');
  return { text: out, changed: out === before ? 0 : 1 };
}

export function recordHosts(opts: { rawDir?: string; outputDir?: string; rulesVersion?: string } = {}): HostRecord[] {
  const rawDir = opts.rawDir ?? HOSTS_DIR;
  const outputDir = opts.outputDir ?? HOSTS_DIR;
  const rulesVersion = opts.rulesVersion ?? RULES_VERSION;
  mkdirSync(outputDir, { recursive: true });
  const records: HostRecord[] = [];

  // ---- Codex：只读取指定版本目录的原始输出 ----
  const codexRaw = path.join(rawDir, 'codex-raw.txt');
  if (existsSync(codexRaw)) {
    const original = readFileSync(codexRaw, 'utf8');
    const { text, changed } = redact(original);
    // 历史原始输出只读；脱敏仅用于派生判定，不原地覆盖。
    const boundaryPhrases = ['没有录音', '没有实时语音', '不能听也不能说', '仅支持纯文字'];
    // 宿主的最终回答在最后一次 `tokens used` 之后；之前的正文是宿主回显的 SKILL.md。
    const marker = text.lastIndexOf('tokens used');
    const answerBlock = marker >= 0 ? text.slice(marker) : '';
    const inBlock = boundaryPhrases.filter((p) => answerBlock.includes(p));
    const outsideBlock = boundaryPhrases.filter((p) => !answerBlock.includes(p) && text.includes(p));
    const versionInBlock = answerBlock.includes(rulesVersion);
    records.push({
      host: 'codex',
      requestedRulesVersion: rulesVersion,
      observedRulesVersion: /rules@\d+\.\d+\.\d+/.exec(answerBlock)?.[0] ?? null,
      command: `codex exec --skip-git-repo-check "<要求技能自报能力边界与规则版本>"`,
      // 阈值与文档一致：**在回答块内**至少命中一条边界短语，且版本号也在块内。
      status: inBlock.length > 0 && versionInBlock ? 'verified' : 'unverified',
      exitCode: null,
      checks: {
        answerBlockFound: marker >= 0,
        answerBlockChars: answerBlock.length,
        boundaryStated: inBlock.length > 0,
        rulesVersionCited: versionInBlock,
        matchedPhrases: inBlock,
        matchedPhrasesOutsideAnswerBlock: outsideBlock,
      },
      rawOutput: { path: path.relative(REPO_ROOT, codexRaw), bytes: Buffer.byteLength(original), redacted: changed === 0 },
      note: '本判定只证明原始宿主最终回答中的边界与版本自报。判定只扫「最后一次 tokens used 之后的回答块」——全文扫描会把宿主回显的 SKILL.md 正文误当成宿主自己的声明。注意 matchedPhrasesOutsideAnswerBlock：那些短语只出现在被回显的文档里。',
    });
  }

  if (!existsSync(codexRaw)) records.push({ host: 'codex', requestedRulesVersion: rulesVersion, observedRulesVersion: null, command: 'codex exec（等待新版原始输出）', status: 'unverified', exitCode: null, note: '该版本没有原始宿主输出，不能借用历史版本宣布通过。' });
  const claudeRaw = path.join(rawDir, 'claude-code-raw.txt');
  const claudeText = existsSync(claudeRaw) ? readFileSync(claudeRaw, 'utf8') : '';
  const observed = /rules@\d+\.\d+\.\d+/.exec(claudeText)?.[0] ?? null;
  records.push({ host: 'claude-code', requestedRulesVersion: rulesVersion, observedRulesVersion: observed, command: 'claude -p（等待可判定的原始最终回答）', status: 'unverified', exitCode: null, note: claudeText ? '当前没有可靠的最终回答块提取协议，未验证；不把回显技能正文当作宿主自己的回答。' : '该版本没有原始宿主输出，未验证；历史配额阻塞不推断为当前状态。' });

  writeFileSync(
    path.join(outputDir, 'summary.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), hosts: records }, null, 2)}\n`,
  );
  return records;
}
