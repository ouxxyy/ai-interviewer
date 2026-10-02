/**
 * 会话／轮次／反馈／报告的存取（网页入口数据层）。
 *
 * 关键语义：
 * - **两开关按会话快照**：会话创建时把当时的 `saveHistory`／`saveAudio` 记下来，整场按它执行，
 *   避免「跑一半改开关」产生半持久状态。
 * - `saveHistory=false` → 会话只活在内存（`persisted=false`），不写库、不写音频；
 *   `saveAudio=false` → 写库但 `audioFile=null`，磁盘上不产生音频文件。
 * - 关开关**不删旧记录**；删除只发生在显式 `deleteSession()`。
 * - 回放口径：优先磁盘文件；`saveAudio=false` 的活跃会话仍可从内存回放**本场**音频（标注 `source: memory`），
 *   内存音频有上限，超出后该场回放不可用并如实返回 `unavailable`。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pcmToWav, sha256, pcmDurationSeconds } from '../t1r/audio.js';
import { validateContractAuto } from '../contracts/validate.js';
import type { CandidateMaterials, Feedback, QuestionPlan, SessionReport, Turn } from '../contracts/types.js';
import type { SessionState } from '../state/machine.js';
import type { InterviewDb } from './db.js';
import { sessionAudioDir, webPaths, type WebPaths } from './paths.js';
import type { ReportSource, ReviewMeta } from './session-metadata.js';

export type SessionStatus = 'active' | 'report' | 'ended';
export type AudioTrack = 'user' | 'interviewer';

export interface StoredSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  state: SessionState;
  synthetic: boolean;
  saveHistory: boolean;
  saveAudio: boolean;
  persisted: boolean;
  ruleVersion: string;
  realtimeModel: string | null;
  textModel: string | null;
  materials: CandidateMaterials | null;
  plan: QuestionPlan | null;
  report: SessionReport | null;
  reportSource: ReportSource | null;
  reviewMeta: ReviewMeta[];
  completedQuestions: number;
}

export interface AudioRecord {
  /** 相对数据根目录的路径；未落盘（关录音）时为 null。 */
  file: string | null;
  bytes: number;
  sampleRate: number;
  seconds: number;
  sha256: string;
  /** true＝磁盘上有 WAV 文件；false＝只在本场内存里（关录音时仍可回放本场）。 */
  persisted: boolean;
  source: 'file' | 'memory';
}

export interface SessionListItem {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  state: SessionState;
  synthetic: boolean;
  completedQuestions: number;
  introductionStatus: 'reviewed' | 'skipped' | 'not_reached' | 'not_included';
  completedExperienceQuestions: number;
  totalExperienceQuestions: number;
  turns: number;
  hasReport: boolean;
  audioFiles: number;
}

interface MemoryAudio {
  pcm: Buffer;
  sampleRate: number;
  at: number;
  sha256: string;
}

const MAX_MEMORY_AUDIO_BYTES = 24 * 1024 * 1024; // 约 12 分钟 16k 单声道 PCM

export interface CreateSessionInput {
  id: string;
  ruleVersion: string;
  realtimeModel: string | null;
  textModel: string | null;
  synthetic: boolean;
  saveHistory: boolean;
  saveAudio: boolean;
  state?: SessionState;
}

export class Store {
  private readonly paths: WebPaths;
  private readonly live = new Map<string, StoredSession>();
  private readonly turns = new Map<string, Turn[]>();
  private readonly feedbacks = new Map<string, Map<string, unknown>>();
  private readonly memoryAudio = new Map<string, Map<string, MemoryAudio>>();

  constructor(private readonly db: InterviewDb, paths: WebPaths = webPaths()) {
    this.paths = paths;
    for (const dir of [this.paths.root, this.paths.audioDir, this.paths.tmpDir, this.paths.uploadTmpDir]) mkdirSync(dir, { recursive: true });
  }

  get dataPaths(): WebPaths {
    return this.paths;
  }

  // ---------- 会话 ----------

