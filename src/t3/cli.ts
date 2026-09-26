/**
 * T3 入口运行器。
 *   node dist/src/t3/cli.js skill:build      # 生成 Skill 包与简版 Prompt（不花钱）
 *   node dist/src/t3/cli.js skill:run        # 按 Skill 流程真跑一场，产出 markdown 报告（真实调用）
 *   node dist/src/t3/cli.js prompt:run       # 把简版 Prompt 粘贴进多轮对话跑一题闭环（真实调用）
 *   node dist/src/t3/cli.js all
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DashscopeTextClient, DASHSCOPE_DEFAULTS } from '../clients/dashscope.js';
import { REPO_ROOT, credentialStatus, loadDotEnv, requireCredential } from '../t1r/env.js';
import { EvidenceWriter, verifyManifest, writeManifestFromDir } from '../t1r/evidence.js';
import { t3Artifacts, versionStamp } from './content.js';
import { runPromptFlow, runSkillFlow } from './run.js';
import { recordHosts } from './hosts.js';
import { runStructureExperiment } from './structure-experiment.js';
import { writeFileSync } from 'node:fs';

const EVIDENCE_T3 = path.join(REPO_ROOT, 'evidence', 't3');
const DATA_T3 = path.join(REPO_ROOT, 'data', 't3');

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'all';
  const envReport = loadDotEnv();
  const writer = new EvidenceWriter(EVIDENCE_T3, DATA_T3);
  const summary: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    command: cmd,
    versionStamp: versionStamp(),
    credential: credentialStatus(),
    dotenv: { path: path.relative(REPO_ROOT, envReport.path), filePresent: envReport.filePresent },
  };

  if (cmd === 'hosts:record' || cmd === 'all') {
    const hosts = recordHosts();
    summary.hosts = hosts.map((h) => ({ host: h.host, status: h.status, checks: h.checks, blocker: h.blocker ? h.blocker.kind : undefined }));
  }

  if (cmd === 'skill:build' || cmd === 'all') {
    const written: Array<{ path: string; bytes: number }> = [];
    for (const a of t3Artifacts()) {
      const full = path.join(REPO_ROOT, a.path);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, a.content);
      mkdirSync(path.dirname(full), { recursive: true });
      written.push({ path: a.path, bytes: Buffer.byteLength(a.content) });
    }
    summary.artifactsWritten = written;
  }

  if (cmd !== 'skill:build' && cmd !== 'manifest' && cmd !== 'hosts:record' && cmd !== 'experiment:dry') {
    requireCredential();
    const client = new DashscopeTextClient();
    summary.textModel = DASHSCOPE_DEFAULTS.model;

    if (cmd === 'skill:run' || cmd === 'all') {
      const skill = await runSkillFlow(client, writer);
      writer.writeJson('skill/session.json', skill);
      writer.writeText('skill/report.md', skill.report.markdown, true);
      summary.skill = {
        caseId: skill.caseId,
        questions: skill.questions.length,
        reportPath: skill.report.path,
        reportChars: skill.report.markdown.length,
        quoteChecks: skill.questions.map((q) => `${q.questionId}: ${q.quoteCheck.located}/${q.quoteCheck.total}${q.quoteCheck.failures.length ? ` (${q.quoteCheck.failures.join(';')})` : ''}`),
        turns: skill.turns,
        totalTokens: skill.turns.reduce((a, t) => a + t.tokens, 0),
        versions: skill.versions,
      };
    }

    if (cmd === 'experiment') {
      const exp = await runStructureExperiment(client, writer);
      writer.writeJson('structure-experiment/summary.json', exp);
      summary.experiment = {
        preregisteredAt: exp.preregisteredAt, ranAt: exp.ranAt, model: exp.model,
        repeats: exp.repeats, totalCalls: exp.totalCalls, batch: exp.batch,
        metrics: exp.metrics, verdict: exp.verdict,
      };
    }

    if (cmd === 'prompt:run' || cmd === 'all') {
      const prompt = await runPromptFlow(client, writer);
      writer.writeJson('prompt/summary.json', prompt);
      summary.prompt = {
        host: prompt.host,
        turns: prompt.transcript.length,
        closedLoop: prompt.closedLoop,
        quoteChecks: prompt.quoteChecks,
        tokens: prompt.transcript.reduce((a, t) => a + (t.tokens ?? 0), 0),
        versions: prompt.versions,
      };
    }
  }

  // run-summary 先落盘，manifest 最后生成并核对（F1 的教训）
  writer.writeJson('run-summary.json', summary);
  const manifestRel = path.join('evidence', 't3', 'manifest.json');
  const manifestAbs = path.join(REPO_ROOT, manifestRel);
  writeManifestFromDir(EVIDENCE_T3, manifestAbs, [manifestRel]);
  const verified = verifyManifest(manifestAbs);
  const doc = JSON.parse(readFileSync(manifestAbs, 'utf8')) as Record<string, unknown>;
  doc.verifiedAt = new Date().toISOString();
  doc.verifiedAgainstDisk = { total: verified.total, mismatches: verified.mismatches };
  writeFileSync(manifestAbs, `${JSON.stringify(doc, null, 2)}\n`);
  if (verified.mismatches.length > 0) throw new Error(`manifest 与磁盘不符：${JSON.stringify(verified.mismatches)}`);
  console.log(JSON.stringify({ ok: true, command: cmd, keys: Object.keys(summary) }, null, 2));
}

main().catch((e: unknown) => {
  console.error(`T3 运行失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
