/**
 * 服务端实时语音桥（MYW-85「服务端代理」）。
 *
 * 职责：
 * - 浏览器只连本地服务；DashScope WebSocket 由服务端持有，密钥不出本机（浏览器拿不到，日志也不记）。
 * - 两个 T1-R 实测坑**前置处理**：
 *   ① 音色必须在首个 `response.create` 之前断言 `Serena`——服务端自报默认 `Chelsie` 会被 400 拒；
 *   ② 同一连接撞 400 之后再 `session.update` 不会恢复 → **必须新开连接**（本模块在任何 400 之后
 *      直接丢弃旧连接、新建一个，并对同一句话只重放一次）。
 * - 打断：`response.cancel` 之后**不再向浏览器转发旧回应的音频分片**（待播音频在浏览器侧同时清空）。
 * - 暂停：暂停期间拒绝一切上行音频（`accepted:false, reason:'paused'`），恢复后才继续收。
 */
import { DashscopeRealtimeClient, REALTIME_DEFAULTS, type RealtimeEventRecord, type ResponseResult, type SessionInfo, type UserTranscriptResult } from '../clients/realtime-dashscope.js';
import type { Logger } from './log.js';

/** 桥依赖的实时客户端形态（真实实现＝DashscopeRealtimeClient；测试注入 mock）。 */
export interface RealtimeLike {
  readonly events: RealtimeEventRecord[];
  readonly isVoiceAsserted: boolean;
  open(sessionId: string): Promise<SessionInfo>;
  injectText(text: string): void;
  appendAudio(pcm: Buffer): void;
  commitAudio(): void;
  cancelResponse(): void;
  onTranscript(cb: (partial: string, final: boolean) => void): void;
  onInterviewerAudio(cb: (chunk: Buffer, seq: number) => void): void;
  waitForResponse(timeoutMs?: number): Promise<ResponseResult>;
  waitForUserTranscript(timeoutMs?: number): Promise<UserTranscriptResult>;
  close(): void;
}

export interface BridgeOptions {
  credential: string;
  model?: string;
  voice?: string;
  inputTranscriptionModel?: string;
  createClient?: (opts: { credential: string; model?: string; voice?: string; inputTranscriptionModel?: string }) => RealtimeLike;
  onInterviewerAudio?: (chunk: Buffer, seq: number) => void;
  onUserTranscript?: (partial: string, final: boolean) => void;
  logger?: Logger;
  responseTimeoutMs?: number;
  transcriptTimeoutMs?: number;
}

export interface SpeakResult {
  text: string;
  /** 模型实际朗读出来的文本（转写）。 */
  transcript: string;
  audioPcm: Buffer;
  firstAudioMs: number | null;
  totalMs: number;
  status: string;
  cancelled: boolean;
  deltasBeforeCancel: number;
  deltasAfterCancel: number;
  bytesAfterCancel: number;
  reconnects: number;
}

export interface CommitResult {
  transcript: string;
  latencyMs: number;
  empty: boolean;
  reconnects: number;
}

export interface BridgeStats {
  connections: number;
  reconnects: number;
  cancels: number;
  pausedRejections: number;
  audioBytesIn: number;
  audioBytesOut: number;
  responses: number;
  firstAudioMsSamples: number[];
}

const MAX_APPEND_BYTES = 8 * 1024 * 1024;

function isPoisonedConnectionError(message: string): boolean {
  return /<400>|InvalidPar|Voice '.*' is not supported|音色前置断言失败|400/.test(message);
}

/** 上游瞬时错误（实测：COMMON_ERROR 里带 `Connect call failed`／内部服务不可达）——换新连接重试一次。 */
function isTransientUpstreamError(message: string): boolean {
  return /COMMON_ERROR|Connect call failed|socket error|InternalError|503|502|504|超时|timeout|等待 response\.done 超时|等待用户转写超时/i.test(message);
}

/** 额度／配额错误：立刻停，不重试（Mika 的止损要求）。 */
export function isQuotaError(message: string): boolean {
  return /1310|bigmodel|usage limit|配额|额度不足|Arrearage|欠费|Quota/i.test(message);
}

