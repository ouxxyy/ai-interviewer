/** OpenAI Speech + Transcription adapted to the existing manual-turn audio bridge.
 * Input: signed PCM16 / 16 kHz. Output: signed PCM16 / 24 kHz.
 * ASR runs after the user finishes; it does not claim streaming ASR.
 */
import { pcmToWav } from '../t1r/audio.js';
import type { RealtimeLike } from '../web/realtime-bridge.js';
import type { RealtimeEventRecord, ResponseResult, SessionInfo, UserTranscriptResult } from './realtime-dashscope.js';
import { openAiRequest, readOpenAiJson, type CallGuard, type OpenAiConfig } from './openai-compatible.js';

type Waiter<T> = { resolve(v: T): void; reject(e: Error): void; timer: NodeJS.Timeout };
export class OpenAiAudioClient implements RealtimeLike {
  readonly events: RealtimeEventRecord[] = [];
  readonly isVoiceAsserted = true; // REST requests specify voice; no session handshake exists.
  private audio: Buffer[] = [];
  private inputBytes = 0;
  private response: Waiter<ResponseResult> | null = null;
  private transcript: Waiter<UserTranscriptResult> | null = null;
  private speechController: AbortController | null = null;
  private asrController: AbortController | null = null;
  private speechStarted = 0;
  private spoken: Buffer[] = [];
  private firstAudioAt: number | null = null;
  private onAudio: (chunk: Buffer, seq: number) => void = () => {};
  private onText: (text: string, final: boolean) => void = () => {};
  private closed = false;
  constructor(private readonly config: OpenAiConfig, private readonly guard: CallGuard = () => () => {}, private readonly language: 'en' | 'zh' = 'zh') {}
  async open(sessionId: string): Promise<SessionInfo> {
    this.closed = false;
    return { sessionId, model: this.config.speechModel, voice: this.config.voice, inputAudioFormat: 'pcm16', outputAudioFormat: 'pcm16',
      inputAudioTranscriptionModel: this.config.transcriptionModel, turnDetection: null, handshakeMs: 0,
      updated: { voice: this.config.voice, transport: 'speech-and-transcription', voiceVerification: 'request-parameter' } };
  }
  onTranscript(cb: (partial: string, final: boolean) => void): void { this.onText = cb; }
  onInterviewerAudio(cb: (chunk: Buffer, seq: number) => void): void { this.onAudio = cb; }
  waitForResponse(timeoutMs = 90_000): Promise<ResponseResult> {
    if (this.response) return Promise.reject(new Error('语音生成正在进行'));
    return new Promise((resolve, reject) => {
      this.response = { resolve, reject, timer: setTimeout(() => { this.speechController?.abort(); this.failSpeech(new Error('免费语音生成超时')); }, timeoutMs) };
    });
  }
  injectText(text: string): void { void this.speak(text); }
  private finishSpeech(status: string, transcript = ''): void {
    const waiter = this.response; this.response = null;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    const endedAt = Date.now();
    waiter.resolve({ transcript, audio: Buffer.concat(this.spoken), firstAudioMs: this.firstAudioAt === null ? null : this.firstAudioAt - this.speechStarted,
      totalMs: endedAt - this.speechStarted, startedAt: this.speechStarted, firstAudioAt: this.firstAudioAt, endedAt, status });
  }
  private failSpeech(error: Error): void {
    const waiter = this.response; this.response = null;
    if (waiter) { clearTimeout(waiter.timer); waiter.reject(error); }
  }
  private async speak(text: string): Promise<void> {
    const controller = new AbortController(); this.speechController = controller;
    this.speechStarted = Date.now(); this.firstAudioAt = null; this.spoken = [];
    let release = () => {};
    try {
      if (this.closed || !this.response) throw new Error('语音通道已关闭');
      if (text.length > 4096) throw new Error('待朗读文本超过长度上限');
      release = this.guard();
      const res = await openAiRequest(this.config, '/audio/speech', JSON.stringify({ model: this.config.speechModel, voice: this.config.voice,
        input: text, response_format: 'pcm', instructions: this.language === 'en' ? 'Read the supplied English interview question verbatim in a natural, clear voice.' : '用自然、温和、清晰的中文逐字朗读给定文本，不添加任何内容。' }), controller.signal);
      if (!res.body) throw new Error('免费语音返回为空');
      let carry = Buffer.alloc(0); let seq = 0; let bytes = 0;
      for await (const value of res.body) {
        if (controller.signal.aborted || this.closed) break;
        const raw = Buffer.concat([carry, Buffer.from(value)]);
        const chunk = raw.subarray(0, raw.length - raw.length % 2);
        carry = raw.subarray(chunk.length);
        if (!chunk.length) continue;
        bytes += chunk.length;
        if (bytes > 24_000 * 2 * 300) throw new Error('免费语音返回超过时长上限');
        this.firstAudioAt ??= Date.now(); this.spoken.push(chunk); this.onAudio(chunk, seq++);
      }
      if (!controller.signal.aborted && !this.closed) {
        if (!bytes || carry.length) throw new Error('免费语音格式无效');
        // A TTS input is not an independently recognized transcript.
        this.finishSpeech('completed');
      }
    } catch (e) { if (!controller.signal.aborted) this.failSpeech(e instanceof Error ? e : new Error('免费语音生成失败')); }
    finally { release(); if (this.speechController === controller) this.speechController = null; }
  }
  appendAudio(pcm: Buffer): void {
    if (this.closed) throw new Error('语音通道已关闭');
    if (pcm.length % 2 || this.inputBytes + pcm.length > 16_000 * 2 * 300) throw new Error('每轮免费回答最多 5 分钟');
    this.audio.push(Buffer.from(pcm)); this.inputBytes += pcm.length;
  }
  waitForUserTranscript(timeoutMs = 60_000): Promise<UserTranscriptResult> {
    if (this.transcript) return Promise.reject(new Error('回答转写正在进行'));
    return new Promise((resolve, reject) => {
      this.transcript = { resolve, reject, timer: setTimeout(() => { this.asrController?.abort(); this.failTranscript(new Error('免费回答转写超时')); }, timeoutMs) };
    });
  }
  private failTranscript(error: Error): void {
    const waiter = this.transcript; this.transcript = null;
    if (waiter) { clearTimeout(waiter.timer); waiter.reject(error); }
  }
  commitAudio(): void { void this.transcribe(); }
  private async transcribe(): Promise<void> {
    const controller = new AbortController(); this.asrController = controller;
    const started = Date.now(); const pcm = Buffer.concat(this.audio); this.audio = []; this.inputBytes = 0;
    let release = () => {};
    try {
      if (this.closed || !this.transcript) throw new Error('语音通道已关闭');
      let text = '';
      if (pcm.length >= 3200) {
        release = this.guard();
        const form = new FormData();
        form.append('language', this.language);
        form.append('model', this.config.transcriptionModel);
        form.append('file', new Blob([new Uint8Array(pcmToWav(pcm, 16_000))], { type: 'audio/wav' }), 'answer.wav');
        const res = await openAiRequest(this.config, '/audio/transcriptions', form, controller.signal);
        let data: { text?: string };
        data = await readOpenAiJson(res, 128 * 1024) as typeof data;
        if (typeof data?.text !== 'string' || data.text.length > 20_000 || data.text.includes(this.config.apiKey)) throw new Error('免费转写返回内容无效');
        text = data.text.trim();
      }
      if (controller.signal.aborted || this.closed) return;
      this.onText(text, true);
      const waiter = this.transcript; this.transcript = null;
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve({ transcript: text, latencyMs: Date.now() - started }); }
    } catch (e) { if (!controller.signal.aborted) this.failTranscript(e instanceof Error ? e : new Error('免费转写失败')); }
    finally { release(); if (this.asrController === controller) this.asrController = null; }
  }
  cancelResponse(): void { this.speechController?.abort(); this.finishSpeech('cancelled'); }
  close(): void {
    this.closed = true; this.cancelResponse(); this.asrController?.abort(); this.failTranscript(new Error('语音通道已关闭'));
    this.audio = []; this.inputBytes = 0;
  }
}
