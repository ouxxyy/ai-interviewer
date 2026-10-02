import { PlaybackQueue } from './lib/playback-queue.js';
import type { AppErrorBody, Snapshot } from './types.js';

type AudioStatus = 'connecting' | 'idle' | 'listening' | 'playing' | 'paused' | 'closed' | 'offline';

interface RealtimeCallbacks {
  onSnapshot(snapshot: Snapshot): void;
  onTranscript(text: string, final: boolean): void;
  onError(error: AppErrorBody): void;
  onStatus(status: AudioStatus): void;
  onMicrophone?(label: string): void;
}



function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToInt16(value: string): Int16Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const data = new DataView(bytes.buffer);
  const pcm = new Int16Array(Math.floor(bytes.length / 2));
  for (let index = 0; index < pcm.length; index += 1) pcm[index] = data.getInt16(index * 2, true);
  return pcm;
}

export class RealtimeAudio {
  private socket: WebSocket | null = null;
  private captureContext: AudioContext | null = null;
  private playbackContext: AudioContext | null = null;
  private microphone: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private mutedGain: GainNode | null = null;
  private pendingPcm: number[] = [];
  private playback: PlaybackQueue<AudioBuffer> | null = null;
  private paused = false;
  private capturing = false;
  /** 主动关闭（close()/reconnect()）不算断线，不该报 E_OFFLINE。 */
  private intentionalClose = false;
  /** 断线只报一次，否则 100ms 一片的音频上行会刷屏。 */
  private offlineReported = false;

  constructor(private readonly callbacks: RealtimeCallbacks) {}

  get isCapturing(): boolean {
    return this.capturing;
  }

