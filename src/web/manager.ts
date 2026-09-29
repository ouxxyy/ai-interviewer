/**
 * 会话管理器：把「跑着的会话」与「库里的历史会话」分开。
 *
 * - 跑着的会话有 `InterviewRunner`（状态机 + 实时桥）。
 * - 历史会话只在 SQLite 与磁盘音频里，重启后仍可列出、查看、回放、删除（验收项 2）。
 * - 删除会话时先关掉实时连接，再交给 `Store.deleteSession()` 做「数据库 + 音频 + 临时文件」清理。
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { TextLlmClient } from '../clients/types.js';
import type { CandidateMaterials, Feedback, QuestionPlan, SessionReport, Turn } from '../contracts/types.js';
import { AppError } from './errors.js';
import type { Logger } from './log.js';
import type { WebPaths } from './paths.js';
import { RealtimeBridge } from './realtime-bridge.js';
import { InterviewRunner } from './runner.js';
import type { DeleteReport, Store } from './store.js';
import { buildReviewBasis, type ReportSource, type ReviewBasisDetail, type ReviewMeta } from './session-metadata.js';

export interface CreateSessionRequest {
  synthetic?: boolean;
  saveHistory?: boolean;
  saveAudio?: boolean;
}

export interface HistorySessionDetail {
  sid: string;
  live: boolean;
  persisted: boolean;
  status: string;
  state: string;
  synthetic: boolean;
  createdAt: string;
  updatedAt: string;
  toggles: { saveHistory: boolean; saveAudio: boolean };
  materials: CandidateMaterials | null;
  plan: QuestionPlan | null;
  turns: Array<Turn & { audio: { user: boolean; interviewer: boolean } }>;
  reviews: Record<string, Feedback>;
  reviewMeta: ReviewMeta[];
  reviewBasis: Record<string, ReviewBasisDetail>;
  rewriteDeltas: Record<string, unknown>;
  report: SessionReport | null;
  reportSource: ReportSource | null;
  usage: { textCalls: number; promptTokens: number; completionTokens: number; inputAudioBytes: number; audioBytesIn: number; audioBytesOut: number };
}

export class SessionManager {
  private readonly runners = new Map<string, InterviewRunner>();

  constructor(
    private readonly opts: {
      store: Store;
      logger: Logger;
      credential: string | (() => string);
      textClient: TextLlmClient;
      textClientForSession?: (credential: string) => TextLlmClient;
      paths: WebPaths;
      realtimeModel?: string;
      voice?: string;
      createBridge?: (sid: string) => RealtimeBridge;
    },
  ) {}

  create(req: CreateSessionRequest): InterviewRunner {
    const sid = `s-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const credential = typeof this.opts.credential === 'function' ? this.opts.credential() : this.opts.credential;
    const runner = new InterviewRunner({
      store: this.opts.store,
      textClient: this.opts.textClientForSession?.(credential) ?? this.opts.textClient,
      logger: this.opts.logger,
      credential,
      sessionId: sid,
      synthetic: req.synthetic ?? true,
      saveHistory: req.saveHistory ?? true,
      saveAudio: req.saveAudio ?? true,
      ...(this.opts.realtimeModel === undefined ? {} : { realtimeModel: this.opts.realtimeModel }),
      ...(this.opts.voice === undefined ? {} : { voice: this.opts.voice }),
      ...(this.opts.createBridge === undefined ? {} : { createBridge: this.opts.createBridge }),
    });
    this.runners.set(sid, runner);
    this.opts.logger.info('session.created', { sid, synthetic: runner.synthetic, saveHistory: runner.saveHistory, saveAudio: runner.saveAudio });
    return runner;
  }

  get(sid: string): InterviewRunner | null {
    return this.runners.get(sid) ?? null;
  }

  requireLive(sid: string): InterviewRunner {
    const runner = this.runners.get(sid);
    if (!runner) {
      if (this.opts.store.getSession(sid) === null) throw new AppError('E_NOT_FOUND', `会话不存在：${sid}`);
      throw new AppError('E_CONFLICT', '该会话是历史记录（服务重启或已归档），不能继续作答；可以查看、回放或删除', {
        hint: '新建一场训练继续练习',
      });
    }
    return runner;
  }

  listLive(): string[] {
    return [...this.runners.keys()];
  }

  /** 会话详情：跑着的走内存快照，历史的走库。 */
  detail(sid: string): HistorySessionDetail {
    const runner = this.runners.get(sid);
    if (runner) {
      const snap = runner.snapshot();
      return {
        sid,
        live: true,
        persisted: runner.saveHistory,
        status: snap.status,
        state: snap.state,
        synthetic: snap.synthetic,
        createdAt: this.opts.store.getSession(sid)?.createdAt ?? '',
        updatedAt: this.opts.store.getSession(sid)?.updatedAt ?? '',
        toggles: snap.toggles,
        materials: snap.materials,
        plan: snap.plan,
        turns: snap.turns.map((t) => ({ ...t, audio: { user: runner.hasAudio(t.id, 'user'), interviewer: runner.hasAudio(t.id, 'interviewer') } })),
        reviews: snap.reviews,
        reviewMeta: snap.reviewMeta,
        reviewBasis: buildReviewBasis(snap.turns, snap.reviews),
        rewriteDeltas: snap.rewriteDeltas,
        report: snap.report,
        reportSource: snap.reportSource,
        usage: snap.usage,
      };
    }
    const session = this.opts.store.getSession(sid);
    if (!session) throw new AppError('E_NOT_FOUND', `会话不存在：${sid}`);
    const turns = this.opts.store.listTurns(sid);
    const reviews: Record<string, Feedback> = {};
    const rewriteDeltas: Record<string, unknown> = {};
    for (const qid of new Set(turns.map((t) => t.questionId))) {
      const fb = this.opts.store.getFeedback(sid, qid, 'feedback');
      if (fb !== null) reviews[qid] = fb as Feedback;
      const delta = this.opts.store.getFeedback(sid, qid, 'rewrite_delta');
      if (delta !== null) rewriteDeltas[qid] = delta;
    }
    return {
      sid,
      live: false,
      persisted: true,
      status: session.status,
      state: session.state,
      synthetic: session.synthetic,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      toggles: { saveHistory: true, saveAudio: session.saveAudio },
      materials: session.materials,
      plan: session.plan,
      turns: turns.map((t) => ({
        ...t,
        audio: {
          user: this.audioExists(sid, t.id, 'user'),
          interviewer: this.audioExists(sid, t.id, 'interviewer'),
        },
      })),
      reviews,
      reviewMeta: session.reviewMeta,
      reviewBasis: buildReviewBasis(turns, reviews),
      rewriteDeltas,
      report: session.report,
      reportSource: session.reportSource,
      usage: { textCalls: 0, promptTokens: 0, completionTokens: 0, inputAudioBytes: 0, audioBytesIn: 0, audioBytesOut: 0 },
    };
  }

  audioExists(sid: string, turnId: string, track: 'user' | 'interviewer'): boolean {
    const session = this.opts.store.getSession(sid);
    if (!session) return false;
    const dir = path.join(this.opts.paths.audioDir, sid);
    return existsSync(path.join(dir, `turn-${turnId}-${track}.wav`));
  }

  readAudio(sid: string, turnId: string, track: 'user' | 'interviewer'): { wav: Buffer; source: 'file' | 'memory'; sampleRate: number } {
    const res = this.opts.store.readAudio(sid, turnId, track);
    if (!res.ok) {
      if (res.reason === 'not_saved') throw new AppError('E_NOT_FOUND', '这一轮没有保存录音（本场关闭了「保存录音」，或该轮没有音频）');
      throw new AppError('E_NOT_FOUND', '录音文件不存在（可能已被删除）');
    }
    return { wav: res.wav, source: res.source, sampleRate: res.sampleRate };
  }

  delete(sid: string): DeleteReport {
    const runner = this.runners.get(sid);
    if (runner) {
      runner.close();
      this.runners.delete(sid);
    }
    const report = this.opts.store.deleteSession(sid);
    this.opts.logger.info('session.deleted', {
      sid,
      removedSessions: report.removed.sessions,
      removedTurns: report.removed.turns,
      removedAudioFiles: report.removed.audioFiles.length,
      removedTmpFiles: report.removed.tmpFiles.length,
      verified: report.verified,
    });
    return report;
  }

  closeAll(): void {
    for (const runner of this.runners.values()) runner.close();
    this.runners.clear();
  }

  /** 只读：把磁盘上的 WAV 读出来做校验（证据运行会核对 sha256）。 */
  readWavFile(sid: string, turnId: string, track: 'user' | 'interviewer'): Buffer | null {
    const file = path.join(this.opts.paths.audioDir, sid, `turn-${turnId}-${track}.wav`);
    return existsSync(file) ? readFileSync(file) : null;
  }
}
