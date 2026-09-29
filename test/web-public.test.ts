import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { startServer } from '../src/web/cli.js';
import { Logger } from '../src/web/log.js';
import { DashscopeTextClient } from '../src/clients/dashscope.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

test('public: cookie bootstrap, per-visitor keys/settings/history, ownership across every route and restart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'interview-public-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const options = { port, dataDir: root, publicMode: true, publicOrigin: origin, credentialEnv: { DASHSCOPE_API_KEY: 'sk-global-must-never-be-shared' }, logger: new Logger(line => logs.push(line)) };
  let app = await startServer(options);
  const call = async (cookie: string, route: string, method = 'GET', body?: unknown, more: Record<string, string> = {}) => {
    const res = await fetch(origin + route, { method, headers: { Cookie: cookie, Origin: origin, Connection: 'close', 'Content-Type': 'application/json', ...more }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any, cookie: res.headers.get('set-cookie') };
  };
  const keyA = 'sk-public-test-visitor-aaaaaaaa';
  const keyB = 'sk-public-test-visitor-bbbbbbbb';
  try {
    for (const route of ['/api/health', '/api/settings', '/api/stats', '/api/model-config', '/api/sessions']) assert.equal((await call('', route)).status, 401);
    assert.equal((await call('', '/api/sessions', 'POST', {})).status, 401);
    assert.equal((await call('', '/api/bootstrap', 'GET', undefined, { Origin: 'https://evil.test' })).status, 403);
    const a = await call('', '/api/bootstrap');
    const b = await call('', '/api/bootstrap');
    assert.match(a.cookie!, /HttpOnly; SameSite=Strict/);
    assert.equal(a.body.mode.keyConfigured, false);
    const ca = a.cookie!.split(';')[0]!;
    const cb = b.cookie!.split(';')[0]!;
    assert.notEqual(ca, cb);
    assert.equal((await call(ca, '/api/bootstrap')).cookie, null);
    const confA = (await call(ca, '/api/model-config')).body;
    const confB = (await call(cb, '/api/model-config')).body;
    assert.equal(confA.configured, false);
    assert.notEqual(confA.configToken, confB.configToken);
    assert.equal((await call(cb, '/api/model-config', 'PATCH', { apiKey: keyB }, { 'X-Config-Token': confA.configToken })).status, 403);
    for (const [cookie, key, config] of [[ca, keyA, confA], [cb, keyB, confB]] as const) {
      const updated = await call(cookie, '/api/model-config', 'PATCH', { apiKey: key }, { 'X-Config-Token': config.configToken });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.configured, true);
      assert.equal(updated.body.storage, 'visitor-encrypted');
      assert.ok(!JSON.stringify(updated.body).includes(key));
    }
    assert.equal((await call(ca, '/api/settings', 'PATCH', { answerStartMode: 'manual', disclosureAck: true })).status, 200);
    assert.equal((await call(cb, '/api/settings')).body.settings.answerStartMode, 'continuous');
    assert.equal((await call(cb, '/api/settings')).body.needsDisclosure, true);
    assert.equal((await call(ca, '/api/settings', 'PATCH', { saveHistory: false }, { Origin: 'https://evil.test' })).status, 403);
    const created = await call(ca, '/api/sessions', 'POST', { synthetic: false, disclosureAck: true });
    assert.equal(created.status, 201);
    const sid = created.body.sid;
    assert.equal((await call(ca, '/api/sessions')).body.total, 1);
    assert.equal((await call(cb, '/api/sessions')).body.total, 0);
    assert.equal((await call(cb, '/api/stats')).body.stats.real, 0);
    for (const [method, suffix] of [['GET', ''], ['GET', '/snapshot'], ['DELETE', ''], ['POST', '/materials'], ['POST', '/materials/upload'], ['POST', '/review'], ['POST', '/turns/t1/revise'], ['GET', '/turns/t1/audio/user']] as const) {
      assert.equal((await call(cb, `/api/sessions/${sid}${suffix}`, method, method === 'POST' ? {} : undefined)).status, 404);
    }
    const rejectWs = (cookie: string, expected: number, requestOrigin = origin) => new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${origin.replace('http', 'ws')}/realtime?sid=${sid}`, { headers: { Cookie: cookie, Origin: requestOrigin } });
      ws.on('unexpected-response', (_req, res) => { try { assert.equal(res.statusCode, expected); res.resume(); ws.terminate(); resolve(); } catch (e) { reject(e); } });
      ws.on('open', () => { ws.close(); reject(new Error('unauthorized WS opened')); });
      ws.on('error', () => {});
    });
    await rejectWs('', 401);
    await rejectWs(cb, 404);
    await rejectWs(ca, 403, 'https://evil.test');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${origin.replace('http', 'ws')}/realtime?sid=${sid}`, { headers: { Cookie: ca, Origin: origin } });
      ws.on('message', data => { try { assert.equal(JSON.parse(String(data)).type, 'state'); ws.close(); resolve(); } catch (e) { reject(e); } });
      ws.on('error', reject);
    });
    assert.equal((await call('', '/harness')).status, 404);
    const noHistory = await call(ca, '/api/sessions', 'POST', { synthetic: false, saveHistory: false });
    assert.equal((await call(cb, `/api/sessions/${noHistory.body.sid}`)).status, 404);
    assert.equal((await call(ca, `/api/sessions/${noHistory.body.sid}`)).body.persisted, false);
    await app.close();
    const registry = readFileSync(path.join(root, 'public/visitors.sqlite'));
    assert.ok(!registry.includes(Buffer.from(keyA)) && !registry.includes(Buffer.from(keyB)));
    assert.ok(!registry.includes(Buffer.from(ca.split('=')[1]!)));
    app = await startServer(options);
    assert.equal((await call(ca, '/api/model-config')).body.configured, true);
    assert.equal((await call(cb, '/api/model-config')).body.configured, true);
    assert.equal((await call(ca, `/api/sessions/${sid}`)).status, 200);
    assert.equal((await call(cb, `/api/sessions/${sid}`)).status, 404);
    assert.equal((await call(ca, '/api/settings')).body.settings.answerStartMode, 'manual');
    assert.equal(readdirSync(path.join(root, 'public/visitors')).length, 2);
    assert.equal((await call(ca, `/api/sessions/${sid}`, 'DELETE')).status, 200);
    assert.equal((await call(ca, '/api/sessions')).body.total, 0);
    assert.ok(!logs.join('').includes(keyA));
    assert.ok(!logs.join('').includes(ca.split('=')[1]!));
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('text client injected credentials isolate concurrent visitors without changing global environment', async () => {
  const received: string[] = [];
  const server = createServer((req, res) => {
    received.push(req.headers.authorization ?? '');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const a = new DashscopeTextClient({ baseUrl, credential: () => 'visitor-a' });
    const b = new DashscopeTextClient({ baseUrl, credential: () => 'visitor-b' });
    await Promise.all([a.complete({ prompt: 'test' }), b.complete({ prompt: 'test' })]);
    assert.deepEqual(received.sort(), ['Bearer visitor-a', 'Bearer visitor-b']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
