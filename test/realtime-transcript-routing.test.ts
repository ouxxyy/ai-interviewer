import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DashscopeRealtimeClient } from '../src/clients/realtime-dashscope.js';

type EventDriver = {
  handleEvent(event: Record<string, unknown>): void;
  send(event: Record<string, unknown>): void;
};

test('实时转写路由：面试官朗读不能进入用户回答，用户 ASR 才能进入', () => {
  const client = new DashscopeRealtimeClient('test-credential', { requireVoiceAssertion: false });
  const received: Array<{ text: string; final: boolean }> = [];
  client.onTranscript((text, final) => received.push({ text, final }));
  const driver = client as unknown as EventDriver;

  driver.handleEvent({ type: 'response.audio_transcript.delta', delta: '请讲一次' });
  driver.handleEvent({ type: 'response.audio_transcript.done', transcript: '请讲一次具体经历。' });
  assert.deepEqual(received, [], '面试官问题不能冒充用户回答显示');

  driver.handleEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: '我负责' });
  driver.handleEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: '我负责协调两个团队。' });
  assert.deepEqual(received, [
    { text: '我负责', final: false },
    { text: '我负责协调两个团队。', final: true },
  ]);
});

test('实时转写路由：兼容当前 text + stash 预览，完成事件空串不得覆盖已识别文本', async () => {
  const client = new DashscopeRealtimeClient('test-credential', { requireVoiceAssertion: false });
  const received: Array<{ text: string; final: boolean }> = [];
  client.onTranscript((text, final) => received.push({ text, final }));
  const driver = client as unknown as EventDriver;
  const pending = client.waitForUserTranscript(200);

  driver.handleEvent({ type: 'conversation.item.input_audio_transcription.delta', text: '', stash: '我负责' });
  driver.handleEvent({ type: 'conversation.item.input_audio_transcription.delta', text: '我负责', stash: '协调两个团队' });
  driver.handleEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: '' });

  assert.deepEqual(await pending, { transcript: '我负责协调两个团队', latencyMs: 0 });
  assert.deepEqual(received, [
    { text: '我负责', final: false },
    { text: '我负责协调两个团队', final: false },
    { text: '我负责协调两个团队', final: true },
  ]);
});

test('实时转写路由：上游转写失败必须立即失败，不等到超时或冒充空转写', async () => {
  const client = new DashscopeRealtimeClient('test-credential', { requireVoiceAssertion: false });
  const driver = client as unknown as EventDriver;
  const pending = client.waitForUserTranscript(200);

  driver.handleEvent({
    type: 'conversation.item.input_audio_transcription.failed',
    error: { code: 'asr_failed', message: '输入音频转写失败', param: 'input_audio' },
  });

  await assert.rejects(pending, /输入音频转写失败/);
});

test('会话配置：直接 WebSocket 使用嵌套转写字段，不发送 SDK 参数名', async () => {
  const client = new DashscopeRealtimeClient('test-credential', { requireVoiceAssertion: false });
  const driver = client as unknown as EventDriver;
  driver.handleEvent({
    type: 'session.created',
    session: {
      id: 'session-1',
      model: 'qwen3.8-omni-flash-realtime',
      voice: 'Maia',
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm24',
      turn_detection: null,
    },
  });
  const sent: Record<string, unknown>[] = [];
  driver.send = (event) => {
    sent.push(event);
    queueMicrotask(() => driver.handleEvent({ type: 'session.updated', session: (event.session ?? {}) as Record<string, unknown> }));
  };

  await client.updateSession();

  const session = sent[0]?.session as Record<string, unknown>;
  assert.deepEqual(session.input_audio_transcription, { model: 'qwen3-asr-flash-realtime' });
  assert.equal('enable_input_audio_transcription' in session, false);
  assert.equal('input_audio_transcription_model' in session, false);
});

test('提交回答保留提交前的 ASR 预览，下一轮空回答不能复用上一轮', async () => {
  const client = new DashscopeRealtimeClient('test-credential', { requireVoiceAssertion: false });
  const driver = client as unknown as EventDriver;
  driver.send = () => undefined;
  driver.handleEvent({ type: 'conversation.item.input_audio_transcription.delta', text: '我负责', stash: '协调两个团队' });
  const pending = client.waitForUserTranscript(200);
  client.commitAudio();
  driver.handleEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: '' });
  assert.equal((await pending).transcript, '我负责协调两个团队');

  const next = client.waitForUserTranscript(200);
  client.commitAudio();
  driver.handleEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: '' });
  assert.equal((await next).transcript, '', '上一轮文字不能冒充下一轮回答');
});
