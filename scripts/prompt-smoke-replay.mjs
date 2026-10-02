// 免费历史回放：不加载凭证、不创建模型客户端、不改原始证据。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { REPO_ROOT } from '../dist/src/t1r/env.js';
import { EvidenceWriter } from '../dist/src/t1r/evidence.js';
import { t3OutputPaths } from '../dist/src/t3/paths.js';
import { validatePromptFeedback, validatePromptReport } from '../dist/src/t3/prompt-validation.js';
import { PROMPT_VERSION } from '../dist/src/prompts/prompts.js';

const sourcePath = 'evidence/t3/v0.3.0/prompt/transcript.json';
const source = readFileSync(path.join(REPO_ROOT, sourcePath));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const raw = JSON.parse(source.toString('utf8'));
const checks = raw.questions.map((q, index) => ({ questionId: q.questionId, check: validatePromptFeedback(q.rawFeedback, { questionId: q.questionId, turnId: `t${index + 1}`, answerText: q.answerText, promptVersion: 'prompts@0.3.0' }) }));
const summary = raw.plan.questions.map((q) => ({ questionId: q.id, kind: q.kind, status: checks.find((r) => r.questionId === q.id)?.check.valid ? 'reviewed' : checks.some((r) => r.questionId === q.id) ? 'skipped' : 'not_reached', feedback: checks.find((r) => r.questionId === q.id)?.check.feedback ?? null, rewriteDelta: null }));
const report = validatePromptReport(raw.reportRaw, { perQuestion: summary, textModel: 'qwen3.8-flash' });
const quoteChecks = checks.flatMap((q) => q.check.quoteChecks);
const evidence = {
  mode: 'offline_historical_replay', networkCalls: 0, currentPromptVersion: PROMPT_VERSION,
  source: { path: sourcePath, sha256: sha256(source), promptVersion: 'prompts@0.3.0', immutable: sha256(readFileSync(path.join(REPO_ROOT, sourcePath))) === sha256(source) },
  questions: checks.map(({ questionId, check }) => ({ questionId, accepted: check.valid, rawValid: check.rawValid, errors: check.errors, rawErrors: check.rawErrors })),
  quotes: { total: quoteChecks.length, located: quoteChecks.filter((q) => q.located).length, modelMetadataValid: quoteChecks.filter((q) => q.modelMetadataValid).length, checks: quoteChecks },
  report, conclusion: '历史反馈仍因 nextFacts 为空被拒绝；坐标可重定位不等于反馈内容可代写。本回放不证明新提示词实调通过。',
};
const output = t3OutputPaths(REPO_ROOT);
new EvidenceWriter(output.evidenceDir, output.dataDir).writeJson('offline-replay.json', evidence);
console.log(JSON.stringify({ networkCalls: 0, acceptedFeedbacks: checks.filter((q) => q.check.valid).length, reportValid: report.valid, quotes: { total: evidence.quotes.total, located: evidence.quotes.located, modelMetadataValid: evidence.quotes.modelMetadataValid }, sourceUnchanged: evidence.source.immutable }, null, 2));