  async connect(sid: string): Promise<void> {
    this.callbacks.onStatus('connecting');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/realtime?sid=${encodeURIComponent(sid)}`);
    this.socket = socket;
    this.intentionalClose = false;
    socket.onmessage = (event) => this.handleMessage(event);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('WebSocket 连接失败'));
    });
    this.offlineReported = false;
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.callbacks.onStatus('closed');
      if (!this.intentionalClose) this.reportOffline('实时连接已断开，这一场还在服务端等着');
    };
    this.callbacks.onStatus('idle');
  }

  /** 返回值：这一步有没有真的发出去（没发出去时页面要保留失败动作，等重连后恢复）。 */
  async startAnswer(): Promise<boolean> {
    const sent = this.send({ type: 'answer.start' });
    if (!sent) return false;
    await this.startCapture();
    return this.capturing;
  }

  async commitAnswer(): Promise<boolean> {
    await this.stopCapture();
    if (!this.paused) this.callbacks.onStatus('idle');
    return this.send({ type: 'answer.commit' });
  }

  repeatQuestion(): boolean {
    return this.send({ type: 'repeat.question' });
  }

  pause(): void {
    this.paused = true;
    // 只挂起播放输出，不 stop 当前 buffer —— 否则恢复时会吞掉这一段音频的尾巴（P2-2）。
    void this.playbackContext?.suspend().catch(() => undefined);
    this.send({ type: 'pause' });
    this.callbacks.onStatus('paused');
  }

  resume(): void {
    this.paused = false;
    this.send({ type: 'resume' });
    void this.playbackContext?.resume().catch(() => undefined);
    this.playback?.resume();
    this.callbacks.onStatus(this.playback?.isPlaying === true ? 'playing' : this.capturing ? 'listening' : 'idle');
  }

  interrupt(): number {
    const cleared = this.playback?.clear() ?? 0;
    this.send({ type: 'interrupt' });
    this.callbacks.onStatus(this.capturing ? 'listening' : 'idle');
    return cleared;
  }

  reconnect(sid: string): Promise<void> {
    this.intentionalClose = true;
    this.socket?.close();
    this.socket = null;
    return this.connect(sid);
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    await this.stopCapture();
    this.playback?.clear();
    this.socket?.close();
    this.socket = null;
    if (this.playbackContext !== null) await this.playbackContext.close().catch(() => undefined);
    this.playbackContext = null;
    this.playback = null;
    this.callbacks.onStatus('closed');
  }

  /** 返回是否真的发出去了：没发出去就必须让界面知道，不能静默丢消息（P1-1）。 */
  private send(message: Record<string, unknown>): boolean {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return true;
    }
    this.reportOffline('实时连接没有建立，这一步没有发出去');
    return false;
  }

  /** 断线统一出口：置 offline 状态、报一次 E_OFFLINE、停采集（不留热麦）。 */
  private reportOffline(message: string): void {
    if (this.offlineReported) return;
    this.offlineReported = true;
    this.callbacks.onStatus('offline');
    this.callbacks.onError({
      code: 'E_OFFLINE',
      message,
      hint: '点「重新连接」恢复这一场；已经提交过的回答和评审不会丢',
    });
    if (this.capturing) void this.stopCapture();
  }

  private async requestMicrophone(): Promise<MediaStream> {
    const audio: MediaTrackConstraints = { channelCount: 1, echoCancellation: false, noiseSuppression: false };
    try {
      // Chromium 的 default 设备跟随操作系统输入，避免沿用浏览器记住的 iPhone/虚拟麦克风。
      return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: 'default' } } });
    } catch (error) {
      // 不支持 default ID 的浏览器才回退；权限拒绝、设备占用不换设备重试。
      if (!(error instanceof DOMException) || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw error;
      return navigator.mediaDevices.getUserMedia({ audio });
    }
  }

  private async startCapture(): Promise<void> {
    if (this.capturing) return;
    try {
      if (globalThis.isSecureContext === false) throw new Error('麦克风需要 HTTPS 安全连接，请使用本站 HTTPS 地址');
      this.microphone = await this.requestMicrophone();
      this.captureContext = new AudioContext({ sampleRate: 16_000 });
      // 公网 CSP 仅允许同源脚本；Blob worklet 会被拦截，并被旧代码误报成权限拒绝。
      await this.captureContext.audioWorklet.addModule('/pcm16-worklet.js');
      const source = this.captureContext.createMediaStreamSource(this.microphone);
      this.worklet = new AudioWorkletNode(this.captureContext, 'pcm16-processor');
      this.mutedGain = this.captureContext.createGain();
      this.mutedGain.gain.value = 0;
      source.connect(this.worklet);
      this.worklet.connect(this.mutedGain);
      this.mutedGain.connect(this.captureContext.destination);
      this.worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const chunk = new Uint8Array(event.data);
        for (const byte of chunk) this.pendingPcm.push(byte);
        while (this.pendingPcm.length >= 3200) {
          const slice = Uint8Array.from(this.pendingPcm.splice(0, 3200));
          if (!this.paused) this.send({ type: 'audio.append', audio: bytesToBase64(slice) });
        }
      };
      // getUserMedia 是异步的，权限对话框会让创建 AudioContext 时的用户激活丢失。
      // Chrome 可能因此返回 suspended context；不显式 resume 就会显示「正在录音」却一个分片都收不到。
      await this.captureContext.resume();
      if (this.captureContext.state !== 'running') throw new Error(`AudioContext 未启动（${this.captureContext.state}）`);
      this.capturing = true;
      this.callbacks.onMicrophone?.(this.microphone.getAudioTracks()[0]?.label || '系统默认麦克风');
      this.callbacks.onStatus('listening');
    } catch (error) {
      const detail = error instanceof DOMException ? `${error.name}: ${error.message}` : String(error);
      await this.stopCapture();
      this.send({ type: 'mic.denied', detail: detail.slice(0, 160) });
      this.callbacks.onError({ code: 'E_MIC_DENIED', message: '麦克风没有开始采集', hint: '在浏览器网站设置中允许麦克风，确认当前输入设备后再答一次', detail });
      return;
    }
  }

  private async stopCapture(): Promise<void> {
    if (!this.capturing && this.captureContext === null && this.microphone === null) return;
    this.capturing = false;
    if (this.worklet !== null) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
    }
    this.mutedGain?.disconnect();
    this.microphone?.getTracks().forEach((track) => track.stop());
    await this.captureContext?.close().catch(() => undefined);
    this.captureContext = null;
    this.worklet = null;
    this.mutedGain = null;
    this.microphone = null;
    this.pendingPcm = [];
    this.callbacks.onMicrophone?.('');
  }

  private handleMessage(event: MessageEvent<string>): void {
    if (typeof event.data !== 'string') return;
    const message = JSON.parse(event.data) as Record<string, unknown>;
    if (message.type === 'interviewer.audio' && typeof message.audio === 'string') {
      this.enqueuePlayback(base64ToInt16(message.audio));
      return;
    }
    if ((message.type === 'transcript.partial' || message.type === 'transcript.final') && typeof message.text === 'string') {
      this.callbacks.onTranscript(message.text, message.type === 'transcript.final');
      return;
    }
    if ((message.type === 'state' || message.type === 'paused' || message.type === 'resumed') && message.snapshot !== undefined) {
      this.paused = message.type === 'paused';
      this.callbacks.onSnapshot(message.snapshot as Snapshot);
      return;
    }
    if (message.type === 'error' && message.error !== undefined) {
      this.callbacks.onError(message.error as AppErrorBody);
    }
  }

  private ensurePlaybackContext(): AudioContext {
    this.playbackContext ??= new AudioContext({ sampleRate: 24_000 });
    return this.playbackContext;
  }

  private ensurePlayback(): PlaybackQueue<AudioBuffer> {
    const context = this.ensurePlaybackContext();
    this.playback ??= new PlaybackQueue<AudioBuffer>(
      {
        play: (buffer, onEnded) => {
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          source.onended = onEnded;
          source.start();
          return () => {
            source.onended = null;
            try {
              source.stop();
            } catch {
              // AudioBufferSourceNode 只能 stop 一次。
            }
          };
        },
        suspend: () => { void context.suspend().catch(() => undefined); },
        resume: () => { void context.resume().catch(() => undefined); },
      },
      (status) => {
        if (status === 'playing') return this.callbacks.onStatus('playing');
        this.callbacks.onStatus(this.capturing ? 'listening' : 'idle');
      },
    );
    return this.playback;
  }

  private enqueuePlayback(pcm: Int16Array): void {
    const context = this.ensurePlaybackContext();
    const floats = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index += 1) floats[index] = pcm[index]! / 32768;
    const buffer = context.createBuffer(1, floats.length, 24_000);
    buffer.copyToChannel(floats, 0);
    this.ensurePlayback().enqueue(buffer);
  }
}
