import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DashscopeRealtimeClient } from '../src/clients/realtime-dashscope.js';

type EventDriver = { handleEvent(event: Record<string, unknown>): void };

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