export class RealtimeBridge {
  private client: RealtimeLike | null = null;
  private session: SessionInfo | null = null;
  private readonly stats_: BridgeStats = {
    connections: 0,
    reconnects: 0,
    cancels: 0,
    pausedRejections: 0,
    audioBytesIn: 0,
    audioBytesOut: 0,
    responses: 0,
    firstAudioMsSamples: [],
  };
  private audioSink: ((chunk: Buffer, seq: number) => void) | null = null;
  private transcriptSink: ((partial: string, final: boolean) => void) | null = null;
  private pausedFlag = false;
  private cancelled = false;
  private deltasBeforeCancel = 0;
  private deltasAfterCancel = 0;
  private bytesAfterCancel = 0;
  private speaking = false;

  constructor(private readonly opts: BridgeOptions) {}

  get stats(): BridgeStats {
    return this.stats_;
  }

  get sessionInfo(): SessionInfo | null {
    return this.session;
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  /** 把面试官音频实时转给浏览器（与落盘并行，互不影响）。 */
  setAudioSink(cb: ((chunk: Buffer, seq: number) => void) | null): void {
    this.audioSink = cb;
  }

  /** 把用户转写的中间结果转给浏览器（页面实时显示）。 */
  setTranscriptSink(cb: ((partial: string, final: boolean) => void) | null): void {
    this.transcriptSink = cb;
  }

  /** 打断观测：取消前后的音频分片计数（证据用）。 */
  get cancelStats(): { deltasBeforeCancel: number; deltasAfterCancel: number; bytesAfterCancel: number } {
    return { deltasBeforeCancel: this.deltasBeforeCancel, deltasAfterCancel: this.deltasAfterCancel, bytesAfterCancel: this.bytesAfterCancel };
  }

  get events(): RealtimeEventRecord[] {
    return this.client?.events ?? [];
  }

  /** 建立连接并完成音色前置断言；失败即换新连接重试一次（同连接自愈不可用）。 */
  async ensureOpen(sessionId: string): Promise<{ session: SessionInfo; reconnects: number }> {
    if (this.client && this.session) return { session: this.session, reconnects: this.stats_.reconnects };
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const session = await this.openFresh(`${sessionId}${attempt > 1 ? `-retry${attempt}` : ''}`);
        if (attempt > 1) this.stats_.reconnects += 1;
        return { session, reconnects: this.stats_.reconnects };
      } catch (e) {
        lastError = e as Error;
        this.dropConnection();
        this.opts.logger?.warn('realtime.open_failed', { sessionId, attempt, error: (e as Error).message, next: 'new_connection' });
      }
    }
    throw new Error(`实时连接建立失败（已按规则新开连接重试一次）：${lastError?.message ?? '未知原因'}`);
  }

  /** 新开一条连接（音色前置断言必须通过），旧的调用方负责先 drop。 */
  private async openFresh(sessionId: string): Promise<SessionInfo> {
    this.dropConnection();
    const client = this.createClient();
    this.client = client;
    this.wire(client);
    const session = await client.open(sessionId);
    if (!client.isVoiceAsserted) {
      client.close();
      this.client = null;
      throw new Error('音色前置断言未通过：session.updated 未回显生效音色');
    }
    this.session = session;
    this.stats_.connections += 1;
    this.opts.logger?.info('realtime.session_ready', {
      sessionId,
      model: session.model,
      voice: session.updated?.voice ?? session.voice,
      turnDetection: session.turnDetection === null ? 'null(manual)' : 'auto',
      handshakeMs: session.handshakeMs,
    });
    return session;
  }

  private dropConnection(): void {
    try {
      this.client?.close();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.session = null;
  }

  private createClient(): RealtimeLike {
    if (this.opts.createClient) {
      return this.opts.createClient({
        credential: this.opts.credential,
        ...(this.opts.model === undefined ? {} : { model: this.opts.model }),
        ...(this.opts.voice === undefined ? {} : { voice: this.opts.voice }),
        ...(this.opts.inputTranscriptionModel === undefined ? {} : { inputTranscriptionModel: this.opts.inputTranscriptionModel }),
      });
    }
    return new DashscopeRealtimeClient(this.opts.credential, {
      ...(this.opts.model === undefined ? {} : { model: this.opts.model }),
      voice: this.opts.voice ?? REALTIME_DEFAULTS.defaultVoice,
      ...(this.opts.inputTranscriptionModel === undefined ? {} : { inputTranscriptionModel: this.opts.inputTranscriptionModel }),
    });
  }

  private wire(client: RealtimeLike): void {
    client.onInterviewerAudio((chunk, seq) => {
      if (this.cancelled) {
        // 打断之后旧回应的分片一律丢弃，不再转发给浏览器（避免"取消了还在响"）。
        this.deltasAfterCancel += 1;
        this.bytesAfterCancel += chunk.length;
        return;
      }
      this.deltasBeforeCancel += 1;
      this.stats_.audioBytesOut += chunk.length;
      this.opts.onInterviewerAudio?.(chunk, seq);
      this.audioSink?.(chunk, seq);
    });
    client.onTranscript((partial, final) => {
      this.opts.onUserTranscript?.(partial, final);
      this.transcriptSink?.(partial, final);
    });
  }

  /** 面试官朗读应用层下发的文本（D2：语音层不得自造问题）。 */
  async speak(text: string): Promise<SpeakResult> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!this.client || !this.session) await this.ensureOpen(`speak${attempt > 1 ? `-retry${attempt}` : ''}`);
      const client = this.client!;
      this.cancelled = false;
      this.deltasBeforeCancel = 0;
      this.deltasAfterCancel = 0;
      this.bytesAfterCancel = 0;
      this.speaking = true;
      try {
        const pending = client.waitForResponse(this.opts.responseTimeoutMs ?? 90_000);
        client.injectText(text);
        const res = await pending;
        this.speaking = false;
        this.stats_.responses += 1;
        if (res.firstAudioMs !== null) this.stats_.firstAudioMsSamples.push(res.firstAudioMs);
        return {
          text,
          transcript: res.transcript,
          audioPcm: res.audio,
          firstAudioMs: res.firstAudioMs,
          totalMs: res.totalMs,
          status: res.status,
          cancelled: res.status === 'cancelled' || this.cancelled,
          deltasBeforeCancel: this.deltasBeforeCancel,
          deltasAfterCancel: this.deltasAfterCancel,
          bytesAfterCancel: this.bytesAfterCancel,
          reconnects: this.stats_.reconnects,
        };
      } catch (e) {
        this.speaking = false;
        lastError = e as Error;
        const message = lastError.message;
        const poisoned = isPoisonedConnectionError(message);
        const quota = isQuotaError(message);
        const transient = isTransientUpstreamError(message);
        this.opts.logger?.warn('realtime.speak_failed', { attempt, error: message, poisoned, transient, quota });
        if (quota) throw new Error(`实时接口额度不足（按止损不重试）：${message}`);
        if ((!poisoned && !transient) || attempt >= 2) break;
        // 坑②：撞 400 的连接不会自愈 → 丢掉它，新开连接，同一句话只重放一次。
        // 上游瞬时故障同理：换一条新连接重试一次（不重试第三次）。
        this.stats_.reconnects += 1;
        this.dropConnection();
      }
    }
    throw new Error(`面试官语音生成失败：${lastError?.message ?? '未知原因'}`);
  }

  appendUserAudio(pcm: Buffer): { accepted: boolean; reason?: 'paused' | 'not_open' | 'too_large' } {
    if (this.pausedFlag) {
      this.stats_.pausedRejections += 1;
      return { accepted: false, reason: 'paused' };
    }
    const client = this.client;
    if (!client || !this.session) return { accepted: false, reason: 'not_open' };
    if (pcm.length === 0) return { accepted: true };
    if (pcm.length > MAX_APPEND_BYTES) return { accepted: false, reason: 'too_large' };
    client.appendAudio(pcm);
    this.stats_.audioBytesIn += pcm.length;
    return { accepted: true };
  }

  /** 用户「回答完毕」：提交缓冲并等真实 ASR 转写。空转写由调用方决定状态（不在这里伪造内容）。 */
  async commitUserAudio(): Promise<CommitResult> {
    const client = this.client;
    if (!client || !this.session) throw new Error('实时连接尚未建立：先 ensureOpen()');
    const pending = client.waitForUserTranscript(this.opts.transcriptTimeoutMs ?? 45_000);
    client.commitAudio();
    const res = await pending;
    return { transcript: res.transcript, latencyMs: res.latencyMs, empty: res.transcript.trim() === '', reconnects: this.stats_.reconnects };
  }

  /** 打断：取消旧回应，并让后续分片不再转发。 */
  cancel(): void {
    this.cancelled = true;
    this.stats_.cancels += 1;
    try {
      this.client?.cancelResponse();
    } catch {
      /* 连接已断时忽略 */
    }
    this.opts.logger?.info('realtime.cancel', { deltasBeforeCancel: this.deltasBeforeCancel });
  }

  pause(): void {
    this.pausedFlag = true;
  }

  resume(): void {
    this.pausedFlag = false;
  }

  close(): void {
    try {
      this.client?.close();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.session = null;
  }
}
