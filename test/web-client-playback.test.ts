/**
 * 下行播放队列回归测试（P2-2）。
 *
 * 被打回的现象：暂停用 stop() 丢掉当前播放 buffer，恢复只从下一段开始，
 * 于是每次暂停都会吞掉当前这一段的尾巴（最多少 1 段音频）。
 * 这里用假 sink 钉住：暂停只挂起、不丢当前段；恢复不重播也不跳段；打断清空待播。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackQueue, type QueueStatus } from '../web-client/src/lib/playback-queue.js';

interface FakeSink {
  sink: {
    play(buffer: string, onEnded: () => void): () => void;
    suspend(): void;
    resume(): void;
  };
  started: string[];
  stopped: string[];
  suspended: number;
  resumed: number;
  /** 手动让「当前正在播的那一段」结束。 */
  finish(): void;
}

function fakeSink(): FakeSink {
  const state: FakeSink = {
    started: [],
    stopped: [],
    suspended: 0,
    resumed: 0,
    finish: () => undefined,
    sink: {
      play(buffer, onEnded) {
        state.started.push(buffer);
        state.finish = () => onEnded();
        return () => state.stopped.push(buffer);
      },
      suspend() { state.suspended += 1; },
      resume() { state.resumed += 1; },
    },
  };
  return state;
}

function makeQueue(): { queue: PlaybackQueue<string>; fake: FakeSink; statuses: QueueStatus[] } {
  const fake = fakeSink();
  const statuses: QueueStatus[] = [];
  const queue = new PlaybackQueue<string>(fake.sink, (status) => statuses.push(status));
  return { queue, fake, statuses };
}

test('P2-2：暂停只挂起输出，当前段既不 stop 也不丢，恢复后继续播同一段', () => {
  const { queue, fake, statuses } = makeQueue();
  queue.enqueue('a');
  queue.enqueue('b');
  queue.enqueue('c');
  assert.deepEqual(fake.started, ['a']);
  assert.equal(queue.pending, 2);

  queue.pause();
  assert.equal(fake.suspended, 1);
  assert.deepEqual(fake.stopped, [], '暂停绝对不能 stop 当前段，否则会吞掉音频尾巴');
  assert.equal(queue.pending, 2, '待播队列不受暂停影响');

  queue.resume();
  assert.equal(fake.resumed, 1);
  assert.deepEqual(fake.started, ['a'], '恢复不能重播（重播会把同一段放两遍）');
  assert.deepEqual(fake.stopped, []);
  assert.equal(queue.isPlaying, true);

  fake.finish();
  assert.deepEqual(fake.started, ['a', 'b'], '当前段正常结束后才播下一段');
  assert.equal(queue.pending, 1);
  assert.deepEqual(statuses.at(-1), 'playing');
});

test('P2-2：暂停期间到达的音频排在队尾，恢复后按顺序播放', () => {
  const { queue, fake } = makeQueue();
  queue.enqueue('a');
  queue.pause();
  queue.enqueue('b');
  assert.deepEqual(fake.started, ['a'], '暂停期间不启动新段');
  assert.equal(queue.pending, 1);
  queue.resume();
  fake.finish();
  assert.deepEqual(fake.started, ['a', 'b']);
});

test('P2-2：打断清空待播、停当前段，并返回被清掉的段数', () => {
  const { queue, fake, statuses } = makeQueue();
  queue.enqueue('a');
  queue.enqueue('b');
  queue.enqueue('c');
  const cleared = queue.clear();
  assert.equal(cleared, 2, '打断报告的是待播段数（不含正在播的那一段）');
  assert.deepEqual(fake.stopped, ['a']);
  assert.equal(queue.pending, 0);
  assert.equal(queue.isPlaying, false);
  assert.equal(statuses.at(-1), 'idle');

  // 被停掉的段迟到的 onEnded 不能把队列重新拉起来。
  fake.finish();
  assert.deepEqual(fake.started, ['a']);
  assert.equal(queue.isPlaying, false);
});

test('P2-2：暂停中打断后恢复不会复活已清空的队列', () => {
  const { queue, fake } = makeQueue();
  queue.enqueue('a');
  queue.pause();
  queue.clear();
  queue.resume();
  assert.deepEqual(fake.started, ['a']);
  assert.equal(queue.isPlaying, false);
  assert.equal(queue.pending, 0);
});

test('P2-2：空队列播放结束回到 idle', () => {
  const { queue, fake, statuses } = makeQueue();
  queue.enqueue('a');
  fake.finish();
  assert.deepEqual(statuses, ['playing', 'idle']);
  assert.equal(queue.isPlaying, false);
});
