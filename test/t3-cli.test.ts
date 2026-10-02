import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from '../src/t1r/env.js';
import { t3OutputPaths } from '../src/t3/paths.js';

test('Prompt CLI 请求成功但反馈失败时退出1，保留证据，两次运行不覆盖', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 't3-cli-offline-'));
  try {
    const preload = path.join(dir, 'offline-fetch.mjs');
    writeFileSync(preload, `
process.env.DASHSCOPE_API_KEY = 'offline-fixture-no-real-credential';
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  const messages = body.messages;
  const last = messages.at(-1).content;
  let text;
  if (process.env.T3_OFFLINE_MODE === 'throw-request' && last.startsWith('【本题已确认回答】')) throw new Error('offline_provider_error');
  if (messages.length === 1) text = '请提供 JD、经历、求职阶段。';
  else if (last.startsWith('目标岗位：')) text = '请确认材料。';
  else if (process.env.T3_OFFLINE_MODE === 'invalid-plan' && (last.includes('一次输出冻结四项计划 JSON') || last.startsWith('计划未通过'))) text = '{"invalid":true}';
  else if (last.includes('一次输出冻结四项计划 JSON')) text = JSON.stringify({contractVersion:'0.3.0', questions:['请介绍你的应聘方向','请讲一次实际增长动作','请讲一次个人协作边界','请讲一次困难权衡反思'].map((text,i)=>({id:'q'+(i+1),kind:i?'experience':'introduction',text,sourceExcerpt:'负责工具类产品的付费转化增长',intent:'核实当前回答中的动作与事实边界',topics:[text]})),askedTopics:[]});
  else if (last.includes('按已冻结计划原文提问')) text = /原文提问 q[1-4]：([^\\n]+)/.exec(last)[1];
  else if (last.startsWith('【本题已确认回答】')) text = '{"invalid":true}';
  else if (last.startsWith('结束训练。')) text = JSON.stringify({contractVersion:'0.3.0',sessionStatus:'ended_early',completedQuestions:0,totalQuestions:4,perQuestion:JSON.parse(last.slice(last.indexOf('\\n')+1)),priorityPractice:['本次未完成任何题目，无有效反馈'],versions:{ruleVersion:'rules@0.3.0',realtimeModel:null,textModel:body.model}});
  else throw new Error('离线夹具拒绝未知请求');
  return new Response(JSON.stringify({choices:[{message:{content:text}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}), {status:200,headers:{'content-type':'application/json'}});
};
`);
    const run = (mode = '') => spawnSync(process.execPath, ['--import', preload, 'dist/src/t3/cli.js', 'prompt:run', '--output-root', dir], { cwd: REPO_ROOT, env: { ...process.env, T3_OFFLINE_MODE: mode }, encoding: 'utf8', timeout: 20_000 });
    const first = run();
    assert.equal(first.status, 1, first.stderr);
    assert.match(first.stdout, /"ok": false/);
    const runs = path.join(t3OutputPaths(dir).evidenceDir, 'runs');
    const firstId = readdirSync(runs)[0]!;
    const summaryPath = path.join(runs, firstId, 'run-summary.json');
    const before = readFileSync(summaryPath, 'utf8');
    const summary = JSON.parse(before);
    assert.equal(summary.acceptance.ok, false);
    assert.equal(summary.prompt.closedLoop.reportValid, true);
    assert.equal(summary.prompt.closedLoop.gaveFeedback, false);
    assert.ok(readFileSync(path.join(runs, firstId, 'prompt/transcript.json'), 'utf8').includes('invalid'));
    assert.equal(run().status, 1);
    assert.equal(readdirSync(runs).length, 2);
    assert.equal(readFileSync(summaryPath, 'utf8'), before);
    for (const mode of ['invalid-plan', 'throw-request']) {
      const known = new Set(readdirSync(runs));
      assert.equal(run(mode).status, 1);
      const newId = readdirSync(runs).find((id) => !known.has(id))!;
      const failed = JSON.parse(readFileSync(path.join(runs, newId, 'run-summary.json'), 'utf8'));
      assert.equal(failed.acceptance.ok, false);
      assert.equal(failed.failure.code, 'execution_failed');
      assert.ok(readFileSync(path.join(runs, newId, 'prompt/failure.json'), 'utf8'));
      assert.ok(readFileSync(path.join(runs, newId, 'manifest.json'), 'utf8').includes('transcript.json'));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