  createSession(input: CreateSessionInput): StoredSession {
    const now = new Date().toISOString();
    const session: StoredSession = {
      id: input.id,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      state: input.state ?? 'materials_review',
      synthetic: input.synthetic,
      saveHistory: input.saveHistory,
      saveAudio: input.saveAudio,
      persisted: false,
      ruleVersion: input.ruleVersion,
      realtimeModel: input.realtimeModel,
      textModel: input.textModel,
      materials: null,
      plan: null,
      report: null,
      reportSource: null,
      reviewMeta: [],
      completedQuestions: 0,
    };
    this.live.set(session.id, session);
    this.turns.set(session.id, []);
    this.feedbacks.set(session.id, new Map());
    this.persist(session);
    return session;
  }

  /** 只在「保存历史」开启时落库；否则会话仅存在于内存。 */
  private persist(session: StoredSession): void {
    if (!session.saveHistory) return;
    this.db.raw
      .prepare(
        `INSERT INTO sessions (id, created_at, updated_at, status, state, synthetic, save_audio, rule_version, realtime_model, text_model, materials_json, plan_json, report_json, report_source, review_meta_json, completed_questions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, status = excluded.status, state = excluded.state,
           materials_json = excluded.materials_json, plan_json = excluded.plan_json, report_json = excluded.report_json,
           report_source = excluded.report_source, review_meta_json = excluded.review_meta_json,
           completed_questions = excluded.completed_questions, realtime_model = excluded.realtime_model, text_model = excluded.text_model`,
      )
      .run(
        session.id,
        session.createdAt,
        session.updatedAt,
        session.status,
        session.state,
        session.synthetic ? 1 : 0,
        session.saveAudio ? 1 : 0,
        session.ruleVersion,
        session.realtimeModel,
        session.textModel,
        session.materials === null ? null : JSON.stringify(session.materials),
        session.plan === null ? null : JSON.stringify(session.plan),
        session.report === null ? null : JSON.stringify(session.report),
        session.reportSource,
        JSON.stringify(session.reviewMeta),
        session.completedQuestions,
      );
    session.persisted = true;
  }

  getSession(id: string): StoredSession | null {
    const memory = this.live.get(id);
    if (memory) return memory;
    const row = this.db.raw.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row === undefined ? null : fromRow(row);
  }

  updateSession(
    id: string,
    patch: Partial<Pick<StoredSession, 'state' | 'status' | 'materials' | 'plan' | 'report' | 'reportSource' | 'reviewMeta' | 'completedQuestions' | 'realtimeModel' | 'textModel'>>,
  ): StoredSession {
    const session = this.getSession(id);
    if (!session) throw new Error(`会话不存在：${id}`);
    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
    this.persist(session);
    return session;
  }

