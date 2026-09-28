/**
 * 实时桥测试（离线，mock DashScope 客户端）：
 * - 音色前置断言失败 → **新开连接**（不在旧连接上自愈）；
 * - 朗读撞 400 → 丢弃被污染的连接、新开一条并只重放一次那句话；
 * - 暂停期间拒收上行音频；
 * - 打断后不再向浏览器转发旧回应的音频分片；
 * - 浏览器侧音频是边收边转（不是等 response.done 才一次性给）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeBridge } from '../src/web/realtime-bridge.js';
import { Logger } from '../src/web/log.js';
import { MockRealtimeClient, type MockRealtimeScript } from './helpers/web-mocks.js';

function bridge(script: MockRealtimeScript, sinks?: { audio?: (chunk: Buffer, seq: number) => void }): { bridge: RealtimeBridge; clients: MockRealtimeClient[] } {
  const logger = new Logger(() => {}, 'error');
  const b = new RealtimeBridge({
    credential: 'sk-test-not-a-real-key-000000',
    logger,
    createClient: () => new MockRealtimeClient(script),
    ...(sinks?.audio === undefined ? {} : { onInterviewerAudio: sinks.audio }),
  });
  return { bridge: b, clients: MockRealtimeClient.instances };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test.beforeEach(() => {
  MockRealtimeClient.instances = [];
});

test('音色前置断言失败 → 丢弃旧连接、新开一条；成功那次的生效音色来自 session.updated', async () => {
  const { bridge: b, clients } = bridge({ openFailures: 1 });
  const { session, reconnects } = await b.ensureOpen('s1');
  assert.equal(clients.length, 2, '必须新开连接，而不是在旧连接上重试');
  assert.equal(clients[0]!.closed, true, '失败的连接必须关掉');
  assert.equal(session.updated?.voice, 'Maia');
  assert.equal(b.stats.connections, 1);
  assert.equal(reconnects, 1);
});

test('两次都断言失败：明确抛错，不静默继续', async () => {
  const { bridge: b, clients } = bridge({ openFailures: 5 });
  await assert.rejects(() => b.ensureOpen('s1'), /实时连接建立失败/);
  assert.equal(clients.length, 2);
  assert.equal(b.stats.connections, 0);
});

test('朗读撞 400 → 新开连接并只重放一次（同连接不自愈）', async () => {
  const received: Buffer[] = [];
  const { bridge: b, clients } = bridge({ speak400: 1, audioChunks: 2 }, { audio: (chunk) => received.push(chunk) });
  const result = await b.speak('请介绍你在征稿活动里的具体分工。');
  assert.equal(clients.length, 2, '被 400 污染的连接必须换掉');
  assert.equal(clients[0]!.injectCount, 1);
  assert.equal(clients[1]!.injectCount, 1, '同一句话只重放一次');
  assert.equal(result.transcript, '请介绍你在征稿活动里的具体分工。');
  assert.equal(result.audioPcm.length, 960);
  assert.equal(received.length, 2, '音频分片要在生成过程中就转给浏览器');
  assert.equal(b.stats.reconnects, 1);
});

test('并发：400 之后 ensureOpen 会自动重建连接（不需要调用方特殊处理）', async () => {
  const { bridge: b, clients } = bridge({ speak400: 1 });
  await b.speak('第一句');
  const before = clients.length;
  await b.speak('第二句');
  assert.equal(clients.length, before, '第二次朗读沿用已重建的连接，不该再换');
  assert.equal(b.stats.connections, 2);
});

test('暂停：上行音频被明确拒绝，恢复后继续收', async () => {
  const { bridge: b } = bridge({});
  await b.ensureOpen('s1');
  assert.deepEqual(b.appendUserAudio(Buffer.alloc(3200)), { accepted: true });
  b.pause();
  const rejected = b.appendUserAudio(Buffer.alloc(3200));
  assert.deepEqual(rejected, { accepted: false, reason: 'paused' });
  assert.equal(b.stats.pausedRejections, 1);
  assert.equal(b.stats.audioBytesIn, 3200, '暂停期间一个字节都不该上行');
  b.resume();
  assert.deepEqual(b.appendUserAudio(Buffer.alloc(1600)), { accepted: true });
  assert.equal(b.stats.audioBytesIn, 4800);
});

test('打断：取消后旧回应的分片不再转发给浏览器，状态为 cancelled', async () => {
  const received: Buffer[] = [];
  const { bridge: b } = bridge({ audioChunks: 8, chunkDelayMs: 25 }, { audio: (chunk) => received.push(chunk) });
  const pending = b.speak('这是一段很长的问题，用来验证打断。');
  await sleep(80);
  const before = received.length;
  b.cancel();
  const result = await pending;
  const stats = b.cancelStats;
  assert.ok(before >= 1, '打断前应该已经收到分片');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cancelled, true);
  assert.ok(stats.deltasAfterCancel >= 1, '取消之后服务端仍可能推来分片，桥必须丢弃它们');
  assert.equal(received.length, before, '浏览器不应再收到取消后的分片');
  assert.equal(b.stats.cancels, 1);
});

test('空转写：桥如实返回空串，不伪造内容', async () => {
  const { bridge: b } = bridge({ transcripts: [''] });
  await b.ensureOpen('s1');
  const commit = await b.commitUserAudio();
  assert.equal(commit.empty, true);
  assert.equal(commit.transcript, '');
});

test('转写与音频下沉都只走回调，桥本身不打印内容', async () => {
  const lines: string[] = [];
  const logger = new Logger((line) => lines.push(line), 'debug');
  const b = new RealtimeBridge({
    credential: 'sk-test-not-a-real-key-000000',
    logger,
    createClient: () => new MockRealtimeClient({ transcripts: ['这是一段很长的用户回答，用来验证日志不会记录完整转写内容。'] }),
  });
  await b.ensureOpen('s1');
  await b.commitUserAudio();
  const joined = lines.join('\n');
  assert.equal(joined.includes('这是一段很长的用户回答'), false, '日志不得记录完整转写');
  assert.equal(joined.includes('sk-test-not-a-real-key'), false, '日志不得记录凭证');
});
