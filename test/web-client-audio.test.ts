/**
 * 实时音频链路「断线与发送失败」的回归测试（P1-1）。
 *
 * 被打回的现象：WS 关闭只把状态设成 closed，界面上仍显示「小八在听」，
 * `send()` 在非 OPEN 时静默丢消息，按钮照点、回答照丢。
 * 这个文件用假 WebSocket 直接驱动 `RealtimeAudio`，钉住：
 * 1. 发送失败必须回调 E_OFFLINE 且返回 false（调用方能判断有没有真的发出去）；
 * 2. 意外断开必须报一次 E_OFFLINE + offline 状态，且不能刷屏；
 * 3. 主动关闭（close/reconnect）不算断线；
 * 4. 重连成功后重新允许发送。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeAudio } from '../web-client/src/audio.js';

type Status = 'connecting' | 'idle' | 'listening' | 'playing' | 'paused' | 'closed' | 'offline';

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static get last(): FakeWebSocket {
    const instance = FakeWebSocket.instances.at(-1);
    if (instance === undefined) throw new Error('还没有创建 WebSocket');
    return instance;
  }

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  /** 测试驱动：连接建立。 */
  establish(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** 测试驱动：链路被对端掐断（非主动关闭）。 */
  drop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  deliver(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function installDom(): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.WebSocket = FakeWebSocket;
  globals.location = { protocol: 'http:', host: '127.0.0.1:18918' };
}

interface Recorder {
  errors: Array<{ code: string; message: string; halt?: boolean }>;
  statuses: Status[];
  snapshots: unknown[];
}

function makeRuntime(): { runtime: RealtimeAudio; recorded: Recorder } {
  installDom();
  FakeWebSocket.instances = [];
  const recorded: Recorder = { errors: [], statuses: [], snapshots: [] };
  const runtime = new RealtimeAudio({
    onSnapshot: (snapshot) => recorded.snapshots.push(snapshot),
    onTranscript: () => undefined,
    onError: (error) => recorded.errors.push({ code: String(error.code), message: error.message, ...(error.halt === undefined ? {} : { halt: error.halt }) }),
    onStatus: (status) => recorded.statuses.push(status as Status),
  });
  return { runtime, recorded };
}

test('P1-1：发送失败必须报 E_OFFLINE 并返回 false，而且要按失败去重不刷屏', async () => {
  const { runtime, recorded } = makeRuntime();
  const connecting = runtime.connect('s-1');
  FakeWebSocket.last.establish();
  await connecting;

  assert.equal(runtime.repeatQuestion(), true);
  assert.equal(FakeWebSocket.last.sent.length, 1);

  // 链路断了：后续每一次发送都必须明确失败。
  FakeWebSocket.last.readyState = FakeWebSocket.CLOSED;
  assert.equal(runtime.repeatQuestion(), false);
  assert.equal(runtime.repeatQuestion(), false);
  assert.equal(runtime.repeatQuestion(), false);

  const offlineErrors = recorded.errors.filter((error) => error.code === 'E_OFFLINE');
  assert.equal(offlineErrors.length, 1, '10Hz 的音频上行不能把 E_OFFLINE 刷成一片');
  assert.ok(recorded.statuses.includes('offline'), '必须把 offline 状态交给界面，否则界面会继续显示「小八在听」');
});

test('P1-1：意外断开必须报 E_OFFLINE；主动 close 不算断线', async () => {
  const { runtime, recorded } = makeRuntime();
  const connecting = runtime.connect('s-1');
  const socket = FakeWebSocket.last;
  socket.establish();
  await connecting;

  socket.drop();
  assert.equal(recorded.errors.filter((error) => error.code === 'E_OFFLINE').length, 1);
  assert.ok(recorded.statuses.includes('offline'));

  const second = makeRuntime();
  const connecting2 = second.runtime.connect('s-2');
  FakeWebSocket.last.establish();
  await connecting2;
  await second.runtime.close();
  assert.deepEqual(second.recorded.errors, [], '页面卸载时的主动关闭不是断线，不该弹错误');
  assert.ok(second.recorded.statuses.includes('closed'));
});

test('P1-1：重连成功后重新允许发送，并且不再重复报断线', async () => {
  const { runtime, recorded } = makeRuntime();
  const connecting = runtime.connect('s-1');
  FakeWebSocket.last.establish();
  await connecting;

  FakeWebSocket.last.readyState = FakeWebSocket.CLOSED;
  assert.equal(runtime.repeatQuestion(), false);

  const reconnecting = runtime.reconnect('s-1');
  const fresh = FakeWebSocket.last;
  assert.notEqual(fresh, undefined);
  fresh.establish();
  await reconnecting;

  assert.equal(runtime.repeatQuestion(), true, '重连后必须能继续发消息');
  assert.equal(fresh.sent.length, 1);
  assert.equal(recorded.errors.filter((error) => error.code === 'E_OFFLINE').length, 1);
});

test('P1-1：重连期间的主动关闭不被误判成断线', async () => {
  const { runtime, recorded } = makeRuntime();
  const connecting = runtime.connect('s-1');
  FakeWebSocket.last.establish();
  await connecting;

  const reconnecting = runtime.reconnect('s-1');
  FakeWebSocket.last.establish();
  await reconnecting;
  assert.deepEqual(recorded.errors, []);
});

test('P1-1：服务端 state 仍然把快照交给页面（断线恢复后以服务端为准）', async () => {
  const { runtime, recorded } = makeRuntime();
  const connecting = runtime.connect('s-1');
  const socket = FakeWebSocket.last;
  socket.establish();
  await connecting;

  socket.deliver({ type: 'state', snapshot: { sid: 's-1', state: 'answer', machine: { questionIndex: 1 } } });
  assert.equal(recorded.snapshots.length, 1);

  socket.deliver({ type: 'error', error: { code: 'E_MODEL_TIMEOUT', message: '模型超时' } });
  assert.equal(recorded.errors.at(-1)?.code, 'E_MODEL_TIMEOUT');
});

test('P1-1：未连接的 WebSocket 上发送同样要报失败而不是静默丢弃', async () => {
  const { runtime, recorded } = makeRuntime();
  const connecting = runtime.connect('s-1');
  const socket = FakeWebSocket.last;
  socket.establish();
  await connecting;

  // 模拟 connect 之后 socket 被替换（重连失败）的情况：完全没有 socket。
  socket.readyState = FakeWebSocket.CLOSED;
  assert.equal(runtime.repeatQuestion(), false);
  assert.equal(recorded.errors.filter((error) => error.code === 'E_OFFLINE').length, 1);
});