  listSessions(opts: { limit?: number; offset?: number; includeSynthetic?: boolean } = {}): { items: SessionListItem[]; total: number; limit: number; offset: number } {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const where = opts.includeSynthetic === false ? 'WHERE synthetic = 0' : '';
    const total = Number((this.db.raw.prepare(`SELECT COUNT(*) AS n FROM sessions ${where}`).get() as { n: number }).n);
    const rows = this.db.raw
      .prepare(`SELECT * FROM sessions ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as unknown as SessionRow[];
    return { items: rows.map((r) => this.toListItem(r)), total, limit, offset };
  }

  private toListItem(row: SessionRow): SessionListItem {
    const turns = Number((this.db.raw.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?').get(row.id) as { n: number }).n);
    const audioFiles = this.listAudioFiles(row.id).length;
    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status as SessionStatus,
      state: row.state as SessionState,
      synthetic: Number(row.synthetic) === 1,
      completedQuestions: Number(row.completed_questions),
      ...this.trainingSummary(fromRow(row)),
      turns,
      hasReport: row.report_json !== null,
      audioFiles,
    };
  }

  private trainingSummary(session: StoredSession): Pick<SessionListItem, 'introductionStatus' | 'completedExperienceQuestions' | 'totalExperienceQuestions'> {
    const questions = session.report?.perQuestion ?? session.plan?.questions.map((q) => ({ questionId: q.id, kind: q.kind, status: null })) ?? [];
    const introduction = questions.find((q) => q.kind === 'introduction');
    const hasIntroduction = introduction !== undefined || sessionContractVersion(session) === '0.3.0';
    if (!hasIntroduction) {
      return { introductionStatus: 'not_included', completedExperienceQuestions: session.report?.completedQuestions ?? session.completedQuestions, totalExperienceQuestions: session.report?.totalQuestions ?? session.plan?.questions.length ?? 3 };
    }
    const experiences = questions.filter((q) => q.kind === 'experience');
    const reviewed = (q: { questionId: string; status: string | null; feedback?: Feedback | null }): boolean => {
      if (session.report !== null) return q.status === 'reviewed' && q.feedback != null && q.feedback.questionId === q.questionId && validateContractAuto('feedback', q.feedback).ok;
      const latest = [...session.reviewMeta].reverse().find((meta) => meta.questionId === q.questionId);
      const feedback = this.getFeedback(session.id, q.questionId, 'feedback');
      return latest?.kind === 'ok' && validateContractAuto('feedback', feedback).ok && (feedback as Feedback).questionId === q.questionId;
    };
    const introReviewed = introduction !== undefined && reviewed(introduction);
    const introReached = introduction !== undefined && this.listTurns(session.id).some((t) => t.questionId === introduction.questionId);
    return {
      introductionStatus: introReviewed ? 'reviewed' : introduction?.status === 'skipped' || introReached ? 'skipped' : 'not_reached',
      completedExperienceQuestions: experiences.filter(reviewed).length,
      totalExperienceQuestions: experiences.length || 3,
    };
  }

  /** 真实会话与虚构演示分开统计（D9：演示不进真实报告统计）。 */
  stats(): { real: number; synthetic: number; turns: number; audioFiles: number; audioBytes: number; dataRoot: string } {
    const rows = this.db.raw.prepare('SELECT synthetic, COUNT(*) AS n FROM sessions GROUP BY synthetic').all() as Array<{ synthetic: number; n: number }>;
    const real = Number(rows.find((r) => Number(r.synthetic) === 0)?.n ?? 0);
    const synthetic = Number(rows.find((r) => Number(r.synthetic) === 1)?.n ?? 0);
    const turns = Number((this.db.raw.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number }).n);
    const files = this.listAllAudioFiles();
    return {
      real,
      synthetic,
      turns,
      audioFiles: files.length,
      audioBytes: files.reduce((a, f) => a + f.bytes, 0),
      dataRoot: path.relative(process.cwd(), this.paths.root),
    };
  }

  // ---------- 轮次 ----------

  addTurn(sessionId: string, turn: Turn, audio?: { track: AudioTrack; pcm: Buffer; sampleRate: number }): Turn {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`会话不存在：${sessionId}`);
    const stored: Turn = { ...turn, audioFile: null };
    let bytes: number | null = null;
    let sampleRate: number | null = null;
    let digest: string | null = null;
    if (audio && audio.pcm.length > 0) {
      bytes = audio.pcm.length;
      sampleRate = audio.sampleRate;
      digest = sha256(audio.pcm);
      if (session.saveHistory && session.saveAudio) {
        stored.audioFile = this.writeWav(session.id, turn.id, audio.track, audio.pcm, audio.sampleRate);
      } else {
        // 关录音时不留文件，但本场仍可在内存里回放（回放范围以实际采集/播放为准）。
        this.rememberMemoryAudio(session.id, turn.id, audio.track, audio.pcm, audio.sampleRate, digest);
      }
    }
    const list = this.turns.get(sessionId) ?? [];
    list.push(stored);
    this.turns.set(sessionId, list);
    if (session.saveHistory) {
      this.db.raw
        .prepare(
          `INSERT INTO turns (id, session_id, question_id, speaker, turn_type, seq, started_at, ended_at, raw_transcript, revised_text, audio_file, audio_bytes, audio_sample_rate, audio_sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          stored.id,
          sessionId,
          stored.questionId,
          stored.speaker,
          stored.turnType,
          stored.seq,
          stored.startedAt,
          stored.endedAt,
          stored.rawTranscript,
          stored.revisedText,
          stored.audioFile,
          bytes,
          sampleRate,
          digest,
        );
      session.updatedAt = new Date().toISOString();
      this.persist(session);
    }
    return stored;
  }

  listTurns(sessionId: string): Turn[] {
    const memory = this.turns.get(sessionId);
    if (memory) return [...memory].sort((a, b) => a.seq - b.seq);
    const rows = this.db.raw.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY seq ASC').all(sessionId) as unknown as TurnRow[];
    const version = sessionContractVersion(this.getSession(sessionId));
    return rows.map((row) => toTurn(row, version));
  }

