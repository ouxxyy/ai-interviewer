/**
 * T1-R 延迟抽样（PM §4 目标：首响应 P95 ≤3s、评审 P95 ≤15s）。
 *
 * - 「答完 → 首段回应音频」：以应用层判定回答结束（`input_audio_buffer.commit`）为起点，
 *   到面试官回应首个 `response.audio.delta` 为止；同时拆出 ASR 子段（commit → 转写完成），
 *   因为 D2 要求文本层参与决策，这段耗时是产品延迟里真实存在的一块。
 * - 「提交评审 → 完整点评」：文本模型端到端返回**完整且通过 Schema** 的 Feedback。
 */
import path from 'node:path';
import { DashscopeRealtimeClient, REALTIME_DEFAULTS } from '../clients/realtime-dashscope.js';
import type { DashscopeTextClient } from '../clients/dashscope.js';
import { runReview } from '../review/reviewer.js';
import { validateContract } from '../contracts/validate.js';
import { reviewPrompt } from '../prompts/prompts.js';
import { chunkPcm, pcmDurationSeconds, synthesizeAnswerPcm, speechToolingAvailable } from './audio.js';
import { latencyStats, type EvidenceWriter } from './evidence.js';
import { DATA_DIR } from './evidence.js';
import { DashscopeReviewChannel, loadCases } from './chain-a.js';

export interface RealtimeLatencySample {
  round: number;
  answerChars: number;
  answerAudioSeconds: number;
  commitToFirstAudioMs: number | null;
  commitToAsrDoneMs: number;
  asrToFirstAudioMs: number | null;
  responseTotalMs: number;
  userTranscriptChars: number;
  spokenTranscriptChars: number;
  /** A3 验证：注入文本是否被逐字朗读（模型有没有自造问题）。 */
  injectedText: string;
  spokenTranscript: string;
  verbatim: boolean;
  ok: boolean;
  error?: string;
}

export interface ReviewLatencySample {
  round: number;
  caseId: string;
  latencyMs: number;
  totalTokens: number;
  completionTokens: number;
  schemaOk: boolean;
  quoteLocated: boolean;
  attempts: number;
  firstAttemptOk: boolean;
  attemptLog: Array<{ attempt: number; ok: boolean; cause?: string; detail?: string }>;
  ok: boolean;
}

export interface LatencyResult {
  realtime: { samples: RealtimeLatencySample[]; stats: ReturnType<typeof latencyStats>; asrStats: ReturnType<typeof latencyStats>; failures: number };
  review: { samples: ReviewLatencySample[]; stats: ReturnType<typeof latencyStats>; successfulOnlyStats: ReturnType<typeof latencyStats>; firstAttemptOk: number; failures: number };
  config: { realtimeModel: string; textModel: string; voice: string; region: string };
}

const ANSWERS = [
  '我负责的是校园论坛的毕业季征稿活动，主要做了前期调研、渠道扩散和规则设计三件事。',
  '前期我用问卷收集了两百份同学偏好，发现情感故事类呼声最高，于是把主题定成毕业故事。',
  '渠道上我联系了五个院系的宣传委员帮忙扩散，同时自己写了两篇范文做冷启动。',
  '活动两周收到一百四十三篇投稿，比上一期增长大概八成，这是这次活动最主要的结果。',
  '复盘时我发现初审通过率只有六成，原因是投稿规则没写清字数要求。',
  '后来我补了一份投稿指引，下一期初审通过率提到了八成五。',
  '我个人的不足是当时没有做获奖作品的二次传播，这些内容其实可以剪成合集再发一轮。',
  '在那段实习里我主要负责公众号排版和选题会记录，每周产出三篇排版稿。',
  '我参与过一次数据复盘，把阅读完成率从四成提升到五成五，主要靠调整开头结构。',
  '我也踩过坑，有一次选题会没有提前准备数据，导致讨论卡住，后来我固定提前一天发材料。',
];

