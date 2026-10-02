/**
 * 测试替身（离线用，不进产品代码）：
 * - `MockRealtimeClient`：实现 `RealtimeLike`，按脚本模拟连接失败（音色断言）、400 污染、音频分片、转写。
 * - `ScriptedTextClient`：实现 `TextLlmClient`，按提示词内容返回问题计划／追问判定／五维评审／报告／重答对比。
 *
 * 二者都只回答「调用方该看到什么」，不复制产品逻辑，避免测试自我印证。
 */
import type { CompletionRequest, CompletionResponse, TextLlmClient } from '../../src/clients/types.js';
import type { RealtimeEventRecord, ResponseResult, SessionInfo, UserTranscriptResult } from '../../src/clients/realtime-dashscope.js';
import type { RealtimeLike } from '../../src/web/realtime-bridge.js';
import type { Feedback, QuestionPlan } from '../../src/contracts/types.js';

export interface MockRealtimeScript {
  /** 前 N 次 open 抛错（模拟音色断言失败／连不上），之后成功。 */
  openFailures?: number;
  /** session.updated 回显的生效音色。 */
  effectiveVoice?: string;
  /** 前 N 次 injectText 之后以 400 报错（模拟撞 400 的连接被污染）。 */
  speak400?: number;
  /** 每次朗读产出多少个音频分片。 */
  audioChunks?: number;
  /** 每片之间的间隔（毫秒），用于让打断有机会插进来。 */
  chunkDelayMs?: number;
  /** commit 后的转写（按顺序取；用尽后返回空串）。 */
  transcripts?: string[];
  /** injectText 之后立刻报错（模拟朗读失败）。 */
  speakError?: string;
}

interface PendingResponse {
  resolve: (r: ResponseResult) => void;
  reject: (e: Error) => void;
}

export class MockRealtimeClient implements RealtimeLike {
  static instances: MockRealtimeClient[] = [];
  readonly events: RealtimeEventRecord[] = [];
  isVoiceAsserted = false;
  openCount = 0;
  injectCount = 0;
  commitCount = 0;
  cancelCount = 0;
  appendedBytes = 0;
  closed = false;

