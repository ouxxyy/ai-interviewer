import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t3OutputPaths } from '../src/t3/paths.js';
import { recordHosts } from '../src/t3/hosts.js';
import { runStructureExperiment } from '../src/t3/structure-experiment.js';
import type { DashscopeTextClient } from '../src/clients/dashscope.js';
import type { EvidenceWriter } from '../src/t1r/evidence.js';
import { PROMPT_VERSION } from '../src/prompts/prompts.js';

test('T3 新版产物目录与旧 summary/session/manifest 隔离', () => {
  const p = t3OutputPaths('/repo');
  const promptDir = `prompts-v${PROMPT_VERSION.replace('prompts@', '')}`;
  assert.equal(p.evidenceDir, `/repo/evidence/t3/v0.3.0/${promptDir}`);
  assert.equal(p.dataDir, `/repo/data/t3-v0.3.0/${promptDir}`);
  assert.equal(p.manifestPath, `${p.evidenceDir}/manifest.json`);
});

test('同一提示词的两次实调使用不同叶目录，拒绝目录穿越', () => {
  const first = t3OutputPaths('/repo', 'run-one');
  const second = t3OutputPaths('/repo', 'run-two');
  assert.notEqual(first.evidenceDir, second.evidenceDir);
  assert.match(first.evidenceDir, /runs\/run-one$/);
  assert.throws(() => t3OutputPaths('/repo', '../old'), /runId/);
});

test('宿主旧输出不宣称新版通过，也不原地脱敏或覆写旧 raw/summary', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hosts-v03-'));
  try {
    const rawDir = path.join(dir, 'old'); const outputDir = path.join(dir, 'new'); mkdirSync(rawDir);
    const raw = '/Users/synthetic/.codex/skills\ntokens used\n123\n仅支持纯文字，没有录音 rules@0.2.0';
    writeFileSync(path.join(rawDir, 'codex-raw.txt'), raw);
    writeFileSync(path.join(rawDir, 'summary.json'), 'OLD SUMMARY');
    const records = recordHosts({ rawDir, outputDir });
    assert.equal(records.find((r) => r.host === 'codex')!.status, 'unverified');
    assert.equal(records.find((r) => r.host === 'codex')!.observedRulesVersion, 'rules@0.2.0');
    assert.equal(readFileSync(path.join(rawDir, 'codex-raw.txt'), 'utf8'), raw);
    assert.equal(readFileSync(path.join(rawDir, 'summary.json'), 'utf8'), 'OLD SUMMARY');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('旧结构实验在写证据/调用模型之前拒绝当前规则，要求重新预登记', async () => {
  await assert.rejects(runStructureExperiment({} as DashscopeTextClient, {} as EvidenceWriter), /不兼容|重新预登记/);
});
