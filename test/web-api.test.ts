/**
 * 对外接口测试（离线）：统一错误响应、输入校验、分页、首次使用告知门、两开关、
 * WS 音频链路（服务端不泄露凭证）、暂停/打断、回放下载、删除前后对照、重启后历史仍可用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import WebSocket from 'ws';
import { startServer } from '../src/web/cli.js';
import { Logger } from '../src/web/log.js';
import { REPO_ROOT } from '../src/web/paths.js';
import { DEMO_MATERIALS } from '../src/web/materials.js';
import { MockRealtimeClient, type MockRealtimeScript } from './helpers/web-mocks.js';
import { ScriptedTextClient, type TextScript } from './helpers/web-mocks.js';
import { RealtimeBridge } from '../src/web/realtime-bridge.js';

const PCM = Buffer.alloc(3200, 5);

interface Api {
  url: string;
  close(): Promise<void>;
  dataDir: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createHttpServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function boot(label: string, opts: { text?: TextScript; realtime?: MockRealtimeScript; dataDir?: string; staticDir?: string } = {}): Promise<Api & { dataDir: string; text: ScriptedTextClient }> {
  const dataDir = opts.dataDir ?? path.join(REPO_ROOT, 'data', `web-test-api-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dataDir, { recursive: true });
  const text = new ScriptedTextClient(opts.text ?? {});
  const port = await freePort();
  const serveOptions: Parameters<typeof startServer>[0] & { staticDir?: string } = {
    port,
    dataDir,
    ...(opts.staticDir === undefined ? {} : { staticDir: opts.staticDir }),
    logger: new Logger(() => {}, 'error'),
    textClient: text,
    createBridge: (): RealtimeBridge =>
      new RealtimeBridge({
        credential: 'sk-test-not-a-real-key-000000',
        logger: new Logger(() => {}, 'error'),
        createClient: () => new MockRealtimeClient(opts.realtime ?? {}),
      }),
  };
  const started = await startServer(serveOptions);
  return { url: started.url, dataDir, text, close: started.close };
}

async function call(url: string, method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}${p}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

function openWs(url: string, sid: string): Promise<{ ws: WebSocket; messages: any[]; waitFor: (pred: (m: any) => boolean, label: string, timeoutMs?: number) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/realtime?sid=${encodeURIComponent(sid)}`);
    const messages: any[] = [];
    const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void; reject: (e: Error) => void; label: string }> = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as any;
      messages.push(msg);
      for (const w of [...waiters]) {
        if (w.pred(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        messages,
        waitFor: (pred, label, timeoutMs = 8000) =>
          new Promise((res, rej) => {
            const found = messages.find(pred);
            if (found !== undefined) return res(found);
            const timer = setTimeout(() => rej(new Error(`等待 WS 消息超时：${label}`)), timeoutMs);
            waiters.push({ pred, label, resolve: (m) => { clearTimeout(timer); res(m); }, reject: rej });
          }),
      }),
    );
  });
}

const MATERIALS = { jd: DEMO_MATERIALS.jd, experience: DEMO_MATERIALS.experience, stage: DEMO_MATERIALS.stage, targetRole: DEMO_MATERIALS.targetRole };

test('健康检查与首次使用告知：版本、凭证只报存在性、告知字段齐全', async () => {
  const api = await boot('health');
  try {
    const health = await call(api.url, 'GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.versions.contract, '0.2.0');
    assert.equal(health.body.versions.rules, 'rules@0.2.0');
    assert.equal(typeof health.body.versions.rulesDigest, 'string');
    assert.equal(health.body.credential.present, false, '测试环境没有注入凭证值');
    assert.equal(JSON.stringify(health.body).includes('sk-'), false);
    const disclosure = await call(api.url, 'GET', '/api/disclosure');
    assert.equal(disclosure.status, 200);
    const d = disclosure.body.disclosure;
    assert.equal(d.version, 'disclosure@0.1.0');
    assert.ok(d.staysLocal.length >= 3 && d.sentToCloud.length >= 3 && d.deletion.length >= 2);
    assert.match(d.storage.database, /interview\.sqlite/);
    assert.match(d.billing.payer, /百炼/);
    assert.equal(disclosure.body.acknowledged, false);
  } finally {
    await api.close();
    rmSync(api.dataDir, { recursive: true, force: true });
  }
});

test('未经告知确认不得创建会话（428），确认后可创建', async () => {
  const api = await boot('gate');
  try {
    const blocked = await call(api.url, 'POST', '/api/sessions', {});
    assert.equal(blocked.status, 428);
    assert.equal(blocked.body.error.code, 'E_DISCLOSURE_REQUIRED');
    assert.match(blocked.body.error.hint, /disclosure/);
    const ack = await call(api.url, 'PATCH', '/api/settings', { disclosureAck: true });
    assert.equal(ack.body.settings.disclosureAckVersion, 'disclosure@0.1.0');
    const created = await call(api.url, 'POST', '/api/sessions', {});
    assert.equal(created.status, 201);
    assert.match(created.body.sid, /^s-/);
    assert.equal(created.body.snapshot.toggles.saveHistory, true);
    assert.equal(created.body.snapshot.toggles.saveAudio, true);
  } finally {
    await api.close();
    rmSync(api.dataDir, { recursive: true, force: true });
  }
});

test('统一错误响应与输入校验：400/404/409 都是同一形状', async () => {
  const api = await boot('errors');
  try {
    await call(api.url, 'PATCH', '/api/settings', { disclosureAck: true });
    const created = await call(api.url, 'POST', '/api/sessions', {});
    const sid = created.body.sid as string;

    const unknownRoute = await call(api.url, 'GET', '/api/nope');
    assert.equal(unknownRoute.status, 404);
    assert.equal(unknownRoute.body.error.code, 'E_NOT_FOUND');

    const unknownSession = await call(api.url, 'GET', '/api/sessions/s-nope');
    assert.equal(unknownSession.status, 404);

    const badStage = await call(api.url, 'POST', `/api/sessions/${sid}/materials`, { ...MATERIALS, stage: '实习' });
    assert.equal(badStage.status, 400);
    assert.equal(badStage.body.error.code, 'E_VALIDATION');

    const shortJd = await call(api.url, 'POST', `/api/sessions/${sid}/materials`, { ...MATERIALS, jd: '太短' });
    assert.equal(shortJd.status, 400);

    const badPage = await call(api.url, 'GET', '/api/sessions?limit=1000');
    assert.equal(badPage.status, 400);
    assert.equal(badPage.body.error.code, 'E_VALIDATION');

    const badJson = await fetch(`${api.url}/api/sessions/${sid}/materials`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    assert.equal(badJson.status, 400);
    const badJsonBody = (await badJson.json()) as { error: { code: string } };
    assert.equal(badJsonBody.error.code, 'E_BAD_REQUEST');
  } finally {
    await api.close();
    rmSync(api.dataDir, { recursive: true, force: true });
  }
});

test('HTTP + WS 全链路：三题闭环、音频下行、暂停拒收、打断、回放下载、删除前后对照', async () => {
  const api = await boot('flow', {
    text: { followups: [{ need: true, question: '你刚才说的分工，具体是怎么安排的？' }] },
    realtime: {
      audioChunks: 3,
      transcripts: [
        '我在毕业季征稿活动里负责整体策划，联系了五个院系宣传委员，活动收到 143 篇投稿。',
        '追问：我负责联系院系宣传委员，并写了两篇范文。',
        '我负责范文撰写和渠道扩散，投稿量比上一期增长约八成。',
        '遇到的问题是宣传委员只发了一次通知，我加了二次触达写进 SOP。',
      ],
    },
  });
  try {
    await call(api.url, 'PATCH', '/api/settings', { disclosureAck: true });
    const created = await call(api.url, 'POST', '/api/sessions', { synthetic: true });
    const sid = created.body.sid as string;
    const { ws, messages, waitFor } = await openWs(api.url, sid);
    try {
      await call(api.url, 'POST', `/api/sessions/${sid}/materials`, MATERIALS);
      // 面试官音频经服务端转发到浏览器
      const audio = await waitFor((m) => m.type === 'interviewer.audio', '面试官音频');
      assert.equal(audio.sampleRate, 24000);
      assert.equal(audio.format, 'pcm16');
      assert.ok(Buffer.from(audio.audio, 'base64').length > 0);

      // 追问链路：回答 → 追问音频 → 再回答
      await call(api.url, 'POST', `/api/sessions/${sid}/answer/start`);
      for (let i = 0; i < 3; i++) ws.send(JSON.stringify({ type: 'audio.append', audio: PCM.toString('base64') }));
      const ack = await waitFor((m) => m.type === 'audio.ack', '音频回执');
      assert.equal(ack.bytes, PCM.length);
      const afterFirst = await call(api.url, 'POST', `/api/sessions/${sid}/answer/done`);
      assert.equal(afterFirst.body.snapshot.state, 'followup');
      assert.equal(afterFirst.body.snapshot.machine.followupCount, 1);

      await call(api.url, 'POST', `/api/sessions/${sid}/answer/start`);
      ws.send(JSON.stringify({ type: 'audio.append', audio: PCM.toString('base64') }));
      const afterFollowup = await call(api.url, 'POST', `/api/sessions/${sid}/answer/done`);
      assert.equal(afterFollowup.body.snapshot.state, 'rewrite');
      assert.ok(afterFollowup.body.snapshot.reviews.q1, '应产出第 1 题反馈');

      // 打断
      const interrupted = await call(api.url, 'POST', `/api/sessions/${sid}/interrupt`);
      assert.equal(interrupted.body.interrupt.clearedPending, true);

      // 第 2 题：作答中暂停 → 上行被服务端拒收；恢复后继续
      const q2 = await call(api.url, 'POST', `/api/sessions/${sid}/next`);
      assert.equal(q2.body.snapshot.state, 'answer');
      await call(api.url, 'POST', `/api/sessions/${sid}/answer/start`);
      ws.send(JSON.stringify({ type: 'audio.append', audio: PCM.toString('base64') }));
      await call(api.url, 'POST', `/api/sessions/${sid}/pause`);
      ws.send(JSON.stringify({ type: 'audio.append', audio: PCM.toString('base64') }));
      const pausedErr = await waitFor((m) => m.type === 'error' && m.error?.code === 'E_UPLINK_PAUSED', '暂停拒收');
      assert.match(pausedErr.error.message, /暂停/);
      await call(api.url, 'POST', `/api/sessions/${sid}/resume`);
      ws.send(JSON.stringify({ type: 'audio.append', audio: PCM.toString('base64') }));
      await call(api.url, 'POST', `/api/sessions/${sid}/answer/done`);
      // 第 3 题
      await call(api.url, 'POST', `/api/sessions/${sid}/next`);
      await call(api.url, 'POST', `/api/sessions/${sid}/answer/start`);
      ws.send(JSON.stringify({ type: 'audio.append', audio: PCM.toString('base64') }));
      const afterThird = await call(api.url, 'POST', `/api/sessions/${sid}/answer/done`);
      assert.equal(afterThird.body.snapshot.state, 'rewrite');
      const final = await call(api.url, 'POST', `/api/sessions/${sid}/next`);
      assert.equal(final.body.snapshot.state, 'ended');
      assert.equal(final.body.snapshot.report.completedQuestions, 3);
      assert.equal(final.body.snapshot.report.sessionStatus, 'completed');
      assert.ok(final.body.snapshot.report.priorityPractice.length >= 1);
      assert.equal(final.body.snapshot.reviewBasis.q1.questionId, 'q1');
      assert.deepEqual(final.body.snapshot.reviewBasis.q1.turnIds, final.body.snapshot.reviews.q1.reviewBasis.turnIds);

      // 服务端 → 浏览器的任何消息都不含凭证或 sk- 模式
      const dump = JSON.stringify(messages);
      assert.equal(dump.includes('sk-test-not-a-real-key'), false, 'WS 消息不得带凭证');
      assert.equal(/sk-[A-Za-z0-9._-]{12,}/.test(dump), false);

      // 回放：两轨都能下载
      const detail = await call(api.url, 'GET', `/api/sessions/${sid}`);
      assert.equal(detail.body.reportSource, final.body.snapshot.reportSource);
      assert.deepEqual(detail.body.reviewMeta, final.body.snapshot.reviewMeta);
      const q1Feedback = detail.body.reviews.q1;
      const q1Basis = detail.body.reviewBasis.q1;
      assert.equal(q1Basis.questionId, 'q1');
      assert.deepEqual(q1Basis.turnIds, q1Feedback.reviewBasis.turnIds);
      assert.equal(q1Basis.textVersion, q1Feedback.reviewBasis.textVersion);
      const turnById = new Map(detail.body.turns.map((turn: any) => [turn.id, turn]));
      const expectedBasisText = q1Basis.turnIds
        .map((turnId: string) => {
          const turn = turnById.get(turnId) as any;
          return turn.revisedText ?? turn.rawTranscript;
        })
        .join('\n');
      assert.equal(q1Basis.text, expectedBasisText, '详情应返回服务端权威重建的评审基准文本');
      const userTurn = detail.body.turns.find((t: any) => t.speaker === 'user');
      const interviewerTurn = detail.body.turns.find((t: any) => t.speaker === 'interviewer');
      const userAudio = await fetch(`${api.url}/api/sessions/${sid}/turns/${userTurn.id}/audio/user`);
      assert.equal(userAudio.status, 200);
      assert.equal(userAudio.headers.get('content-type'), 'audio/wav');
      assert.equal(userAudio.headers.get('x-audio-source'), 'file');
      const wav = Buffer.from(await userAudio.arrayBuffer());
      assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
      const interviewerAudio = await fetch(`${api.url}/api/sessions/${sid}/turns/${interviewerTurn.id}/audio/interviewer`);
      assert.equal(interviewerAudio.status, 200);

      // 删除前后对照
      const del = await call(api.url, 'DELETE', `/api/sessions/${sid}`);
      assert.equal(del.status, 200);
      assert.equal(del.body.before.rows.sessions, 1);
      assert.ok(del.body.before.rows.turns > 0);
      assert.ok(del.body.before.audioFiles.length > 0);
      assert.equal(del.body.after.rows.sessions, 0);
      assert.equal(del.body.after.audioFiles.length, 0);
      assert.equal(del.body.verified, true);
      const afterDelete = await call(api.url, 'GET', `/api/sessions/${sid}`);
      assert.equal(afterDelete.status, 404);
      const list = await call(api.url, 'GET', '/api/sessions');
      assert.equal(list.body.total, 0);
    } finally {
      ws.close();
    }
  } finally {
    await api.close();
    rmSync(api.dataDir, { recursive: true, force: true });
  }
});

test('两开关：关历史不落库不落音频；关录音落库但不落音频文件', async () => {
  const api = await boot('toggles', { realtime: { transcripts: ['我负责策划与落地，收到 143 篇投稿。', '我负责渠道扩散，联系了五个院系。'] } });
  try {
    await call(api.url, 'PATCH', '/api/settings', { disclosureAck: true });
    // 关历史
    const offHistory = await call(api.url, 'POST', '/api/sessions', { saveHistory: false });
    const sidOff = offHistory.body.sid as string;
    await call(api.url, 'POST', `/api/sessions/${sidOff}/materials`, MATERIALS);
    await call(api.url, 'POST', `/api/sessions/${sidOff}/answer/start`);
    await call(api.url, 'POST', `/api/sessions/${sidOff}/answer/done`);
    const listAfterOff = await call(api.url, 'GET', '/api/sessions');
    assert.equal(listAfterOff.body.total, 0, '关历史不该产生持久记录');
    const detailOff = await call(api.url, 'GET', `/api/sessions/${sidOff}`);
    assert.equal(detailOff.body.persisted, false);
    assert.equal(detailOff.body.toggles.saveHistory, false);

    // 关录音
    const offAudio = await call(api.url, 'POST', '/api/sessions', { saveAudio: false });
    const sidNoAudio = offAudio.body.sid as string;
    await call(api.url, 'POST', `/api/sessions/${sidNoAudio}/materials`, MATERIALS);
    await call(api.url, 'POST', `/api/sessions/${sidNoAudio}/answer/start`);
    await call(api.url, 'POST', `/api/sessions/${sidNoAudio}/answer/done`);
    const detailNoAudio = await call(api.url, 'GET', `/api/sessions/${sidNoAudio}`);
    assert.equal(detailNoAudio.body.toggles.saveAudio, false);
    const stats = await call(api.url, 'GET', '/api/stats');
    assert.equal(stats.body.stats.audioFiles, 0, '关录音后磁盘上不该有音频文件');
    // 未保存录音时下载给出明确 404，而不是空文件
    const userTurn = detailNoAudio.body.turns.find((t: any) => t.speaker === 'user');
    const audioRes = await fetch(`${api.url}/api/sessions/${sidNoAudio}/turns/${userTurn.id}/audio/user`);
    assert.equal(audioRes.status, 404);
  } finally {
    await api.close();
    rmSync(api.dataDir, { recursive: true, force: true });
  }
});

test('材料上传：DOCX 走内部解析器；扫描件 PDF 返回 422 并提示改粘贴', async () => {
  const api = await boot('upload');
  try {
    await call(api.url, 'PATCH', '/api/settings', { disclosureAck: true });
    const created = await call(api.url, 'POST', '/api/sessions', {});
    const sid = created.body.sid as string;
    const pdf = Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n3 0 obj << >>\nstream\nq 0 0 595 842 re f\nendstream\nendobj\n%%EOF\n`, 'latin1');
    const res = await fetch(`${api.url}/api/sessions/${sid}/materials/upload?filename=scan.pdf`, { method: 'POST', body: pdf });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: { code: string; hint: string } };
    assert.equal(body.error.code, 'E_PARSE_FAILED');
    assert.match(body.error.hint, /粘贴/);
  } finally {
    await api.close();
    rmSync(api.dataDir, { recursive: true, force: true });
  }
});

test('麦克风拒绝上报：落到明确状态且可结束', async () => {
  const api = await boot('mic');
  try {
    await call(api.url, 'PATCH', '/api/settings', { disclosureAck: true });
    const created = await call(api.url, 'POST', '/api/sessions', {});
    const sid = created.body.sid as string;
    await call(api.url, 'POST', `/api/sessions/${sid}/materials`, MATERIALS);
    const denied = await call(api.url, 'POST', `/api/sessions/${sid}/mic-denied`, { detail: 'NotAllowedError' });
    assert.equal(denied.body.snapshot.lastError.code, 'E_MIC_DENIED');
    assert.equal(denied.body.snapshot.state, 'answer');
    const ended = await call(api.url, 'POST', `/api/sessions/${sid}/end`);
    assert.equal(ended.body.snapshot.state, 'ended');
    assert.deepEqual(ended.body.snapshot.report.priorityPractice, ['本次未完成任何题目，无有效反馈']);
  } finally {
    await api.close();
    rmSync(api.dataDir, { recursive: true, force: true });
  }
});

test('重启后：历史会话可读、可回放，但不能再继续作答（409）', async () => {
  const dataDir = path.join(REPO_ROOT, 'data', `web-test-restart-${Date.now().toString(36)}`);
  mkdirSync(dataDir, { recursive: true });
  const first = await boot('restart-1', { dataDir, realtime: { transcripts: ['我负责策划与落地，收到 143 篇投稿。'] } });
  let sid = '';
  try {
    await call(first.url, 'PATCH', '/api/settings', { disclosureAck: true });
    const created = await call(first.url, 'POST', '/api/sessions', {});
    sid = created.body.sid as string;
    await call(first.url, 'POST', `/api/sessions/${sid}/materials`, MATERIALS);
    const conn = await openWs(first.url, sid);
    await call(first.url, 'POST', `/api/sessions/${sid}/answer/start`);
    conn.ws.send(JSON.stringify({ type: 'audio.append', audio: PCM.toString('base64') }));
    await conn.waitFor((m) => m.type === 'audio.ack', '音频回执');
    await call(first.url, 'POST', `/api/sessions/${sid}/answer/done`);
    const ended = await call(first.url, 'POST', `/api/sessions/${sid}/end`);
    assert.equal(ended.status, 200);
    assert.ok(ended.body.snapshot.reportSource);
    assert.ok(ended.body.snapshot.reviewMeta.length > 0);
    conn.ws.close();
    assert.equal((await call(first.url, 'GET', '/api/sessions')).body.total, 1);
  } finally {
    await first.close();
  }
  const second = await boot('restart-2', { dataDir });
  try {
    const list = await call(second.url, 'GET', '/api/sessions');
    assert.equal(list.body.total, 1, '重启后历史仍在');
    const detail = await call(second.url, 'GET', `/api/sessions/${sid}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.live, false);
    assert.ok(detail.body.reportSource, '报告来源必须跨重启保留');
    assert.ok(detail.body.reviewMeta.length > 0, '评审审计元数据必须跨重启保留');
    assert.equal(detail.body.reviewBasis.q1.questionId, 'q1');
    assert.deepEqual(detail.body.reviewBasis.q1.turnIds, detail.body.reviews.q1.reviewBasis.turnIds);
    assert.ok(detail.body.turns.length >= 2, '轮次可从库里读回');
    const userTurn = detail.body.turns.find((t: any) => t.speaker === 'user');
    assert.equal(userTurn.audio.user, true, '重启后录音仍可回放');
    const audio = await fetch(`${second.url}/api/sessions/${sid}/turns/${userTurn.id}/audio/user`);
    assert.equal(audio.status, 200);
    const resume = await call(second.url, 'POST', `/api/sessions/${sid}/answer/start`);
    assert.equal(resume.status, 409);
    assert.equal(resume.body.error.code, 'E_CONFLICT');
    // 历史会话仍可显式删除
    const del = await call(second.url, 'DELETE', `/api/sessions/${sid}`);
    assert.equal(del.body.verified, true);
  } finally {
    await second.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('/harness 提供验收用最小客户端，并显式声明不是产品界面', async () => {
  const api = await boot('harness');
  try {
    const res = await fetch(`${api.url}/harness`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /不是产品界面/);
    assert.match(html, /__webDriver/);
    const root = await call(api.url, 'GET', '/');
    assert.equal(root.status, 200);
    assert.match(root.body.note, /服务端与数据层/);
  } finally {
    await api.close();
    rmSync(api.dataDir, { recursive: true, force: true });
  }
});

test('产品构建产物由后端同源托管：静态资源与 SPA 回退可用，且不添加 CORS', async () => {
  const staticDir = path.join(REPO_ROOT, 'data', `web-test-static-${Date.now().toString(36)}`);
  mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
  writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><html><body>欧八面试陪练</body></html>');
  writeFileSync(path.join(staticDir, 'assets', 'app.js'), 'globalThis.__OUBA_APP__ = true;');
  const api = await boot('static', { staticDir });
  try {
    const root = await fetch(`${api.url}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(root.headers.get('access-control-allow-origin'), null, '同源托管不应放开 CORS');
    assert.match(await root.text(), /欧八面试陪练/);

    const asset = await fetch(`${api.url}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') ?? '', /javascript/);
    assert.match(await asset.text(), /__OUBA_APP__/);

    const spa = await fetch(`${api.url}/reports/s-example`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /欧八面试陪练/);

    const unknownApi = await call(api.url, 'GET', '/api/nope');
    assert.equal(unknownApi.status, 404, 'SPA 回退不能吞掉未知 API');
    assert.equal(unknownApi.body.error.code, 'E_NOT_FOUND');
    const apiRoot = await call(api.url, 'GET', '/api');
    assert.equal(apiRoot.status, 404, 'SPA 回退也不能吞掉精确的 /api 命名空间根');
    assert.equal(apiRoot.body.error.code, 'E_NOT_FOUND');
  } finally {
    await api.close();
    rmSync(api.dataDir, { recursive: true, force: true });
    rmSync(staticDir, { recursive: true, force: true });
  }
});
