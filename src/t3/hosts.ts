/**
 * 宿主实测记录（Codex / Claude Code）。
 *
 * 纪律：结论**从原始终端输出里算出来**，不是手写断言——
 * `codex-raw.txt` 是 `codex exec` 的真实输出（只把家目录前缀脱敏成 `~`），
 * 边界句与规则版本号是否出现，由本文件用字符串匹配判定。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../t1r/env.js';
import { RULES_VERSION } from '../rules/rules.js';

const HOSTS_DIR = path.join(REPO_ROOT, 'evidence', 't3', 'hosts');

export interface HostRecord {
  host: string;
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

export function recordHosts(): HostRecord[] {
  const records: HostRecord[] = [];

  // ---- Codex：真实跑过两次，第二次的输出落盘为证据 ----
  const codexRaw = path.join(HOSTS_DIR, 'codex-raw.txt');
  if (existsSync(codexRaw)) {
    const original = readFileSync(codexRaw, 'utf8');
    const { text, changed } = redact(original);
    if (changed === 1) writeFileSync(codexRaw, text);
    const boundaryPhrases = ['没有录音', '没有实时语音', '不能听也不能说', '仅支持纯文字'];
    // 宿主的最终回答在最后一次 `tokens used` 之后；之前的正文是宿主回显的 SKILL.md。
    const marker = text.lastIndexOf('tokens used');
    const answerBlock = marker >= 0 ? text.slice(marker) : '';
    const inBlock = boundaryPhrases.filter((p) => answerBlock.includes(p));
    const outsideBlock = boundaryPhrases.filter((p) => !answerBlock.includes(p) && text.includes(p));
    const versionInBlock = answerBlock.includes(RULES_VERSION);
    records.push({
      host: 'codex',
      command: `codex exec --skip-git-repo-check "<要求技能自报能力边界与规则版本>"`,
      // 阈值与文档一致：**在回答块内**至少命中一条边界短语，且版本号也在块内。
      status: inBlock.length > 0 && versionInBlock ? 'verified' : 'unverified',
      exitCode: 0,
      checks: {
        answerBlockFound: marker >= 0,
        answerBlockChars: answerBlock.length,
        boundaryStated: inBlock.length > 0,
        rulesVersionCited: versionInBlock,
        matchedPhrases: inBlock,
        matchedPhrasesOutsideAnswerBlock: outsideBlock,
      },
      rawOutput: { path: path.relative(REPO_ROOT, codexRaw), bytes: Buffer.byteLength(text), redacted: changed === 1 },
      note: 'Skill 从 <项目>/.codex/skills/ 被加载。判定只扫「最后一次 tokens used 之后的回答块」——全文扫描会把宿主回显的 SKILL.md 正文误当成宿主自己的声明。注意 matchedPhrasesOutsideAnswerBlock：那些短语只出现在被回显的文档里。',
    });
  }

  // ---- Claude Code：单次尝试即撞 1310，按止损纪律未重试 ----
  records.push({
    host: 'claude-code',
    command: 'claude -p "请使用 ai-interviewer 技能开始一场中文经历面试训练…"',
    status: 'blocked',
    exitCode: null,
    blocker: {
      kind: 'provider_quota',
      message: 'API Error: Request rejected (429) · [1310] 您已达到每周/每月使用上限，您的限额将在 2026-09-28 06:07:54 重置。',
      retried: false,
    },
    note: 'Skill 已按 INSTALL.md 装好（~/.claude/skills 被沙箱拒绝后改用项目内 .claude/skills/），但宿主本身跑不起来：CLI 走的模型链配额打满。按派单的止损要求「撞上 1310 就停下回报、不要重试」，未做第二次尝试，因此没有可报的实测结果。',
  });

  writeFileSync(
    path.join(HOSTS_DIR, 'summary.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), hosts: records }, null, 2)}\n`,
  );
  return records;
}
