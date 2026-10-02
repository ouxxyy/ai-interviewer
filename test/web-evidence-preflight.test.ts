/** 付费验收驱动的离线预检；不导入会自执行的 run-evidence。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { ANSWER_TEXTS, assertAnswerAudioPool, evidenceWorkspace, prepareEvidenceWorkspace } from '../src/web/evidence-preflight.js';
import { REPO_ROOT } from '../src/web/paths.js';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'web-evidence-preflight-'));
  const pcmFiles = ANSWER_TEXTS.map((_, i) => {
    const file = path.join(root, `answer-${i + 1}.pcm`);
    writeFileSync(file, Buffer.alloc(3200, i + 1));
    return file;
  });
  return { root, pcmFiles, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('音频池以真实声明为准：介绍首段＋六段补充/经历材料对应7份PCM', () => {
  const f = fixture();
  try {
    assert.equal(ANSWER_TEXTS.length, 7);
    assert.match(ANSWER_TEXTS[0]!, /我是一名应届毕业生/);
    assert.match(ANSWER_TEXTS[0]!, /希望申请内容运营岗位/);
    assert.doesNotThrow(() => assertAnswerAudioPool(ANSWER_TEXTS, f.pcmFiles));
  } finally { f.cleanup(); }
});

test('音频池缺一份必须拒绝，不能沿用旧6份断言通过', () => {
  const f = fixture();
  try {
    assert.throws(() => assertAnswerAudioPool(ANSWER_TEXTS, f.pcmFiles.slice(0, -1)), /数量不符/);
  } finally { f.cleanup(); }
});

test('音频池数量正确但文件缺失或复用时，仍拒绝进入真实调用', () => {
  const f = fixture();
  try {
    const duplicate = [...f.pcmFiles];
    duplicate[1] = duplicate[0]!;
    assert.throws(() => assertAnswerAudioPool(ANSWER_TEXTS, duplicate), /重复PCM/);
    rmSync(f.pcmFiles[0]!);
    assert.throws(() => assertAnswerAudioPool(ANSWER_TEXTS, f.pcmFiles), /缺少PCM/);
  } finally { f.cleanup(); }
});

test('新版验收工作目录不删除旧版summary依赖的数据库、音频和Chrome素材', () => {
  const f = fixture();
  try {
    const oldData = path.join(f.root, 'data', 'web-evidence');
    const oldHarness = path.join(f.root, 'data', 'web-evidence-harness');
    mkdirSync(path.join(oldData, 'audio'), { recursive: true });
    mkdirSync(path.join(oldHarness, 'answer-audio'), { recursive: true });
    const oldFiles = [path.join(oldData, 'interview.sqlite'), path.join(oldData, 'audio', 'saved.wav'), path.join(oldHarness, 'answer-audio', 'answer-1.pcm')];
    oldFiles.forEach((file) => writeFileSync(file, `旧证据:${path.basename(file)}`));
    const before = oldFiles.map((file) => readFileSync(file));
    const workspace = evidenceWorkspace(f.root, '0.3.0', 'run-test');
    prepareEvidenceWorkspace(workspace);
    oldFiles.forEach((file, i) => assert.deepEqual(readFileSync(file), before[i]));
    assert.equal(workspace.dataDir, path.join(oldData, 'v0.3.0', 'run-test'));
    assert.equal(workspace.harnessDir, path.join(oldHarness, 'v0.3.0', 'run-test'));
    assert.equal(existsSync(workspace.dataDir), true);
    assert.equal(existsSync(workspace.audioWork), true);
  } finally { f.cleanup(); }
});

test('重复使用本轮工作目录拒绝覆盖，再跑使用另一run目录并保留前次数据', () => {
  const f = fixture();
  try {
    const first = evidenceWorkspace(f.root, '0.3.0', 'run-first');
    prepareEvidenceWorkspace(first);
    mkdirSync(first.dataDir, { recursive: true });
    const sentinel = path.join(first.dataDir, 'original.sqlite');
    writeFileSync(sentinel, '保留首次验收');
    assert.throws(() => prepareEvidenceWorkspace(first), /已存在/);
    const next = evidenceWorkspace(f.root, '0.3.0', 'run-next');
    prepareEvidenceWorkspace(next);
    assert.equal(readFileSync(sentinel, 'utf8'), '保留首次验收');
    assert.notEqual(first.dataDir, next.dataDir);
    assert.notEqual(first.harnessDir, next.harnessDir);
  } finally { f.cleanup(); }
});

test('验收驱动实际传版本隔离DATA_DIR给服务，不残留旧CLI目录', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'src', 'web', 'run-evidence.ts'), 'utf8');
  assert.ok(source.includes("'--data-dir', DATA_DIR"), '服务CLI必须接收本轮隔离DATA_DIR');
  assert.doesNotMatch(source, /'--data-dir', 'data\/web-evidence'/);
  assert.match(source, /prepareEvidenceWorkspace\(workspace\)/);
  assert.match(source, /assertAnswerAudioPool\(ANSWER_TEXTS, answerPcmFiles\)/);
});

test('doc-only渲染只采用已有summary实测目录，不把本轮生成的新路径写成实测', () => {
  // 仅编译并执行实际纯渲染函数；不加载验收入口、凭证或付费调用代码。
  const source = readFileSync(path.join(REPO_ROOT, 'src', 'web', 'run-evidence.ts'), 'utf8');
  const ast = ts.createSourceFile('run-evidence.ts', source, ts.ScriptTarget.Latest, true);
  const renderer = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'renderAcceptanceDoc');
  assert.ok(renderer);
  const js = ts.transpileModule(renderer.getText(ast).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const render = new Function('PORT', 'REALTIME_DEFAULTS', 'KNOWN_LIMITS', 'path', 'REPO_ROOT', 'EVIDENCE_DIR', `${js}; return renderAcceptanceDoc;`)(8919, { defaultVoice: 'Maia' }, [], path, REPO_ROOT, path.join(REPO_ROOT, 'evidence', 'web', 'v0.3.0')) as (summary: Record<string, unknown>) => string;
  const summary = { ranAt: '旧实测时间', dataDir: 'data/web-evidence/recorded-only', totals: { ms: 0, assertions: 1, failed: 0 }, steps: [] };
  const before = JSON.stringify(summary);
  assert.match(render(summary), /数据目录 `data\/web-evidence\/recorded-only`/);
  assert.equal(JSON.stringify(summary), before);
  const docOnly = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'docOnly');
  assert.ok(docOnly);
  assert.doesNotMatch(docOnly.getText(ast), /prepareEvidenceWorkspace|DATA_DIR|main\(/);
});