  private audioCbs: Array<(chunk: Buffer, seq: number) => void> = [];
  private transcriptCbs: Array<(partial: string, final: boolean) => void> = [];
  private pending: PendingResponse[] = [];
  private transcriptWaiters: Array<(r: UserTranscriptResult) => void> = [];
  private currentText = '';
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly script: MockRealtimeScript = {}) {
    MockRealtimeClient.instances.push(this);
  }

  async open(sessionId: string): Promise<SessionInfo> {
    this.openCount += 1;
    if ((this.script.openFailures ?? 0) > 0) {
      this.script.openFailures = (this.script.openFailures ?? 0) - 1;
      throw new Error(`音色前置断言失败：生效音色 Chelsie ≠ 期望 Maia（session=${sessionId}）`);
    }
    this.isVoiceAsserted = true;
    const voice = this.script.effectiveVoice ?? 'Maia';
    return {
      sessionId,
      model: 'mock-realtime',
      voice: 'Chelsie',
      inputAudioFormat: 'pcm16',
      outputAudioFormat: 'pcm24',
      inputAudioTranscriptionModel: 'mock-asr',
      turnDetection: null,
      handshakeMs: 3,
      updated: { voice },
    };
  }

  injectText(text: string): void {
    if (!this.isVoiceAsserted) throw new Error('拒绝注入文本：音色前置断言未通过');
    this.injectCount += 1;
    this.currentText = text;
    if (this.script.speakError !== undefined) {
      const err = new Error(this.script.speakError);
      for (const p of this.pending.splice(0)) p.reject(err);
      return;
    }
    if ((this.script.speak400 ?? 0) > 0) {
      this.script.speak400 = (this.script.speak400 ?? 0) - 1;
      const err = new Error("实时接口错误 COMMON_ERROR：<400> Voice 'Chelsie' is not supported");
      for (const p of this.pending.splice(0)) p.reject(err);
      return;
    }
    const chunks = this.script.audioChunks ?? 3;
    const delay = this.script.chunkDelayMs ?? 5;
    const emitted: Buffer[] = [];
    for (let i = 0; i < chunks; i++) {
      const timer = setTimeout(() => {
        const chunk = Buffer.alloc(480, i + 1);
        emitted.push(chunk);
        this.events.push({ t: i, dir: 'recv', type: 'response.audio.delta', bytes: chunk.length });
        for (const cb of this.audioCbs) cb(chunk, i);
        for (const cb of this.transcriptCbs) cb(text, false);
        if (i === chunks - 1) {
          const result: ResponseResult = {
            transcript: text,
            audio: Buffer.concat(emitted),
            firstAudioMs: delay,
            totalMs: delay * chunks,
            startedAt: Date.now() - delay * chunks,
            firstAudioAt: Date.now() - delay * (chunks - 1),
            endedAt: Date.now(),
            status: this.cancelCount > 0 ? 'cancelled' : 'completed',
          };
          for (const cb of this.transcriptCbs) cb(text, true);
          for (const p of this.pending.splice(0)) p.resolve(result);
        }
      }, delay * (i + 1));
      this.timers.push(timer);
    }
  }

  appendAudio(pcm: Buffer): void {
    this.appendedBytes += pcm.length;
  }

  commitAudio(): void {
    this.commitCount += 1;
    setTimeout(() => {
      const transcript = this.script.transcripts?.shift() ?? '';
      const result: UserTranscriptResult = { transcript, latencyMs: 12 };
      for (const w of this.transcriptWaiters.splice(0)) w(result);
    }, 5);
  }

  cancelResponse(): void {
    this.cancelCount += 1;
  }

  onTranscript(cb: (partial: string, final: boolean) => void): void {
    this.transcriptCbs.push(cb);
  }

  onInterviewerAudio(cb: (chunk: Buffer, seq: number) => void): void {
    this.audioCbs.push(cb);
  }

  waitForResponse(timeoutMs = 1000): Promise<ResponseResult> {
    void timeoutMs;
    return new Promise<ResponseResult>((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  waitForUserTranscript(timeoutMs = 1000): Promise<UserTranscriptResult> {
    void timeoutMs;
    return new Promise<UserTranscriptResult>((resolve) => this.transcriptWaiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers.splice(0)) clearTimeout(t);
    const err = new Error('连接已关闭');
    for (const p of this.pending.splice(0)) p.reject(err);
  }

  get lastInjectedText(): string {
    return this.currentText;
  }
}

export interface TextScript {
  /** 网页新传输：从提示词提供的目录选择来源编号。 */
  planSourceIds?: boolean;
  /** 追问判定脚本（按顺序消费；用尽后 need=false）。 */
  followups?: Array<{ need: boolean; question?: string; reason?: string; gap?: string }>;
  /** 每次评审前 N 次返回坏 JSON（验证重试与首次通过率口径）。 */
  badReviewAttempts?: number;
  /** 计划生成失败（抛错）。 */
  planError?: string;
  /** 计划前 N 次返回可解析但不符合契约的结构（验证自动整改重试）。 */
  badPlanAttempts?: number;
  /** 某一次计划返回不可定位来源（验证共享来源门与重试）。 */
  badPlanSourceAttempts?: number;
  /** 评审调用抛出异常（可在测试中动态切换）。 */
  reviewError?: string;
  /** 计划只有 2 题（验证契约门）。 */
  planQuestionCount?: number;
  /** 已完成的评审调用次数（按提示词统计）。 */
  counts?: Record<string, number>;
  /** 报告的 priorityPractice；给 null 表示模型输出不可用（应回退派生来源）。 */
  reportPriority?: string[] | null;
}

/** 从评审提示词里抽出评审对象轮次 id。 */
export function turnIdsFromReviewPrompt(prompt: string): string[] {
  const m = prompt.match(/【评审对象轮次】([^\n]*)/);
  return (m?.[1] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 从评审提示词里抽出评审对象文本。 */
export function basisFromReviewPrompt(prompt: string): string {
  const m = prompt.match(/【评审对象（[^】]*）】\n([\s\S]*?)\n【评审对象轮次】/);
  if (!m) throw new Error('评审提示词里没有找到评审对象段落');
  return m[1]!;
}

export class ScriptedTextClient implements TextLlmClient {
  readonly name = 'scripted';
  readonly model = 'scripted-text';
  readonly prompts: string[] = [];
  readonly counts: Record<string, number> = {};
  private followups: NonNullable<TextScript['followups']>;
  private badReviewAttempts: number;
  private badPlanAttempts: number;
  private badPlanSourceAttempts: number;

  constructor(private readonly script: TextScript = {}) {
    this.followups = [...(script.followups ?? [])];
    this.badReviewAttempts = script.badReviewAttempts ?? 0;
    this.badPlanAttempts = script.badPlanAttempts ?? 0;
    this.badPlanSourceAttempts = script.badPlanSourceAttempts ?? 0;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.prompts.push(req.prompt);
    const kind = this.classify(req.prompt);
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    if (kind === 'plan') {
      if (this.script.planError !== undefined) throw new Error(this.script.planError);
      const n = this.script.planQuestionCount ?? 4;
      const plan: QuestionPlan = {
        contractVersion: '0.3.0',
        questions: Array.from({ length: n }, (_, i) => ({
          id: `q${i + 1}`,
          kind: i === 0 ? 'introduction' : 'experience',
          text: [
            '请做一段与内容运营岗位相关的自我介绍。',
            '请说明你在征稿活动中个人负责的具体动作。',
            '你在渠道扩散时遇到过什么困难，做了什么取舍？',
            '你怎么判断活动的效果，复盘后改变了哪些流程？',
          ][i] ?? `第${i + 1}题：请补充新的经历背景。`,
          sourceExcerpt: '内容运营',
          intent: '验证个人贡献',
          topics: [`主题${i + 1}`],
        })),
        askedTopics: ['主题1'],
      };
      if (this.badPlanAttempts > 0) {
        this.badPlanAttempts -= 1;
        (plan.questions[0] as unknown as { topics: unknown[] }).topics = [{ label: '错误结构' }];
      }
      if (this.badPlanSourceAttempts > 0) {
        this.badPlanSourceAttempts -= 1;
        plan.questions[0]!.sourceExcerpt = '我从未在材料中提过的事实';
      }
      if (this.script.planSourceIds) {
        const catalog = req.prompt.match(/【原文来源目录[^\n]*\n([^\n]+)/)?.[1];
        if (!catalog) throw new Error('缺少来源目录');
        const sources = JSON.parse(catalog) as Array<{ id: string; text: string }>;
        return { text: JSON.stringify({ ...plan, questions: plan.questions.map(({ sourceExcerpt: _excerpt, ...q }, i) => ({ ...q, sourceId: sources[i % sources.length]!.id })) }), usage: { promptTokens: 100, completionTokens: 50 } };
      }
      return { text: JSON.stringify(plan), usage: { promptTokens: 100, completionTokens: 50 } };
    }
    if (kind === 'followup') {
      const next = this.followups.shift() ?? { need: false };
      return {
        text: JSON.stringify({ need: next.need, question: next.need ? (next.question ?? '你刚才提到的分工，具体是怎么安排的？') : null, reason: next.reason ?? '缺事实', gap: next.gap ?? '个人分工' }),
        usage: { promptTokens: 80, completionTokens: 20 },
      };
    }
    if (kind === 'review') {
      if (this.script.reviewError !== undefined) throw new Error(this.script.reviewError);
      if (this.badReviewAttempts > 0) {
        this.badReviewAttempts -= 1;
        return { text: '这不是 JSON', usage: { promptTokens: 10, completionTokens: 5 } };
      }
      const basis = basisFromReviewPrompt(req.prompt);
      const turnId = turnIdsFromReviewPrompt(req.prompt)[0] ?? 't1';
      const pick = (offset: number, len: number): string => {
        const start = Math.min(offset, Math.max(0, basis.length - len));
        return basis.slice(start, start + len) || basis.slice(0, Math.min(4, basis.length));
      };
      const fb: Feedback = {
        contractVersion: '0.3.0',
        questionId: 'q1',
        reviewBasis: { turnIds: ['t1'], textVersion: 'raw' },
        dimensions: {
          relevance: { level: '充分清楚', quote: { text: pick(0, 10), start: 0, end: 10, turnId, textVersion: 'raw', matchType: 'exact' }, reason: '直接回应当前问题' },
          specificity: { level: '部分清楚', quote: { text: pick(12, 10), start: 0, end: 10, turnId, textVersion: 'raw', matchType: 'exact' }, reason: '有动作但缺细节' },
          contribution: { level: '证据不足', quote: { text: pick(24, 8), start: 0, end: 8, turnId, textVersion: 'raw', matchType: 'exact' }, reason: '个人分工未说明' },
          resultsReflection: { level: '无法判断', quote: null, reason: '回答里没有结果信息' },
          structure: { level: '部分清楚', quote: { text: pick(4, 8), start: 0, end: 8, turnId, textVersion: 'raw', matchType: 'exact' }, reason: '有顺序但跳跃' },
        },
        factGaps: ['个人分工的具体动作', '活动结果数据'],
        topImprovement: '补充你个人负责的具体动作',
        nextFacts: ['你个人负责的具体动作', '活动结果数据'],
        reviewVersion: 'prompts@0.3.0',
      };
      return { text: JSON.stringify(fb), usage: { promptTokens: 900, completionTokens: 400 } };
    }
    if (kind === 'report') {
      if (this.script.reportPriority === null) return { text: '不是 JSON', usage: { promptTokens: 10, completionTokens: 5 } };
      const priority = this.script.reportPriority ?? ['补充你个人负责的具体动作'];
      return { text: JSON.stringify({ contractVersion: '0.3.0', priorityPractice: priority }), usage: { promptTokens: 300, completionTokens: 40 } };
    }
    if (kind === 'rewrite_delta') {
      return { text: JSON.stringify({ added: ['补充了个人分工'], corrected: [], stillMissing: ['仍缺结果数据'] }), usage: { promptTokens: 200, completionTokens: 30 } };
    }
    throw new Error(`ScriptedTextClient 不认识这类提示词：${req.prompt.slice(0, 40)}`);
  }

  private classify(prompt: string): string {
    if (prompt.includes('生成一场训练的问题计划')) return 'plan';
    if (prompt.includes('追问判定器')) return 'followup';
    if (prompt.includes('独立文本评审器')) return 'review';
    if (prompt.includes('报告生成器')) return 'report';
    if (prompt.includes('重答对比器')) return 'rewrite_delta';
    return 'unknown';
  }
}
