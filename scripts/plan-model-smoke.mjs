/** 精确复测失败材料的网页出题步骤。默认只读；--allow-paid 必须先取得用户费用授权。 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { REPO_ROOT, webPaths } from '../dist/src/web/paths.js';
import { buildPlanSources, WEB_PLAN_VERSION } from '../dist/src/web/plan-sources.js';
import { validateQuestionPlan } from '../dist/src/contracts/question-plan.js';
import { InterviewRunner } from '../dist/src/web/runner.js';
import { InterviewDb } from '../dist/src/web/db.js';
import { Store } from '../dist/src/web/store.js';
import { Logger } from '../dist/src/web/log.js';
import { RealtimeBridge } from '../dist/src/web/realtime-bridge.js';
import { MockRealtimeClient } from '../dist/test/helpers/web-mocks.js';
import { DashscopeTextClient } from '../dist/src/clients/dashscope.js';
import { loadDotEnv, requireCredential, assertNoSecret } from '../dist/src/t1r/env.js';

const args = process.argv.slice(2);
const sid = args[args.indexOf('--session') + 1];
if (!args.includes('--session') || !/^s-[a-z0-9-]+$/.test(sid ?? '')) throw new Error('需要 --session <已保存会话ID>');
const sourceDb = new DatabaseSync(webPaths().dbFile, { readOnly: true });
let materials;
try {
  const row = sourceDb.prepare('SELECT materials_json FROM sessions WHERE id = ?').get(sid);
  if (!row?.materials_json) throw new Error('该会话没有已保存材料');
  materials = JSON.parse(row.materials_json);
} finally { sourceDb.close(); }
assert.equal(materials.confirmed, true);
const sources = buildPlanSources(materials);
assert.ok(sources.every(s => materials[s.material].slice(s.start, s.end) === s.text && s.text.length >= 4));
if (!args.includes('--allow-paid')) {
  console.log(JSON.stringify({ mode: 'dry-run', webPlan: WEB_PLAN_VERSION, catalogValid: true, sourceCount: sources.length, maxPaidCallsIfAuthorized: 2, paidCalls: 0 }));
  process.exit(0);
}

loadDotEnv(path.join(REPO_ROOT, '.env'));
const credential = requireCredential();
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
// 原始请求/响应只留在已忽略的私有 data 目录，不写公开证据目录或控制台。
const output = path.join(REPO_ROOT, 'data', 'plan-source-fix', runId);
mkdirSync(output, { recursive: true, mode: 0o700 });
const save = (name, data) => {
  const text = JSON.stringify(data, null, 2) + '\n';
  assertNoSecret(text);
  writeFileSync(path.join(output, name), text, { mode: 0o600 });
};
const temporary = mkdtempSync(path.join(os.tmpdir(), 'plan-real-smoke-'));
const paths = webPaths(temporary);
const db = new InterviewDb(paths.dbFile); db.migrate();
const store = new Store(db, paths);
const logger = new Logger(() => {}, 'error');
const real = new DashscopeTextClient({ credential: () => credential, ...(process.env.AI_INTERVIEWER_TEXT_MODEL ? { model: process.env.AI_INTERVIEWER_TEXT_MODEL } : {}), timeoutMs: 60000 });
let calls = 0;
const responses = [];
const textClient = { name: real.name, model: real.model, complete: async req => {
  assert.ok(req.prompt.includes('生成一场训练的问题计划'), '只授权出题');
  assert.ok(calls < 2, '真实调用硬上限为2');
  const attempt = ++calls;
  save(`attempt-${attempt}-request.json`, req);
  const result = await real.complete({ ...req, timeoutMs: 60000 });
  save(`attempt-${attempt}-response.json`, result);
  responses.push(result);
  return result;
} };
const runner = new InterviewRunner({ store, textClient, logger, credential, sessionId: 's-isolated-plan-smoke', synthetic: false, saveHistory: false, saveAudio: false,
  createBridge: () => new RealtimeBridge({ credential: 'offline-voice-not-used', logger, createClient: () => new MockRealtimeClient() }),
});
const summary = { runId, webPlan: WEB_PLAN_VERSION, model: real.model, scope: '真实文本出题；同生产编排与校验；语音为替身；不评审、不生成报告；原会话只读', pass: false, paidCalls: 0, sourceCount: sources.length, rawOutputsSavedPrivately: true };
try {
  const snapshot = await runner.confirmMaterials(materials);
  assert.equal(snapshot.state, 'answer');
  assert.equal(snapshot.lastError, null);
  assert.equal(validateQuestionPlan(snapshot.plan, materials).ok, true);
  assert.ok(snapshot.plan.questions.every(q => materials.jd.includes(q.sourceExcerpt) || materials.experience.includes(q.sourceExcerpt)));
  save('plan.json', snapshot.plan);
  Object.assign(summary, { pass: true, questions: snapshot.plan.questions.length, allSourcesExact: true, state: snapshot.state });
} catch (error) {
  // 防止原始模型输出/用户材料通过错误文本进入普通日志。
  Object.assign(summary, { failureCode: error.code ?? 'VALIDATION_OR_PROVIDER_FAILURE' });
  process.exitCode = 1;
} finally {
  summary.paidCalls = calls;
  summary.usage = responses.map(r => r.usage ?? {});
  save('summary.json', summary);
  runner.close(); db.close();
  rmSync(temporary, { recursive: true, force: true });
  console.log(JSON.stringify(summary));
}