export async function runRealtimeLatency(
  client: DashscopeRealtimeClient,
  opts: { rounds?: number; evidence: EvidenceWriter },
): Promise<LatencyResult['realtime']> {
  const rounds = opts.rounds ?? 20;
  opts.evidence.truncateJsonl('latency/realtime-turns.jsonl');
  const samples: RealtimeLatencySample[] = [];
  const tooling = speechToolingAvailable();
  if (!tooling.available) throw new Error(`无法生成回答音频：${tooling.reason ?? '未知原因'}`);
  const audioDir = path.join(DATA_DIR, 'latency-audio');
  let failures = 0;

  for (let i = 0; i < rounds; i++) {
    const answer = ANSWERS[i % ANSWERS.length]!;
    try {
      const pcmPath = path.join(audioDir, `round${String(i + 1).padStart(2, '0')}.pcm`);
      const pcm = synthesizeAnswerPcm(answer, pcmPath);
      const transcriptPromise = client.waitForUserTranscript(30_000);
      for (const chunk of chunkPcm(pcm)) {
        client.appendAudio(chunk);
        await sleep(12);
      }
      const commitAt = Date.now();
      client.commitAudio();
      const asr = await transcriptPromise;
      const asrDoneAt = Date.now();

      const responsePromise = client.waitForResponse(60_000);
      const injected = i % 2 === 0 ? '请继续说明你个人的具体分工。' : '请补充这次活动的结果数据。';
      client.injectText(injected);
      const res = await responsePromise;
      const norm = (x: string): string => x.replace(/[\s，。？?！!、,.;；:：""'']/g, '');

      samples.push({
        round: i + 1,
        answerChars: answer.length,
        answerAudioSeconds: pcmDurationSeconds(pcm, REALTIME_DEFAULTS.inputSampleRate),
        // 「答完」＝应用层提交回答（commit）；终点＝面试官首个音频分片到达（绝对时间戳相减）
        commitToFirstAudioMs: res.firstAudioAt === null ? null : res.firstAudioAt - commitAt,
        commitToAsrDoneMs: asrDoneAt - commitAt,
        asrToFirstAudioMs: res.firstAudioAt === null || res.firstAudioAt < asrDoneAt ? null : res.firstAudioAt - asrDoneAt,
        responseTotalMs: res.totalMs,
        userTranscriptChars: asr.transcript.length,
        spokenTranscriptChars: res.transcript.length,
        injectedText: injected,
        spokenTranscript: res.transcript,
        verbatim: norm(res.transcript) === norm(injected),
        ok: true,
      });
      opts.evidence.appendJsonl('latency/realtime-turns.jsonl', [
        {
          round: i + 1,
          answerText: answer,
          userTranscript: asr.transcript,
          interviewerTranscript: res.transcript,
          audioBytes: res.audio.length,
          firstAudioMsInResponse: res.firstAudioMs,
          responseTotalMs: res.totalMs,
        },
      ]);
    } catch (e) {
      failures++;
      samples.push({
        round: i + 1, answerChars: answer.length, answerAudioSeconds: 0,
        commitToFirstAudioMs: null, commitToAsrDoneMs: 0, asrToFirstAudioMs: null, responseTotalMs: 0,
        userTranscriptChars: 0, spokenTranscriptChars: 0, injectedText: '', spokenTranscript: '', verbatim: false, ok: false, error: (e as Error).message,
      });
    }
  }

  const okFirst = samples.filter((s) => s.ok && s.commitToFirstAudioMs !== null).map((s) => s.commitToFirstAudioMs!);
  return {
    samples,
    stats: latencyStats(okFirst),
    asrStats: latencyStats(samples.filter((s) => s.ok).map((s) => s.commitToAsrDoneMs)),
    failures,
  };
}

export async function runReviewLatency(
  client: DashscopeTextClient,
  opts: { rounds?: number; evidence: EvidenceWriter; enableThinking?: boolean },
): Promise<LatencyResult['review']> {
  const rounds = opts.rounds ?? 20;
  const cases = loadCases();
  const samples: ReviewLatencySample[] = [];
  let failures = 0;

  for (let i = 0; i < rounds; i++) {
    const c = cases[i % cases.length]!;
    const prompt = reviewPrompt({ questionText: c.questionText, answerText: c.firstAnswer, turnIds: ['t1'], textVersion: 'raw', isRewrite: false });
    const channel = new DashscopeReviewChannel(client, prompt, { jsonMode: true, enableThinking: opts.enableThinking ?? false });
    const startedAt = Date.now();
    const attemptLog: Array<{ attempt: number; ok: boolean; cause?: string; detail?: string }> = [];
    try {
      const outcome = await runReview({
        channel, basisText: c.firstAnswer, turnIds: ['t1'], textVersion: 'raw', questionId: 'q1', maxRetries: 2,
        onAttempt: (attempt, r) => attemptLog.push({ attempt, ok: r.ok, ...(r.cause === undefined ? {} : { cause: r.cause }), ...(r.detail === undefined ? {} : { detail: r.detail }) }),
      });
      const latencyMs = Date.now() - startedAt;
      const schemaOk = validateContract('feedback', outcome.feedback).ok;
      const quoteLocated = outcome.kind === 'ok';
      if (!schemaOk) failures++;
      samples.push({
        round: i + 1,
        caseId: c.id,
        latencyMs,
        totalTokens: channel.calls.reduce((a, x) => a + x.totalTokens, 0),
        completionTokens: channel.calls.reduce((a, x) => a + x.completionTokens, 0),
        schemaOk,
        quoteLocated,
        attempts: outcome.attempts,
        firstAttemptOk: attemptLog[0]?.ok === true,
        attemptLog,
        ok: schemaOk && quoteLocated,
      });
    } catch (e) {
      failures++;
      samples.push({ round: i + 1, caseId: c.id, latencyMs: Date.now() - startedAt, totalTokens: 0, completionTokens: 0, schemaOk: false, quoteLocated: false, attempts: 0, firstAttemptOk: false, attemptLog, ok: false });
      opts.evidence.appendJsonl('latency/review-errors.jsonl', [{ round: i + 1, caseId: c.id, error: (e as Error).message.slice(0, 200) }]);
    }
  }

  // 口径说明：延迟统计取**全部**样本（含重试与降级），因为用户等的是这一次提交的完整结果；
  // 只统计成功样本会把重试成本藏起来，人为压低 P95。
  return {
    samples,
    stats: latencyStats(samples.map((s) => s.latencyMs)),
    successfulOnlyStats: latencyStats(samples.filter((s) => s.ok).map((s) => s.latencyMs)),
    firstAttemptOk: samples.filter((s) => s.firstAttemptOk).length,
    failures,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
