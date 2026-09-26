/**
 * T2 运行器：规则文本落盘 + 对照标定 + 代表案例复测。
 *
 * 用法：
 *   node dist/src/t2/run.js rules:write      # 由 src/rules/rules.ts 生成 docs/rules.md
 *   node dist/src/t2/run.js calibration      # 三版本对照标定（真实模型）
 *   node dist/src/t2/run.js representative   # 代表案例重复评审 3 次（真实模型）
 *   node dist/src/t2/run.js all
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DashscopeTextClient, DASHSCOPE_DEFAULTS } from '../clients/dashscope.js';
import { REPO_ROOT, credentialStatus, loadDotEnv, requireCredential } from '../t1r/env.js';
import { EVIDENCE_T2_DIR, DATA_T2_DIR, EvidenceWriter, verifyManifest, writeManifestFromDir } from '../t1r/evidence.js';
import { RULES_VERSION, rulesDigest, rulesMarkdown } from '../rules/rules.js';
import { CONTRACT_VERSION, SUPPORTED_CONTRACT_VERSIONS } from '../contracts/version.js';
import { PROMPT_VERSION } from '../prompts/prompts.js';
import { runCalibration, runRepresentative } from './run-t2.js';

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'all';
  const envReport = loadDotEnv();
  const writer = new EvidenceWriter(EVIDENCE_T2_DIR, DATA_T2_DIR);
  const summary: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    command: cmd,
    versions: { contract: CONTRACT_VERSION, supportedContracts: SUPPORTED_CONTRACT_VERSIONS, rules: RULES_VERSION, prompts: PROMPT_VERSION },
    rulesDigest: rulesDigest(),
    credential: credentialStatus(),
    dotenv: { path: path.relative(REPO_ROOT, envReport.path), filePresent: envReport.filePresent, injectedKeys: envReport.injectedKeys },
  };

  if (cmd === 'rules:write' || cmd === 'all') {
    const target = path.join(REPO_ROOT, 'docs', 'rules.md');
    writeFileSync(target, rulesMarkdown());
    writer.note('rules', { target: path.relative(REPO_ROOT, target), version: RULES_VERSION, digest: rulesDigest() });
    summary.rulesWritten = { target: path.relative(REPO_ROOT, target), version: RULES_VERSION, digest: rulesDigest() };
  }

  const needsModel = cmd === 'calibration' || cmd === 'representative' || cmd === 'all';
  if (needsModel) {
    const credential = requireCredential();
    const text = new DashscopeTextClient();
    summary.textModel = DASHSCOPE_DEFAULTS.model;

    if (cmd === 'calibration' || cmd === 'all') {
      const result = await runCalibration(text, writer);
      writer.writeJson('calibration/summary.json', result);
      summary.calibration = {
        batch: result.batch,
        selectionRule: result.selectionRule,
        baselineProvenance: result.baselineProvenance,
        summaries: result.summaries,
      };
      void credential;
    }

    if (cmd === 'representative' || cmd === 'all') {
      // 可选：只复测指定案例（改标注后定点重测用），如 `representative C01`
      const caseIds = process.argv.slice(3).filter((a) => /^C\d+$/.test(a));
      const result = await runRepresentative(text, writer, caseIds.length > 0 ? { caseIds } : {});
      writer.writeJson('representative/summary.json', result);
      summary.representative = { repeats: result.repeats, verdict: result.verdict, cases: result.cases };
    }
  }

  // 汇总合并写入：分几个子命令跑时，后一次不会把前一次的结果冲掉。
  const summaryPath = path.join(EVIDENCE_T2_DIR, 'run-summary.json');
  let merged: Record<string, unknown> = {};
  if (existsSync(summaryPath)) {
    try {
      merged = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>;
    } catch {
      merged = {};
    }
  }
  // 从各分节文件重建汇总（纯派生，不需要重跑模型调用）
  const rollup: Record<string, unknown> = { ...merged, ...summary };
  const pull = (rel: string, key: string, pick: (d: Record<string, unknown>) => unknown): void => {
    const f = path.join(EVIDENCE_T2_DIR, rel);
    if (!existsSync(f)) return;
    try {
      const d = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
      rollup[key] = pick(d);
    } catch {
      /* 分节文件坏了就不覆盖，保持原值 */
    }
  };
  pull('calibration/summary.json', 'calibration', (d) => ({ batch: d.batch, selectionRule: d.selectionRule, baselineProvenance: d.baselineProvenance, summaries: d.summaries }));
  pull('representative/summary.json', 'representative', (d) => ({ repeats: d.repeats, verdict: d.verdict, cases: d.cases }));
  // 顺序很重要：run-summary 先落盘，manifest 最后生成——manifest 记的是别的产物的摘要，
  // 先写就会把过期的大小/哈希记进去（F1 就是这么来的）。manifest 里不含 run-summary 的自述。
  writer.writeJson('run-summary.json', rollup);
  const manifestRel = path.join('evidence', 't2', 'manifest.json');
  const manifestAbs = path.join(REPO_ROOT, manifestRel);
  writeManifestFromDir(EVIDENCE_T2_DIR, manifestAbs, [manifestRel]);
  // 生成后立刻逐条核对，把结果写进 manifest 自己：声称「已核对」必须留下可复核的痕迹。
  const verified = verifyManifest(manifestAbs);
  const withCheck = JSON.parse(readFileSync(manifestAbs, 'utf8')) as Record<string, unknown>;
  withCheck.verifiedAt = new Date().toISOString();
  withCheck.verifiedAgainstDisk = { total: verified.total, mismatches: verified.mismatches };
  writeFileSync(manifestAbs, `${JSON.stringify(withCheck, null, 2)}\n`);
  if (verified.mismatches.length > 0) throw new Error(`manifest 与磁盘不符：${JSON.stringify(verified.mismatches)}`);
  console.log(JSON.stringify({ ok: true, command: cmd, keys: Object.keys(summary) }, null, 2));
}

main().catch((e: unknown) => {
  console.error(`T2 运行失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
