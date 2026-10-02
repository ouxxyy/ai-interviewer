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

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static staySuspended = false;
  static moduleGate: Promise<void> | null = null;
  static resumeGate: Promise<void> | null = null;
  static modulePaths: string[] = [];

  state: AudioContextState = 'suspended';
  resumeCalls = 0;
  readonly destination = {} as AudioDestinationNode;
  readonly audioWorklet = { addModule: async (url: string) => {
    FakeAudioContext.modulePaths.push(url);
    await FakeAudioContext.moduleGate;
  } } as unknown as AudioWorklet;

  constructor(_options?: AudioContextOptions) {
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    return { connect: () => undefined } as unknown as MediaStreamAudioSourceNode;
  }

  createGain(): GainNode {
    return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined } as unknown as GainNode;
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    await FakeAudioContext.resumeGate;
    if (!FakeAudioContext.staySuspended) this.state = 'running';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }
}

class FakeAudioWorkletNode {
  readonly port = { onmessage: null as ((event: MessageEvent<ArrayBuffer>) => void) | null };
  connect(): void {}
  disconnect(): void {}
}

function installDom(): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.WebSocket = FakeWebSocket;
  globals.location = { protocol: 'http:', host: '127.0.0.1:18918' };
}

function installCaptureDom(): { stopped: boolean[] } {
  installDom();
  const globals = globalThis as unknown as Record<string, unknown>;
  const stopped: boolean[] = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => stopped.push(true) }],
          getAudioTracks: () => [{ label: '系统输入测试设备' }],
        }),
      },
    },
  });
  globals.AudioContext = FakeAudioContext;
  globals.AudioWorkletNode = FakeAudioWorkletNode;
  FakeAudioContext.instances = [];
  FakeAudioContext.staySuspended = false;
  FakeAudioContext.moduleGate = null;
  FakeAudioContext.resumeGate = null;
  FakeAudioContext.modulePaths = [];
  return { stopped };
}

interface Recorder {
  errors: Array<{ code: string; message: string; halt?: boolean }>;
  statuses: Status[];
  snapshots: unknown[];
  microphones: string[];
}