  reviseTurn(sessionId: string, turnId: string, revisedText: string | null): Turn {
    const list = this.listTurns(sessionId);
    const turn = list.find((t) => t.id === turnId);
    if (!turn) throw new Error(`轮次不存在：${turnId}`);
    turn.revisedText = revisedText;
    const memory = this.turns.get(sessionId);
    if (memory) {
      const idx = memory.findIndex((t) => t.id === turnId);
      if (idx >= 0) memory[idx] = turn;
    }
    this.db.raw.prepare('UPDATE turns SET revised_text = ? WHERE session_id = ? AND id = ?').run(revisedText, sessionId, turnId);
    return turn;
  }

  // ---------- 反馈与报告 ----------

  saveFeedback(sessionId: string, questionId: string, kind: 'feedback' | 'rewrite_delta', payload: Feedback | unknown): void {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`会话不存在：${sessionId}`);
    const map = this.feedbacks.get(sessionId) ?? new Map<string, unknown>();
    map.set(`${questionId}:${kind}`, payload);
    this.feedbacks.set(sessionId, map);
    if (session.saveHistory) {
      this.db.raw
        .prepare(
          `INSERT INTO feedbacks (session_id, question_id, kind, json, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id, question_id, kind) DO UPDATE SET json = excluded.json, created_at = excluded.created_at`,
        )
        .run(sessionId, questionId, kind, JSON.stringify(payload), new Date().toISOString());
    }
  }

  /** 修订后的旧点评必须从内存和持久记录同时失效，避免重评失败后历史显示旧评分。 */
  deleteFeedback(sessionId: string, questionId: string, kind: 'feedback' | 'rewrite_delta'): void {
    this.feedbacks.get(sessionId)?.delete(`${questionId}:${kind}`);
    this.db.raw.prepare('DELETE FROM feedbacks WHERE session_id = ? AND question_id = ? AND kind = ?').run(sessionId, questionId, kind);
  }

  getFeedback(sessionId: string, questionId: string, kind: 'feedback' | 'rewrite_delta'): unknown | null {
    const memory = this.feedbacks.get(sessionId)?.get(`${questionId}:${kind}`);
    if (memory !== undefined) return memory;
    const row = this.db.raw
      .prepare('SELECT json FROM feedbacks WHERE session_id = ? AND question_id = ? AND kind = ?')
      .get(sessionId, questionId, kind) as { json: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.json) as unknown);
  }

  // ---------- 音频 ----------

  /** 把 PCM 落成 WAV；返回相对数据根的路径。调用方已确认 `saveHistory && saveAudio`。 */
  private writeWav(sessionId: string, turnId: string, track: AudioTrack, pcm: Buffer, sampleRate: number): string {
    const dir = sessionAudioDir(this.paths, sessionId);
    mkdirSync(dir, { recursive: true });
    const fileName = `turn-${turnId}-${track}.wav`;
    writeFileSync(path.join(dir, fileName), pcmToWav(pcm, sampleRate));
    return path.relative(this.paths.root, path.join(dir, fileName));
  }

  private rememberMemoryAudio(sessionId: string, turnId: string, track: AudioTrack, pcm: Buffer, sampleRate: number, digest: string): void {
    const map = this.memoryAudio.get(sessionId) ?? new Map<string, MemoryAudio>();
    map.set(`${turnId}:${track}`, { pcm, sampleRate, at: Date.now(), sha256: digest });
    let total = 0;
    for (const v of map.values()) total += v.pcm.length;
    // 超上限时丢最旧的，避免长时间会话把内存吃满；丢弃后回放会如实返回 unavailable。
    while (total > MAX_MEMORY_AUDIO_BYTES && map.size > 1) {
      const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at)[0]!;
      total -= oldest[1].pcm.length;
      map.delete(oldest[0]);
    }
    this.memoryAudio.set(sessionId, map);
  }

  /** 某轮某轨的音频元信息；磁盘优先，其次本场内存。没有则 null。 */
  describeAudio(sessionId: string, turnId: string, track: AudioTrack): AudioRecord | null {
    const turn = this.listTurns(sessionId).find((t) => t.id === turnId);
    if (turn?.audioFile) {
      const full = path.join(this.paths.root, turn.audioFile);
      if (existsSync(full)) {
        const pcm = readFileSync(full).subarray(44);
        return {
          file: turn.audioFile,
          bytes: pcm.length,
          sampleRate: 0,
          seconds: 0,
          sha256: sha256(pcm),
          persisted: true,
          source: 'file',
        };
      }
    }
    const mem = this.memoryAudio.get(sessionId)?.get(`${turnId}:${track}`);
    if (mem) {
      return {
        file: null,
        bytes: mem.pcm.length,
        sampleRate: mem.sampleRate,
        seconds: pcmDurationSeconds(mem.pcm, mem.sampleRate),
        sha256: mem.sha256,
        persisted: false,
        source: 'memory',
      };
    }
    const row = this.db.raw
      .prepare('SELECT audio_file, audio_bytes, audio_sample_rate, audio_sha256 FROM turns WHERE session_id = ? AND id = ?')
      .get(sessionId, turnId) as { audio_file: string | null; audio_bytes: number | null; audio_sample_rate: number | null; audio_sha256: string | null } | undefined;
    if (row?.audio_file) {
      const full = path.join(this.paths.root, row.audio_file);
      if (existsSync(full)) {
        return { file: row.audio_file, bytes: Number(row.audio_bytes ?? 0), sampleRate: Number(row.audio_sample_rate ?? 0), seconds: 0, sha256: row.audio_sha256 ?? '', persisted: true, source: 'file' };
      }
    }
    return null;
  }

  /** 回放取音频：磁盘优先，其次本场内存。 */
  readAudio(sessionId: string, turnId: string, track: AudioTrack): { ok: true; wav: Buffer; source: 'file' | 'memory'; sampleRate: number } | { ok: false; reason: 'not_found' | 'not_saved' } {
    const turn = this.listTurns(sessionId).find((t) => t.id === turnId);
    if (turn?.audioFile) {
      const full = path.join(this.paths.root, turn.audioFile);
      if (existsSync(full)) return { ok: true, wav: readFileSync(full), source: 'file', sampleRate: 0 };
      return { ok: false, reason: 'not_found' };
    }
    const mem = this.memoryAudio.get(sessionId)?.get(`${turnId}:${track}`);
    if (mem) return { ok: true, wav: pcmToWav(mem.pcm, mem.sampleRate), source: 'memory', sampleRate: mem.sampleRate };
    const row = this.db.raw.prepare('SELECT audio_file FROM turns WHERE session_id = ? AND id = ?').get(sessionId, turnId) as { audio_file: string | null } | undefined;
    if (row?.audio_file) {
      const full = path.join(this.paths.root, row.audio_file);
      if (existsSync(full)) return { ok: true, wav: readFileSync(full), source: 'file', sampleRate: 0 };
      return { ok: false, reason: 'not_found' };
    }
    return { ok: false, reason: 'not_saved' };
  }

  listAudioFiles(sessionId: string): Array<{ path: string; bytes: number }> {
    const dir = sessionAudioDir(this.paths, sessionId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith('.wav'))
      .map((n) => ({ path: path.relative(this.paths.root, path.join(dir, n)), bytes: statSync(path.join(dir, n)).size }));
  }

  private listAllAudioFiles(): Array<{ path: string; bytes: number }> {
    if (!existsSync(this.paths.audioDir)) return [];
    const out: Array<{ path: string; bytes: number }> = [];
    for (const sid of readdirSync(this.paths.audioDir)) {
      out.push(...this.listAudioFiles(sid));
    }
    return out;
  }

  listTmpFiles(sessionId: string): string[] {
    if (!existsSync(this.paths.tmpDir)) return [];
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.includes(sessionId)) out.push(path.relative(this.paths.root, full));
      }
    };
    walk(this.paths.tmpDir);
    return out;
  }

  // ---------- 删除 ----------

  /** 显式删除会话：数据库记录 + 音频文件 + 该会话的临时文件，并返回删除前后对照。 */
  deleteSession(id: string): DeleteReport {
    const before = this.inspect(id);
    rmSync(sessionAudioDir(this.paths, id), { recursive: true, force: true });
    const tmpRemoved: string[] = [];
    for (const rel of before.tmpFiles) {
      rmSync(path.join(this.paths.root, rel), { force: true });
      tmpRemoved.push(rel);
    }
    this.db.raw.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    this.live.delete(id);
    this.turns.delete(id);
    this.feedbacks.delete(id);
    this.memoryAudio.delete(id);
    const after = this.inspect(id);
    return {
      id,
      removed: {
        sessions: before.rows.sessions - after.rows.sessions,
        turns: before.rows.turns - after.rows.turns,
        feedbacks: before.rows.feedbacks - after.rows.feedbacks,
        audioFiles: before.audioFiles.map((f) => f.path),
        tmpFiles: tmpRemoved,
      },
      before,
      after,
      verified: after.rows.sessions === 0 && after.rows.turns === 0 && after.rows.feedbacks === 0 && after.audioFiles.length === 0 && after.tmpFiles.length === 0,
    };
  }

  private inspect(id: string): SessionInspection {
    const count = (table: string, column = 'session_id'): number =>
      Number((this.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id) as { n: number }).n);
    return {
      rows: {
        sessions: Number((this.db.raw.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(id) as { n: number }).n),
        turns: count('turns'),
        feedbacks: count('feedbacks'),
      },
      audioFiles: this.listAudioFiles(id),
      tmpFiles: this.listTmpFiles(id),
      turnsInMemory: this.turns.get(id)?.length ?? 0,
      memoryAudioKeys: this.memoryAudio.get(id)?.size ?? 0,
      audioDirExists: existsSync(sessionAudioDir(this.paths, id)),
    };
  }
}

