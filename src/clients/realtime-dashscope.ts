/**
 * DashScope Qwen-Omni-Realtime WebSocket 客户端（T1-R 新增，真实实现）。
 *
 * 协议事实（2026-09-26 实测，非照抄文档）：
 * - 端点 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=<id>`，请求头 `Authorization: Bearer <key>`。
 * - `session.update` 接受 modalities/voice/input_audio_format/output_audio_format/turn_detection/instructions/
 *   input_audio_transcription；服务端回 `session.updated` 即生效。
 * - 服务端默认音色报告为 `Chelsie`，但该音色在 `response.create` 时被拒（`Voice 'Chelsie' is not supported`），
 *   必须显式指定实测可用的音色（见 `SUPPORTED_VOICES`）。
 * - D2 可控性：服务端可用 `conversation.item.create`（role=user, content=[{type:'input_text'}]) +
 *   `response.create` 注入要朗读的文本，模型逐字朗读（实测 1/1；10 轮复测见验收记录）。
 * - 用户音频：`input_audio_buffer.append`(base64 pcm16) × N → `input_audio_buffer.commit`
 *   → `conversation.item.input_audio_transcription.completed`（真实 ASR 转写）。
 * - 面试官音频：`response.audio.delta`（base64 pcm24），服务端可落盘 → 回放范围＝双端。
 * - 打断：`response.cancel`，服务端回 `response.done`（status=cancelled）并停止后续音频分片。
 */
import WebSocket from 'ws';
import type { RealtimeVoiceClient } from './types.js';

export const REALTIME_DEFAULTS = {
  baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  model: 'qwen3.8-omni-flash-realtime',
  inputAudioFormat: 'pcm16',
  outputAudioFormat: 'pcm24',
  inputSampleRate: 16_000,
  outputSampleRate: 24_000,
  /** 当前产品默认音色；建连后仍必须以 session.updated 回显做前置断言。 */
  defaultVoice: 'Maia',
} as const;

/**
 * 2026-09-26 逐个实测过的历史结果：true＝当时接受并产出音频，false＝当时明确拒绝。
 * 新默认值 Maia 尚未付费实调，完成当前账号／地域验证前不写入这份历史表。
 */
export const SUPPORTED_VOICES: Record<string, boolean> = {
  Serena: true, Dylan: true, Sunny: true, Jennifer: true, Ryan: true, Katerina: true,
  Marcus: true, Peter: true, Rocky: true, Kiki: true, Mia: true, Chloe: true, Eric: true,
  Li: true, Aiden: true,
  Chelsie: false, Cherry: false, Ethan: false, Jada: false, Elias: false, Roy: false,
  Sophie: false, Luna: false, Ava: false, Bella: false, Grace: false, Emily: false,
  Nofish: false, Neil: false,
};

export interface RealtimeEventRecord {
  /** 相对连接建立的毫秒偏移。 */
  t: number;
  dir: 'send' | 'recv';
  type: string;
  bytes?: number;
  note?: string;
}

export interface SessionInfo {
  sessionId: string;
  model: string;
  voice: string;
  inputAudioFormat: string;
  outputAudioFormat: string;
  inputAudioTranscriptionModel: string | null;
  turnDetection: unknown;
  /** 从发起连接到收到 `session.created` 的毫秒数。 */
  handshakeMs: number;
  /** `session.update` 之后服务端回显的**生效**配置（voice 等以这里为准，而非 session.created 的默认值）。 */
  updated: Record<string, unknown> | null;
}

export interface ResponseResult {
  /** 面试官这段话的文本（`response.audio_transcript.done`）。 */
  transcript: string;
  /** 面试官音频 PCM（s24le）。 */
  audio: Buffer;
  /** response.create 发出 → 首个 audio delta 的毫秒数；无音频时为 null。 */
  firstAudioMs: number | null;
  /** response.create 发出 → response.done 的毫秒数。 */
  totalMs: number;
  /** 绝对时间戳（epoch ms），便于与其它链路（如 ASR commit）对齐做端到端计时。 */
  startedAt: number;
  firstAudioAt: number | null;
  endedAt: number;
  status: string;
}

export interface UserTranscriptResult {
  transcript: string;
  /** commit 发出 → 转写完成的毫秒数。 */
  latencyMs: number;
}

interface PendingWaiter<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class DashscopeRealtimeClient implements RealtimeVoiceClient {
  readonly name = 'dashscope-realtime';
  readonly events: RealtimeEventRecord[] = [];