function makeRuntime(): { runtime: RealtimeAudio; recorded: Recorder } {
  installDom();
  FakeWebSocket.instances = [];
  const recorded: Recorder = { errors: [], statuses: [], snapshots: [], microphones: [] };
  const runtime = new RealtimeAudio({
    onSnapshot: (snapshot) => recorded.snapshots.push(snapshot),
    onTranscript: () => undefined,
    onError: (error) => recorded.errors.push({ code: String(error.code), message: error.message, ...(error.halt === undefined ? {} : { halt: error.halt }) }),
    onStatus: (status) => recorded.statuses.push(status as Status),
    onMicrophone: (label) => recorded.microphones.push(label),
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

test('连续面试：提交回答与无播放队列的暂停恢复都会回到 idle，允许下一轮自动开麦', async () => {
  const { runtime, recorded } = makeRuntime();
  const connecting = runtime.connect('s-1');
  const socket = FakeWebSocket.last;
  socket.establish();
  await connecting;

  runtime.pause();
  assert.equal(recorded.statuses.at(-1), 'paused');
  runtime.resume();
  assert.equal(recorded.statuses.at(-1), 'idle', '没有待播音频时恢复后不能永远卡在 paused');

  const idleBeforeCommit = recorded.statuses.filter((status) => status === 'idle').length;
  assert.equal(await runtime.commitAnswer(), true);
  assert.equal(recorded.statuses.filter((status) => status === 'idle').length, idleBeforeCommit + 1, '回答提交后要明确退出 listening');
  assert.match(socket.sent.at(-1) ?? '', /answer\.commit/);
});

test('真实麦克风链路：AudioContext 必须显式 resume 后才标记正在录音', async () => {
  installCaptureDom();
  const { runtime, recorded } = makeRuntime();
  const connecting = runtime.connect('s-mic');
  FakeWebSocket.last.establish();
  await connecting;

  assert.equal(await runtime.startAnswer(), true);
  assert.equal(FakeAudioContext.instances.length, 1);
  assert.equal(FakeAudioContext.instances[0]?.resumeCalls, 1, '必须显式唤醒因异步 getUserMedia 而可能挂起的 AudioContext');
  assert.equal(runtime.isCapturing, true);
  assert.equal(recorded.statuses.at(-1), 'listening');
});

test('真实麦克风链路：AudioContext 仍挂起时不得伪装成正在录音', async () => {
  const capture = installCaptureDom();
  FakeAudioContext.staySuspended = true;
  const { runtime, recorded } = makeRuntime();
  const connecting = runtime.connect('s-mic-suspended');
  FakeWebSocket.last.establish();
  await connecting;

  assert.equal(await runtime.startAnswer(), false);
  assert.equal(runtime.isCapturing, false);
  assert.equal(recorded.errors.at(-1)?.code, 'E_MIC_DENIED');
  assert.equal(capture.stopped.length, 1, '启动失败必须立即释放麦克风轨道');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function stream(label = '测试麦克风') {
  const stopped: boolean[] = [];
  const track = { label, stop: () => stopped.push(true) };
  return { stopped, value: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}

function microphoneRequest(request: (constraints: MediaStreamConstraints) => Promise<MediaStream>): void {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: request } } });
}

async function connectedCapture() {
  installCaptureDom();
  const result = makeRuntime();
  const connecting = result.runtime.connect('s-capture');
  FakeWebSocket.last.establish();
  await connecting;
  return { ...result, socket: FakeWebSocket.last };
}

async function flushAsync(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

test('麦克风设备语义：先请求系统 default，仅设备不支持时回退，不在权限拒绝后换设备', async () => {
  const { runtime } = await connectedCapture();
  const requested: MediaStreamConstraints[] = [];
  const mic = stream();
  microphoneRequest(async (constraints) => {
    requested.push(constraints);
    if (requested.length === 1) throw new DOMException('default 不支持', 'OverconstrainedError');
    return mic.value;
  });
  assert.equal(await runtime.startAnswer(), true);
  assert.deepEqual((requested[0]?.audio as MediaTrackConstraints).deviceId, { exact: 'default' });
  assert.equal((requested[1]?.audio as MediaTrackConstraints).deviceId, undefined);
  assert.deepEqual(FakeAudioContext.modulePaths, ['/pcm16-worklet.js'], 'worklet 必须从同源地址加载');
  await runtime.close();
  assert.equal(mic.stopped.length, 1);

  const denied = await connectedCapture();
  let calls = 0;
  microphoneRequest(async () => { calls += 1; throw new DOMException('拒绝授权', 'NotAllowedError'); });
  assert.equal(await denied.runtime.startAnswer(), false);
  assert.equal(calls, 1, '权限拒绝不得绕过到其他麦克风');
  assert.equal(denied.recorded.errors.at(-1)?.code, 'E_MIC_DENIED');
});

test('启动失败：worklet 加载失败和 AudioContext 构造失败均释放已授权设备', async () => {
  const { runtime } = await connectedCapture();
  const mic = stream();
  microphoneRequest(async () => mic.value);
  FakeAudioContext.moduleGate = Promise.reject(new Error('worklet 加载失败'));
  assert.equal(await runtime.startAnswer(), false);
  assert.equal(mic.stopped.length, 1);
  assert.equal(FakeAudioContext.instances[0]?.state, 'closed');

  const second = await connectedCapture();
  const another = stream();
  microphoneRequest(async () => another.value);
  (globalThis as unknown as Record<string, unknown>).AudioContext = class { constructor() { throw new Error('设备忙'); } };
  assert.equal(await second.runtime.startAnswer(), false);
  assert.equal(another.stopped.length, 1);
});

for (const cancel of ['close', 'drop', 'pause', 'commit', 'reconnect'] as const) {
  test(`采集取消：等待授权期间 ${cancel}，延迟权限返回不能开启热麦`, async () => {
    const { runtime, recorded, socket } = await connectedCapture();
    const permission = deferred<MediaStream>();
    const mic = stream();
    microphoneRequest(() => permission.promise);
    const starting = runtime.startAnswer();
    if (cancel === 'close') await runtime.close();
    if (cancel === 'drop') socket.drop();
    if (cancel === 'pause') runtime.pause();
    if (cancel === 'commit') await runtime.commitAnswer();
    if (cancel === 'reconnect') {
      const reconnecting = runtime.reconnect('s-capture');
      FakeWebSocket.last.establish();
      await reconnecting;
    }
    const count = recorded.statuses.length;
    permission.resolve(mic.value);
    assert.equal(await starting, false);
    assert.equal(runtime.isCapturing, false);
    assert.equal(mic.stopped.length, 1, '过期授权 stream 必须立即 stop');
    assert.equal(recorded.statuses.slice(count).includes('listening'), false);
    assert.equal(recorded.errors.some((error) => error.code === 'E_MIC_DENIED'), false, '取消不应伪装权限失败');
  });
}

for (const stage of ['worklet', 'resume'] as const) {
  test(`采集取消：等待 ${stage} 时 close，资源立即释放且延迟初始化不能复活`, async () => {
    const { runtime, recorded } = await connectedCapture();
    const gate = deferred<void>();
    const mic = stream();
    microphoneRequest(async () => mic.value);
    if (stage === 'worklet') FakeAudioContext.moduleGate = gate.promise;
    else FakeAudioContext.resumeGate = gate.promise;
    const starting = runtime.startAnswer();
    await flushAsync();
    await runtime.close();
    assert.equal(mic.stopped.length, 1, '关闭不得等待 addModule/resume 才释放麦克风');
    gate.resolve();
    assert.equal(await starting, false);
    assert.equal(runtime.isCapturing, false);
    assert.equal(FakeAudioContext.instances[0]?.state, 'closed');
    assert.equal(recorded.statuses.at(-1), 'closed');
  });
}

test('资源所有权：旧授权晚到不得清理新采集，也不能用新采集状态返回成功', async () => {
  const { runtime, recorded } = await connectedCapture();
  const oldPermission = deferred<MediaStream>();
  const oldMic = stream('旧设备');
  const newMic = stream('新设备');
  let requests = 0;
  microphoneRequest(() => ++requests === 1 ? oldPermission.promise : Promise.resolve(newMic.value));
  const oldStart = runtime.startAnswer();
  await runtime.commitAnswer();
  assert.equal(await runtime.startAnswer(), true);
  oldPermission.resolve(oldMic.value);
  assert.equal(await oldStart, false);
  assert.equal(runtime.isCapturing, true);
  assert.equal(oldMic.stopped.length, 1);
  assert.equal(newMic.stopped.length, 0);
  assert.equal(recorded.microphones.at(-1), '新设备');
  await runtime.close();
  assert.equal(newMic.stopped.length, 1);
});

test('并发 startAnswer 共享同一次授权，只占用一个麦克风并发送一次 start', async () => {
  const { runtime, socket } = await connectedCapture();
  const permission = deferred<MediaStream>();
  const mic = stream();
  let requests = 0;
  microphoneRequest(() => { requests += 1; return permission.promise; });
  const first = runtime.startAnswer();
  const second = runtime.startAnswer();
  assert.equal(requests, 1);
  assert.equal(socket.sent.filter((value) => JSON.parse(value).type === 'answer.start').length, 1);
  permission.resolve(mic.value);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(FakeAudioContext.instances.length, 1);
  await runtime.close();
  assert.equal(mic.stopped.length, 1);
});

test('暂停/恢复语义：暂停立即停采集，恢复不自动开热麦，显式start才能再采集', async () => {
  const { runtime, recorded } = await connectedCapture();
  const firstMic = stream('暂停前设备');
  const secondMic = stream('恢复后设备');
  let requests = 0;
  microphoneRequest(async () => ++requests === 1 ? firstMic.value : secondMic.value);
  assert.equal(await runtime.startAnswer(), true);
  runtime.pause();
  assert.equal(runtime.isCapturing, false);
  assert.equal(firstMic.stopped.length, 1);
  assert.equal(recorded.statuses.at(-1), 'paused');
  runtime.resume();
  assert.equal(runtime.isCapturing, false);
  assert.equal(recorded.statuses.at(-1), 'idle');
  assert.equal(requests, 1, '恢复不能绕过显式开始采集');
  assert.equal(await runtime.startAnswer(), true);
  assert.equal(secondMic.stopped.length, 0);
  await runtime.close();
});

test('旧worklet加载失败晚到时，只清旧context，不影响新麦克风也不误报权限错误', async () => {
  const { runtime, recorded } = await connectedCapture();
  const oldModule = deferred<void>();
  FakeAudioContext.moduleGate = oldModule.promise;
  const oldMic = stream('旧设备');
  const freshMic = stream('新设备');
  let requests = 0;
  microphoneRequest(async () => ++requests === 1 ? oldMic.value : freshMic.value);
  const oldStart = runtime.startAnswer();
  await flushAsync();
  await runtime.commitAnswer();
  FakeAudioContext.moduleGate = null;
  assert.equal(await runtime.startAnswer(), true);
  oldModule.reject(new Error('旧模块加载失败'));
  assert.equal(await oldStart, false);
  assert.equal(freshMic.stopped.length, 0);
  assert.equal(runtime.isCapturing, true);
  assert.equal(recorded.errors.some((error) => error.code === 'E_MIC_DENIED'), false);
  assert.equal(recorded.microphones.at(-1), '新设备');
  await runtime.close();
});