export interface SessionInspection {
  rows: { sessions: number; turns: number; feedbacks: number };
  audioFiles: Array<{ path: string; bytes: number }>;
  tmpFiles: string[];
  turnsInMemory: number;
  memoryAudioKeys: number;
  audioDirExists: boolean;
}

export interface DeleteReport {
  id: string;
  removed: { sessions: number; turns: number; feedbacks: number; audioFiles: string[]; tmpFiles: string[] };
  before: SessionInspection;
  after: SessionInspection;
  verified: boolean;
}

interface SessionRow {
  id: string;
  created_at: string;
  updated_at: string;
  status: string;
  state: string;
  synthetic: number;
  save_audio: number;
  rule_version: string;
  realtime_model: string | null;
  text_model: string | null;
  materials_json: string | null;
  plan_json: string | null;
  report_json: string | null;
  report_source: string | null;
  review_meta_json: string | null;
  completed_questions: number;
}

interface TurnRow {
  id: string;
  question_id: string;
  speaker: string;
  turn_type: string;
  seq: number;
  started_at: string;
  ended_at: string;
  raw_transcript: string;
  revised_text: string | null;
  audio_file: string | null;
}

function fromRow(row: SessionRow): StoredSession {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status as SessionStatus,
    state: row.state as SessionState,
    synthetic: Number(row.synthetic) === 1,
    saveHistory: true,
    saveAudio: Number(row.save_audio) === 1,
    persisted: true,
    ruleVersion: row.rule_version,
    realtimeModel: row.realtime_model,
    textModel: row.text_model,
    materials: row.materials_json === null ? null : (JSON.parse(row.materials_json) as CandidateMaterials),
    plan: row.plan_json === null ? null : (JSON.parse(row.plan_json) as QuestionPlan),
    report: row.report_json === null ? null : (JSON.parse(row.report_json) as SessionReport),
    reportSource: row.report_source as ReportSource | null,
    reviewMeta: row.review_meta_json === null ? [] : (JSON.parse(row.review_meta_json) as ReviewMeta[]),
    completedQuestions: Number(row.completed_questions),
  };
}

/** 轮次表没有版本列，按会话原始 JSON 版本恢复；无版本时只使用当时规则版本，绝不标成现行版。 */
function sessionContractVersion(session: StoredSession | null): string {
  const version = session?.materials?.contractVersion ?? session?.plan?.contractVersion ?? session?.report?.contractVersion;
  if (typeof version === 'string' && version.length > 0) return version;
  const ruleVersion = session?.ruleVersion.match(/(?:rules@)?(0\.[123]\.0)$/)?.[1];
  return ruleVersion ?? 'unknown';
}

function toTurn(row: TurnRow, contractVersion: string): Turn {
  return {
    contractVersion,
    id: row.id,
    questionId: row.question_id,
    speaker: row.speaker as Turn['speaker'],
    turnType: row.turn_type as Turn['turnType'],
    seq: Number(row.seq),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    rawTranscript: row.raw_transcript,
    revisedText: row.revised_text,
    audioFile: row.audio_file,
  };
}