  private ws: WebSocket | null = null;
  private origin = 0;
  private session: SessionInfo | null = null;
  private audioChunks: Buffer[] = [];
  private audioSeq = 0;
  private transcriptBuf = '';
  private transcriptFinal = '';
  private userTranscriptBuf = '';
  private responseStartedAt = 0;
  private responseFirstAudioAt: number | null = null;
  private firstAudioMs: number | null = null;
  private responseWaiters: Array<PendingWaiter<ResponseResult>> = [];
  private transcriptWaiters: Array<PendingWaiter<UserTranscriptResult>> = [];
  private sessionWaiters: Array<PendingWaiter<SessionInfo>> = [];
  private createdWaiters: Array<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  private lastError: { code: string; message: string } | null = null;
  private transcriptCbs: Array<(partial: string, final: boolean) => void> = [];
  private audioCbs: Array<(chunk: Buffer, seq: number) => void> = [];
  private commitSentAt = 0;
  private responseActive = false;

  /** 生效配置回显（session.updated 的载荷），供证据留档；已做脱敏。 */
  sessionCreatedPayload: Record<string, unknown> | null = null;
  sessionUpdatedPayload: Record<string, unknown> | null = null;
  /** 音色前置断言是否通过。未通过前禁止触发任何 response.create。 */
  private voiceAsserted = false;

  constructor(
    private readonly credential: string,
    private readonly opts: { model?: string; voice?: string; instructions?: string; baseUrl?: string; inputTranscriptionModel?: string; requireVoiceAssertion?: boolean } = {},
  ) {}

  get expectedVoice(): string {
    return this.opts.voice ?? REALTIME_DEFAULTS.defaultVoice;
  }

  get isVoiceAsserted(): boolean {
    return this.voiceAsserted;
  }

  /**
   * 音色前置断言（T2 硬要求）。
   *
   * 实测事实：服务端 `session.created` 自报的默认音色 `Chelsie` 在真正生成时会被
   * `<400> Voice 'Chelsie' is not supported` 拒掉；而且**在同一个连接里撞 400 之后再
   * `session.update` 到正确音色，服务端不回 `session.updated`、也不出音频——连接不会自愈**。
   * 所以不能等撞墙再补救：必须在发首个 `response.create` 之前，用 `session.updated` 的回显
   * 确认生效音色，不符就当场失败（由调用方新开连接重试）。
   */
  private assertVoice(): void {
    const effective = this.session?.updated?.voice;
    if (typeof effective !== 'string' || effective === '') {
      throw new Error(`音色前置断言失败：session.updated 未回显生效音色（期望 ${this.expectedVoice}）`);
    }
    if (effective !== this.expectedVoice) {
      throw new Error(`音色前置断言失败：生效音色 ${effective} ≠ 期望 ${this.expectedVoice}（不要在同一连接里重试，请新开连接）`);
    }
    this.voiceAsserted = true;
  }

