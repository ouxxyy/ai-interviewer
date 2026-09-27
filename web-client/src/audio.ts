import type { AppErrorBody, Snapshot } from './types';

type AudioStatus = 'connecting' | 'idle' | 'listening' | 'playing' | 'paused' | 'closed';

interface RealtimeCallbacks {
  onSnapshot(snapshot: Snapshot): void;
  onTranscript(text: string, final: boolean): void;
  onError(error: AppErrorBody): void;
  onStatus(status: AudioStatus): void;
}

const WORKLET_SOURCE = `
class PCM16Processor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    const output = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    this.port.postMessage(output.buffer, [output.buffer]);
    return true;
  }
}
registerProcessor('pcm16-processor', PCM16Processor);`;

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
  private playbackQueue: AudioBuffer[] = [];
  private currentSource: AudioBufferSourceNode | null = null;
  private paused = false;
  private capturing = false;
  private workletUrl: string | null = null;

  constructor(private readonly callbacks: RealtimeCallbacks) {}

  get isCapturing(): boolean {
    return this.capturing;
  }

  async connect(sid: string): Promise<void> {
    this.callbacks.onStatus('connecting');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/realtime?sid=${encodeURIComponent(sid)}`);
    this.socket = socket;
    socket.onmessage = (event) => this.handleMessage(event);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('WebSocket 连接失败'));
    });
    socket.onclose = () => {
      if (this.socket === socket) this.callbacks.onStatus('closed');
    };
    this.callbacks.onStatus('idle');
  }

  async startAnswer(): Promise<void> {
    this.send({ type: 'answer.start' });
    await this.startCapture();
  }

  async commitAnswer(): Promise<void> {
    await this.stopCapture();
    this.send({ type: 'answer.commit' });
  }

  repeatQuestion(): void {
    this.send({ type: 'repeat.question' });
  }

  pause(): void {
    this.paused = true;
    this.stopCurrentPlayback(false);
    this.send({ type: 'pause' });
    this.callbacks.onStatus('paused');
  }

  resume(): void {
    this.paused = false;
    this.send({ type: 'resume' });
    if (this.playbackQueue.length > 0) this.playNext();
    else this.callbacks.onStatus(this.capturing ? 'listening' : 'idle');
  }

  interrupt(): number {
    const cleared = this.playbackQueue.length;
    this.playbackQueue = [];
    this.stopCurrentPlayback(true);
    this.send({ type: 'interrupt' });
    this.callbacks.onStatus(this.capturing ? 'listening' : 'idle');
    return cleared;
  }

  reconnect(sid: string): Promise<void> {
    this.socket?.close();
    return this.connect(sid);
  }

  async close(): Promise<void> {
    await this.stopCapture();
    this.playbackQueue = [];
    this.stopCurrentPlayback(true);
    this.socket?.close();
    this.socket = null;
    if (this.playbackContext !== null) await this.playbackContext.close().catch(() => undefined);
    this.playbackContext = null;
    this.callbacks.onStatus('closed');
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private async startCapture(): Promise<void> {
    if (this.capturing) return;
    try {
      this.microphone = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false },
      });
    } catch (error) {
      const detail = error instanceof DOMException ? `${error.name}: ${error.message}` : String(error);
      this.send({ type: 'mic.denied', detail: detail.slice(0, 160) });
      this.callbacks.onError({ code: 'E_MIC_DENIED', message: '还没有麦克风权限', hint: '在浏览器网站设置中允许麦克风，然后再答一次', detail });
      return;
    }
    this.captureContext = new AudioContext({ sampleRate: 16_000 });
    this.workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    await this.captureContext.audioWorklet.addModule(this.workletUrl);
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
    this.capturing = true;
    this.callbacks.onStatus('listening');
  }

  private async stopCapture(): Promise<void> {
    if (!this.capturing && this.captureContext === null) return;
    this.capturing = false;
    if (this.worklet !== null) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
    }
    this.mutedGain?.disconnect();
    this.microphone?.getTracks().forEach((track) => track.stop());
    await this.captureContext?.close().catch(() => undefined);
    if (this.workletUrl !== null) URL.revokeObjectURL(this.workletUrl);
    this.captureContext = null;
    this.worklet = null;
    this.mutedGain = null;
    this.microphone = null;
    this.workletUrl = null;
    this.pendingPcm = [];
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

  private enqueuePlayback(pcm: Int16Array): void {
    const context = this.ensurePlaybackContext();
    const floats = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index += 1) floats[index] = pcm[index]! / 32768;
    const buffer = context.createBuffer(1, floats.length, 24_000);
    buffer.copyToChannel(floats, 0);
    this.playbackQueue.push(buffer);
    if (this.currentSource === null && !this.paused) this.playNext();
  }

  private playNext(): void {
    if (this.paused) return;
    const context = this.ensurePlaybackContext();
    const buffer = this.playbackQueue.shift();
    if (buffer === undefined) {
      this.currentSource = null;
      this.callbacks.onStatus(this.capturing ? 'listening' : 'idle');
      return;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      if (this.currentSource === source) this.currentSource = null;
      this.playNext();
    };
    this.currentSource = source;
    this.callbacks.onStatus('playing');
    source.start();
  }

  private stopCurrentPlayback(clearHandler: boolean): void {
    if (this.currentSource === null) return;
    const source = this.currentSource;
    this.currentSource = null;
    if (clearHandler) source.onended = null;
    try {
      source.stop();
    } catch {
      // AudioBufferSourceNode 只能 stop 一次。
    }
  }
}
