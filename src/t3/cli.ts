/**
 * T3 入口运行器。
 *   node dist/src/t3/cli.js skill:build      # 生成 Skill 包与简版 Prompt（不花钱）
 *   node dist/src/t3/cli.js skill:run        # 按 Skill 流程真跑一场，产出 markdown 报告（真实调用）
 *   node dist/src/t3/cli.js prompt:run       # 把简版 Prompt 粘贴进多轮对话跑介绍与一经历题闭环（真实调用）
 *   node dist/src/t3/cli.js all
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DashscopeTextClient, DASHSCOPE_DEFAULTS } from '../clients/dashscope.js';
import { REPO_ROOT, credentialStatus, loadDotEnv, requireCredential } from '../t1r/env.js';
import { EvidenceWriter, verifyManifest, writeManifestFromDir } from '../t1r/evidence.js';
import { t3Artifacts, versionStamp } from './content.js';
import { promptRunPassed, runPromptFlow, runSkillFlow } from './run.js';
import { recordHosts } from './hosts.js';
import { t3OutputPaths } from './paths.js';
import { writeFileSync } from 'node:fs';

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'all';
  if (cmd === 'experiment' || cmd === 'experiment:dry') throw new Error('历史 structure 实验冻结为 rules@0.2.0；当前 0.3 提示词不兼容，必须另行预登记后才能运行。未改写历史路径或判据。');
  if (!['skill:build', 'skill:run', 'prompt:run', 'manifest', 'hosts:record', 'all'].includes(cmd)) throw new Error(`未知 T3 命令：${cmd}`);
  const paid = ['skill:run', 'prompt:run', 'all'].includes(cmd);
  // 每次真实调用独占新目录；免费生成不能覆盖上一轮的失败或成功证据。
  const runId = paid ? randomUUID() : undefined;
  const outputFlag = process.argv.indexOf('--output-root');
  if (outputFlag >= 0 && !process.argv[outputFlag + 1]) throw new Error('--output-root 缺少目录');
  const outputRoot = outputFlag >= 0 ? path.resolve(process.argv[outputFlag + 1]!) : REPO_ROOT;
  const { evidenceDir: EVIDENCE_T3, dataDir: DATA_T3, manifestPath } = t3OutputPaths(outputRoot, runId);
  const envReport = loadDotEnv();
  const writer = new EvidenceWriter(EVIDENCE_T3, DATA_T3);
  const summary: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    command: cmd,
    ...(runId ? { runId } : {}),
    versionStamp: versionStamp(),
    credential: credentialStatus(),
    dotenv: { path: path.relative(REPO_ROOT, envReport.path), filePresent: envReport.filePresent },
  };
  let ok = true;
  let rawHostPassed: boolean | null = null;

  try {
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

  if (cmd !== 'skill:build' && cmd !== 'manifest' && cmd !== 'hosts:record') {
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
        quoteChecks: skill.questions.map((q) => { const check = q.rewrite?.quoteCheck ?? q.quoteCheck; return `${q.questionId}: ${check.located}/${check.total} (${q.rewrite?.feedbackKind ?? q.feedbackKind})${check.failures.length ? ` (${check.failures.join(';')})` : ''}`; }),
        reportSource: skill.report.source,
        turns: skill.turns,
        totalTokens: skill.turns.reduce((a, t) => a + t.tokens, 0),
        versions: skill.versions,
      };
    }

    if (cmd === 'prompt:run' || cmd === 'all') {
      const prompt = await runPromptFlow(client, writer);
      writer.writeJson('prompt/summary.json', prompt);
      summary.prompt = {
        host: prompt.host,
        turns: prompt.transcript.length,
        closedLoop: prompt.closedLoop,
        rawClosedLoop: prompt.rawClosedLoop,
        verificationMode: prompt.verificationMode,
        quoteChecks: prompt.quoteChecks,
        tokens: prompt.transcript.reduce((a, t) => a + (t.tokens ?? 0), 0),
        versions: prompt.versions,
      };
      ok = promptRunPassed(prompt);
      rawHostPassed = promptRunPassed({ closedLoop: prompt.rawClosedLoop });
    }
  }

  } catch {
    ok = false;
    summary.failure = { code: 'execution_failed', note: '命令中途失败；本轮已成功的对话及失败记录已保留，不作为通过。' };
  }

  // 即使中途失败也保存 run-summary 与 manifest；不覆盖上一轮或把 HTTP200 当验收成功。
  summary.acceptance = { ok, rawHostPassed };
  writer.writeJson('run-summary.json', summary);
  const manifestAbs = manifestPath;
  const manifestRel = path.relative(REPO_ROOT, manifestAbs);
  writeManifestFromDir(EVIDENCE_T3, manifestAbs, [manifestRel]);
  const verified = verifyManifest(manifestAbs);
  const doc = JSON.parse(readFileSync(manifestAbs, 'utf8')) as Record<string, unknown>;
  doc.verifiedAt = new Date().toISOString();
  doc.verifiedAgainstDisk = { total: verified.total, mismatches: verified.mismatches };
  writeFileSync(manifestAbs, `${JSON.stringify(doc, null, 2)}\n`);
  if (verified.mismatches.length > 0) throw new Error(`manifest 与磁盘不符：${JSON.stringify(verified.mismatches)}`);
  console.log(JSON.stringify({ ok, rawHostPassed, command: cmd, evidencePath: path.relative(REPO_ROOT, EVIDENCE_T3), keys: Object.keys(summary) }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(`T3 运行失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
