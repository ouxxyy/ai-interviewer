/**
 * T2 新增护栏的离线单测（不联网、不调模型）。
 *
 * 覆盖两件在 T1-R 复核里被点出来的事：
 * 1. 实时音色必须**前置断言**——服务端自报默认 `Chelsie` 实际被拒，且同一连接撞 400 后不会自愈，
 *    所以在发首个 `response.create` 之前就必须拦住（`injectText` 拒绝）。
 * 2. 延迟统计的失败面必须区分「抛异常/不合规」与「契约内降级」，不能合成一个 0。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DashscopeRealtimeClient, REALTIME_DEFAULTS, SUPPORTED_VOICES } from '../src/clients/realtime-dashscope.js';
import { countFailures, deriveOutcome } from '../src/t1r/latency.js';

test('音色前置断言未通过时，injectText 直接拒绝（不发任何 response.create）', () => {
  const client = new DashscopeRealtimeClient('dummy-credential-value');
  assert.equal(client.isVoiceAsserted, false);
  assert.throws(() => client.injectText('请朗读这一句'), /音色前置断言未通过/);
  client.close();
});

test('默认音色写死为 Serena，且白名单里 Chelsie 明确标为不可用', () => {
  assert.equal(REALTIME_DEFAULTS.defaultVoice, 'Serena');
  assert.equal(SUPPORTED_VOICES.Serena, true);
  assert.equal(SUPPORTED_VOICES.Chelsie, false, '服务端自报默认音色实测被 400 拒，白名单必须标 false');
  const client = new DashscopeRealtimeClient('dummy-credential-value');
  assert.equal(client.expectedVoice, 'Serena');
  assert.equal(new DashscopeRealtimeClient('d', { voice: 'Katerina' }).expectedVoice, 'Katerina');
  client.close();
});

test('脱敏载荷不泄露凭证值（session-config 证据的防线）', () => {
  const client = new DashscopeRealtimeClient('sk-abcdefghijklmnop');
  client.sessionCreatedPayload = { voice: 'Chelsie', note: 'sk-abcdefghijklmnop' };
  client.sessionUpdatedPayload = { voice: 'Serena' };
  const redacted = client.redactedSessionPayloads();
  const text = JSON.stringify(redacted);
  assert.equal(text.includes('sk-abcdefghijklmnop'), false, '凭证值必须被抹掉');
  assert.match(text, /<redacted/);
  assert.equal(redacted.expectedVoice, 'Serena');
  client.close();
});

test('延迟失败面：抛异常与契约内降级分开计数', () => {
  const samples = [
    { ok: true, attempts: 1 },
    { ok: true, attempts: 2 },
    { ok: false, attempts: 2 }, // 重试耗尽 → 降级
    { ok: false, attempts: 0 }, // 调用层抛异常
  ];
  assert.deepEqual(countFailures(samples), { exceptions: 1, degraded: 1 });
  // 显式 outcome 优先于推导
  assert.deepEqual(countFailures([{ ok: false, attempts: 0, outcome: 'degraded' }]), { exceptions: 0, degraded: 1 });
  assert.equal(deriveOutcome({ ok: true, attempts: 1 }), 'ok');
  assert.equal(deriveOutcome({ ok: false, attempts: 3 }), 'degraded');
  assert.equal(deriveOutcome({ ok: false, attempts: 0 }), 'exception');
});