  /** 脱敏后的会话配置载荷，用于入库证据（凭证与 sk-* 一律抹掉）。 */
  redactedSessionPayloads(): { created: Record<string, unknown> | null; updated: Record<string, unknown> | null; expectedVoice: string; voiceAsserted: boolean } {
    const redact = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const key = this.credential;
        let out = key.length >= 8 ? v.split(key).join('<redacted-credential>') : v;
        out = out.replace(/sk-[A-Za-z0-9._-]{12,}/g, '<redacted-sk-key>');
        return out;
      }
      if (Array.isArray(v)) return v.map(redact);
      if (v !== null && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, redact(val)]));
      }
      return v;
    };
    return {
      created: (redact(this.sessionCreatedPayload) as Record<string, unknown> | null) ?? null,
      updated: (redact(this.sessionUpdatedPayload) as Record<string, unknown> | null) ?? null,
      expectedVoice: this.expectedVoice,
      voiceAsserted: this.voiceAsserted,
    };
  }

  get info(): SessionInfo | null {
    return this.session;
  }

  /** 产品抽象：`connect(sessionId)`。sessionId 仅用于关联日志。 */
  async connect(sessionId = 't1r'): Promise<void> {
    await this.open(sessionId);
  }

  async open(sessionId: string): Promise<SessionInfo> {
    if (this.ws) throw new Error('连接已存在，请先 close()');
    const model = this.opts.model ?? REALTIME_DEFAULTS.model;
    const url = `${this.opts.baseUrl ?? REALTIME_DEFAULTS.baseUrl}?model=${encodeURIComponent(model)}`;
    const startedAt = Date.now();
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.credential}`, 'OpenAI-Beta': 'realtime=v1' } });
    this.ws = ws;
    this.origin = startedAt;
    this.correlationId = sessionId;

    ws.on('message', (data: WebSocket.RawData) => {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handleEvent(obj);
    });
    ws.on('error', (e: Error) => {
      this.record('recv', 'socket.error', undefined, e.message);
      this.failAll(new Error(`实时连接错误：${e.message}`));
    });

    const session = await new Promise<SessionInfo>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`连接 ${model} 超时（30s 内未收到 session.created）`)), 30_000);
      this.sessionWaiters.push({ resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, timer });
    });
    await this.updateSession({ model, instructions: this.opts.instructions });
    return session;
  }

  private correlationId = '';

  async updateSession(cfg: { model?: string; instructions?: string } = {}): Promise<void> {
    const session: Record<string, unknown> = {
      modalities: ['text', 'audio'],
      voice: this.opts.voice ?? REALTIME_DEFAULTS.defaultVoice,
      input_audio_format: REALTIME_DEFAULTS.inputAudioFormat,
      output_audio_format: REALTIME_DEFAULTS.outputAudioFormat,
      // 手动控制轮次：应用层决定何时提交回答、何时让面试官开口（D2）。
      turn_detection: null,
      input_audio_transcription: { model: this.opts.inputTranscriptionModel ?? 'qwen3-asr-flash-realtime' },
      instructions:
        cfg.instructions ??
        '你是中文面试官。当用户消息要求你朗读文本时，必须逐字朗读该文本，不得改写、增删、重复或追加任何内容；不要自行提问，不要评价回答。',
    };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('session.update 超时（未收到 session.updated）')), 20_000);
      this.createdWaiters.push({
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        timer,
      });
      this.send({ type: 'session.update', session });
    });
    // 前置断言：生效音色必须是显式指定的那个（服务端自报默认值不可信）。
    this.assertVoice();
  }

  /** D2：服务端注入要朗读的文本。模型不得自行生成问题。 */
  injectText(text: string): void {
    if (this.opts.requireVoiceAssertion !== false && !this.voiceAsserted) {
      throw new Error('拒绝注入文本：音色前置断言未通过（先 connect()+updateSession()，断言失败请新开连接）');
    }
    this.transcriptBuf = '';
    this.transcriptFinal = '';
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `请逐字朗读以下面试问题，不要添加任何其他内容：${text}` }] },
    });
    this.responseStartedAt = Date.now();
    this.resetCollector();
    this.send({ type: 'response.create', response: { modalities: ['text', 'audio'] } });
  }

  /** 送一段用户音频（s16le 16k 单声道）。 */
  appendAudio(pcm: Buffer): void {
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }, pcm.length);
  }

  /** 用户「回答完毕」：提交缓冲，触发真实 ASR。 */
  commitAudio(): void {
    this.commitSentAt = Date.now();
    this.userTranscriptBuf = '';
    this.send({ type: 'input_audio_buffer.commit' });
  }

  /** 打断：取消正在生成的回应，服务端应停止后续音频分片。 */
  cancelResponse(): void {
    this.send({ type: 'response.cancel' });
  }

  /** 只发布用户输入音频的 ASR；面试官朗读的输出转写由 waitForResponse() 单独返回。 */
  onTranscript(cb: (partial: string, final: boolean) => void): void {
    this.transcriptCbs.push(cb);
  }

  onInterviewerAudio(cb: (chunk: Buffer, seq: number) => void): void {
    this.audioCbs.push(cb);
  }

  waitForResponse(timeoutMs = 60_000): Promise<ResponseResult> {
    return new Promise<ResponseResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 response.done 超时（${timeoutMs}ms）`)), timeoutMs);
      this.responseWaiters.push({ resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, timer });
    });
  }

  waitForUserTranscript(timeoutMs = 30_000): Promise<UserTranscriptResult> {
    return new Promise<UserTranscriptResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待用户转写超时（${timeoutMs}ms）`)), timeoutMs);
      this.transcriptWaiters.push({ resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, timer });
    });
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* 忽略重复关闭 */
    }
    this.ws = null;
    this.failAll(new Error('连接已关闭'));
  }

  // ---------- 内部 ----------

  private send(obj: Record<string, unknown>, bytes?: number): void {
    if (!this.ws) throw new Error('连接尚未建立');
    this.ws.send(JSON.stringify(obj));
    this.record('send', String(obj.type), bytes);
  }

  private record(dir: 'send' | 'recv', type: string, bytes?: number, note?: string): void {
    const entry: RealtimeEventRecord = { t: Date.now() - this.origin, dir, type };
    if (bytes !== undefined) entry.bytes = bytes;
    if (note !== undefined) entry.note = note;
    this.events.push(entry);
  }

  private resetCollector(): void {
    this.audioChunks = [];
    this.audioSeq = 0;
    this.firstAudioMs = null;
    this.responseFirstAudioAt = null;
    this.responseActive = true;
  }

  private handleEvent(obj: Record<string, unknown>): void {
    const type = String(obj.type ?? 'unknown');

    if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {
      const chunk = Buffer.from(String(obj.delta ?? ''), 'base64');
      if (this.firstAudioMs === null) {
        this.firstAudioMs = Date.now() - this.responseStartedAt;
        this.responseFirstAudioAt = Date.now();
      }
      this.audioChunks.push(chunk);
      const seq = this.audioSeq++;
      this.record('recv', type, chunk.length);
      for (const cb of this.audioCbs) cb(chunk, seq);
      return;
    }
    if (type === 'response.audio_transcript.delta' || type === 'response.text.delta' || type === 'response.output_text.delta') {
      const d = String(obj.delta ?? '');
      this.transcriptBuf += d;
      this.record('recv', type, d.length);
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.delta') {
      const d = String(obj.delta ?? obj.transcript ?? '');
      this.userTranscriptBuf += d;
      this.record('recv', type, d.length);
      for (const cb of this.transcriptCbs) cb(this.userTranscriptBuf, false);
      return;
    }
    if (/delta$/.test(type)) {
      this.record('recv', type);
      return;
    }

    this.record('recv', type, undefined, type === 'error' ? JSON.stringify(obj.error ?? {}).slice(0, 300) : undefined);

    switch (type) {
      case 'session.created': {
        const s = (obj.session ?? {}) as Record<string, unknown>;
        const info: SessionInfo = {
          sessionId: String(s.id ?? ''),
          model: String(s.model ?? ''),
          voice: String(s.voice ?? ''),
          inputAudioFormat: String(s.input_audio_format ?? ''),
          outputAudioFormat: String(s.output_audio_format ?? ''),
          inputAudioTranscriptionModel: (s.input_audio_transcription as { model?: string } | undefined)?.model ?? null,
          turnDetection: s.turn_detection ?? null,
          handshakeMs: Date.now() - this.origin,
          updated: null,
        };
        this.session = info;
        this.sessionCreatedPayload = s;
        for (const w of this.sessionWaiters.splice(0)) w.resolve(info);
        break;
      }
      case 'session.updated': {
        const payload = (obj.session ?? {}) as Record<string, unknown>;
        if (this.session) this.session.updated = payload;
        this.sessionUpdatedPayload = payload;
        for (const w of this.createdWaiters.splice(0)) { clearTimeout(w.timer); w.resolve(); }
        break;
      }
      case 'response.audio_transcript.done':
        if (typeof obj.transcript === 'string' && obj.transcript !== '') {
          this.transcriptFinal = obj.transcript;
        }
        break;
      case 'response.done': {
        const resp = (obj.response ?? {}) as Record<string, unknown>;
        const result: ResponseResult = {
          transcript: this.transcriptFinal !== '' ? this.transcriptFinal : this.transcriptBuf,
          audio: Buffer.concat(this.audioChunks),
          firstAudioMs: this.firstAudioMs,
          totalMs: Date.now() - this.responseStartedAt,
          startedAt: this.responseStartedAt,
          firstAudioAt: this.responseFirstAudioAt,
          endedAt: Date.now(),
          status: String(resp.status ?? 'unknown'),
        };
        this.responseActive = false;
        for (const w of this.responseWaiters.splice(0)) w.resolve(result);
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = String(obj.transcript ?? this.userTranscriptBuf);
        const result: UserTranscriptResult = {
          transcript,
          latencyMs: this.commitSentAt === 0 ? 0 : Date.now() - this.commitSentAt,
        };
        this.userTranscriptBuf = transcript;
        for (const cb of this.transcriptCbs) cb(transcript, true);
        for (const w of this.transcriptWaiters.splice(0)) w.resolve(result);
        break;
      }
      case 'error': {
        const err = (obj.error ?? {}) as Record<string, unknown>;
        this.lastError = { code: String(err.code ?? 'unknown'), message: String(err.message ?? '') };
        this.failAll(new Error(`实时接口错误 ${this.lastError.code}：${this.lastError.message.slice(0, 200)}`));
        break;
      }
      default:
        break;
    }
  }

  private failAll(e: Error): void {
    for (const w of this.responseWaiters.splice(0)) w.reject(e);
    for (const w of this.transcriptWaiters.splice(0)) w.reject(e);
    for (const w of this.sessionWaiters.splice(0)) w.reject(e);
    for (const w of this.createdWaiters.splice(0)) { clearTimeout(w.timer); w.reject(e); }
    void this.lastError;
  }
}
