/**
 * 链 B（真实语音会话，T1-R）：提问 → 回答 → 转写 → 追问 → 打断。
 *
 * 用真实 DashScope Qwen-Omni-Realtime WebSocket；用户侧音频由 macOS `say` 合成后按 100ms 分片
 * 实时推流，**服务端 ASR 与模型全部真实**。边界：这不是真人对着麦克风说话（属 T3 页面链路），
 * 但它证明的是服务端链路的真实可用性、可注入性、可持久化与可打断性。
 *
 * 同时回答 PM 的两个技术前提：
 *   ① 服务端能否注入下一问题／追问文本（D2 可行性，A3 假设）
 *   ② 面试官音频能否在服务端持久化（A6 假设，决定回放范围）
 */
import path from 'node:path';
import { DashscopeRealtimeClient, REALTIME_DEFAULTS } from '../clients/realtime-dashscope.js';
import { chunkPcm, pcmDurationSeconds, sha256, synthesizeAnswerPcm, speechToolingAvailable, writeAudio } from './audio.js';
import type { EvidenceWriter } from './evidence.js';
import { DATA_DIR } from './evidence.js';

/** 可入库的音频记录：只有仓库根相对路径与摘要，绝不带本机绝对路径。 */
export interface AudioRecord {
  path: string;
  bytes: number;
  durationSeconds: number;
  sha256: string;
  peak: number;
}

function toAudioRecord(a: { path: string; bytes: number; durationSeconds: number; sha256: string; peak: number }): AudioRecord {
  return { path: a.path, bytes: a.bytes, durationSeconds: a.durationSeconds, sha256: a.sha256, peak: a.peak };
}

export interface ChainBTurn {
  index: number;
  kind: 'question' | 'answer' | 'followup' | 'interrupt';
  /** 应用层注入给语音层的文本（D2：语音层不得自造问题）。 */
  injectedText?: string;
  /** 模型实际朗读出来的文本（转写）。 */
  spokenTranscript?: string;
  /** 注入文本是否被逐字朗读（去掉标点空白后比较）。 */
  verbatim?: boolean;
  /** 用户音频（回答轮）。 */
  userAudio?: AudioRecord;
  /** 服务端 ASR 得到的用户转写。 */
  userTranscript?: string;
  asrLatencyMs?: number;
  /** 面试官音频（服务端可持久化的证据）。 */
  interviewerAudio?: AudioRecord;
  firstAudioMs?: number | null;
  totalMs?: number;
  status?: string;
  /** 打断轮的观察。 */
  interrupt?: {
    cancelSentAtMs: number;
    audioDeltasBeforeCancel: number;
    audioDeltasAfterCancel: number;
    bytesAfterCancel: number;
    finalStatus: string;
    stoppedWithinMs: number | null;
  };
  note?: string;
}

export interface ChainBResult {
  ok: boolean;
  failure?: string;
  degraded?: string;
  session: {
    sessionId: string;
    model: string;
    voice: string;
    inputAudioFormat: string;
    outputAudioFormat: string;
    inputAudioTranscriptionModel: string | null;
    turnDetection: unknown;
    handshakeMs: number;
    /** 生效配置回显（voice 以这里为准）。 */
    effective: Record<string, unknown> | null;
  } | null;
  turns: ChainBTurn[];
  /** 技术前提 ①：服务端注入文本。 */
  premiseInjectText: { supported: boolean; rounds: number; verbatimRounds: number; evidence: string[] };
  /** 技术前提 ②：面试官音频服务端持久化。 */
  premisePersistInterviewerAudio: { supported: boolean; turnsWithAudio: number; totalBytes: number; evidence: string[] };
  eventLog: Array<{ t: number; dir: string; type: string; bytes?: number; note?: string }>;
  audioTooling: { available: boolean; reason?: string };
}

export interface ChainBOptions {
  client: DashscopeRealtimeClient;
  evidence: EvidenceWriter;
  /** 会话内问题文本（应用层产出，D2）。 */
  questionText?: string;
  followupText?: string;
  answerText?: string;
  longTextForInterrupt?: string;
}

const normalize = (s: string): string => s.replace(/[\s，。？?！!、,.;；:：""''“”‘’（）()]/g, '');

export async function runChainB(opts: ChainBOptions): Promise<ChainBResult> {
  const { client, evidence } = opts;
  const questionText = opts.questionText ?? '请介绍你在毕业季征稿活动中承担的具体工作，以及最后的投稿结果。';
  const followupText = opts.followupText ?? '你刚才提到联系了院系宣传委员，具体是怎么分工的？';
  const answerText =
    opts.answerText ??
    '我在毕业季征稿活动里负责整体策划和落地。前期我先用问卷收集了两百份同学偏好，然后把主题定成毕业故事。之后我联系了五个院系的宣传委员帮我扩散，自己写了两篇范文做冷启动。活动两周收到一百四十三篇投稿，比上一期增长大概八成。';
  const longTextForInterrupt =
    opts.longTextForInterrupt ??
    '我先说明活动的整体背景，这次毕业季征稿是我们论坛全年最重要的一次内容活动，目标是同时拉高投稿量和注册转化。为了这件事我做了三件事，第一是前期调研，第二是渠道扩散，第三是规则设计，下面我分别展开说明每一件的具体做法和我个人的分工。';

  const tooling = speechToolingAvailable();
  evidence.truncateJsonl('chain-b/events.jsonl');
  const turns: ChainBTurn[] = [];
  const audioDir = path.join(DATA_DIR, 'chain-b-audio');

  let session: ChainBResult['session'] = null;
  let failure: string | undefined;

  try {
    const info = await client.open('chain-b');
    session = {
      sessionId: info.sessionId,
      model: info.model,
      voice: info.voice,
      inputAudioFormat: info.inputAudioFormat,
      outputAudioFormat: info.outputAudioFormat,
      inputAudioTranscriptionModel: info.inputAudioTranscriptionModel,
      turnDetection: info.turnDetection,
      handshakeMs: info.handshakeMs,
      effective: info.updated,
    };

    // ---- 轮 1：提问（服务端注入问题文本）----
    {
      const p = client.waitForResponse();
      client.injectText(questionText);
      const res = await p;
      const written = writeAudio(audioDir, 'turn1-interviewer-question', res.audio, REALTIME_DEFAULTS.outputSampleRate);
      turns.push({
        index: 1,
        kind: 'question',
        injectedText: questionText,
        spokenTranscript: res.transcript,
        verbatim: normalize(res.transcript) === normalize(questionText),
        interviewerAudio: toAudioRecord(written),
        firstAudioMs: res.firstAudioMs,
        totalMs: res.totalMs,
        status: res.status,
      });
    }

    // ---- 轮 2：回答（真实音频上行 → 服务端 ASR）----
    if (!tooling.available) {
      failure = `无法生成回答音频：${tooling.reason ?? '未知原因'}`;
    } else {
      const pcmPath = path.join(audioDir, 'turn2-user-answer.pcm');
      const pcm = synthesizeAnswerPcm(answerText, pcmPath);
      const transcriptPromise = client.waitForUserTranscript();
      const startedAt = Date.now();
      for (const chunk of chunkPcm(pcm)) {
        client.appendAudio(chunk);
        // 贴近真实推流节奏：100ms 音频 / 20ms 间隔（5 倍速推流，控制验收耗时）
        await sleep(20);
      }
      const streamedMs = Date.now() - startedAt;
      client.commitAudio();
      const asr = await transcriptPromise;
      const written = writeAudio(audioDir, 'turn2-user-answer', pcm, REALTIME_DEFAULTS.inputSampleRate);
      turns.push({
        index: 2,
        kind: 'answer',
        injectedText: answerText,
        userAudio: toAudioRecord(written),
        userTranscript: asr.transcript,
        asrLatencyMs: asr.latencyMs,
        note: `推流 ${Math.round(streamedMs)}ms，pcm ${pcm.length} 字节 / ${pcmDurationSeconds(pcm, REALTIME_DEFAULTS.inputSampleRate)}s`,
      });
    }

    // ---- 轮 3：追问（服务端注入追问文本，D2 第二次验证）----
    {
      const p = client.waitForResponse();
      client.injectText(followupText);
      const res = await p;
      const written = writeAudio(audioDir, 'turn3-interviewer-followup', res.audio, REALTIME_DEFAULTS.outputSampleRate);
      turns.push({
        index: 3,
        kind: 'followup',
        injectedText: followupText,
        spokenTranscript: res.transcript,
        verbatim: normalize(res.transcript) === normalize(followupText),
        interviewerAudio: toAudioRecord(written),
        firstAudioMs: res.firstAudioMs,
        totalMs: res.totalMs,
        status: res.status,
      });
    }

    // ---- 轮 4：打断（长文本朗读中途 response.cancel）----
    {
      let deltasBefore = 0;
      let deltasAfter = 0;
      let bytesAfter = 0;
      let cancelledAt = 0;
      let lastDeltaAt = 0;
      const onAudio = (chunk: Buffer): void => {
        if (cancelledAt === 0) deltasBefore++;
        else {
          deltasAfter++;
          bytesAfter += chunk.length;
          lastDeltaAt = Date.now();
        }
      };
      client.onInterviewerAudio(onAudio);
      const p = client.waitForResponse();
      client.injectText(longTextForInterrupt);
      // 等确实开始出音频再打断，避免「还没开始就取消」这种无效验证
      await waitUntil(() => deltasBefore >= 5, 20_000);
      cancelledAt = Date.now();
      client.cancelResponse();
      const res = await p;
      turns.push({
        index: 4,
        kind: 'interrupt',
        injectedText: longTextForInterrupt,
        spokenTranscript: res.transcript,
        interviewerAudio: toAudioRecord(writeAudio(audioDir, 'turn4-interviewer-interrupted', res.audio, REALTIME_DEFAULTS.outputSampleRate)),
        totalMs: res.totalMs,
        status: res.status,
        interrupt: {
          cancelSentAtMs: cancelledAt,
          audioDeltasBeforeCancel: deltasBefore,
          audioDeltasAfterCancel: deltasAfter,
          bytesAfterCancel: bytesAfter,
          finalStatus: res.status,
          stoppedWithinMs: deltasAfter === 0 ? 0 : lastDeltaAt - cancelledAt,
        },
      });
    }
  } catch (e) {
    failure = (e as Error).message;
  } finally {
    client.close();
  }

  const injectedTurns = turns.filter((t) => t.kind === 'question' || t.kind === 'followup');
  const verbatimRounds = injectedTurns.filter((t) => t.verbatim === true).length;
  const audioTurns = turns.filter((t) => t.interviewerAudio !== undefined && t.interviewerAudio.bytes > 0);

  return {
    ok: failure === undefined,
    ...(failure !== undefined ? { failure } : {}),
    session,
    turns,
    premiseInjectText: {
      supported: injectedTurns.length > 0 && verbatimRounds === injectedTurns.length,
      rounds: injectedTurns.length,
      verbatimRounds,
      evidence: injectedTurns.map((t) => `轮 ${t.index}（${t.kind}）：注入=${t.injectedText ?? ''}｜朗读=${t.spokenTranscript ?? ''}｜逐字=${String(t.verbatim)}`),
    },
    premisePersistInterviewerAudio: {
      supported: audioTurns.length > 0,
      turnsWithAudio: audioTurns.length,
      totalBytes: audioTurns.reduce((a, t) => a + (t.interviewerAudio?.bytes ?? 0), 0),
      evidence: audioTurns.map(
        (t) => `轮 ${t.index}：${t.interviewerAudio?.path ?? ''}｜${t.interviewerAudio?.durationSeconds ?? 0}s｜${t.interviewerAudio?.bytes ?? 0}B｜sha256=${(t.interviewerAudio?.sha256 ?? '').slice(0, 16)}…`,
      ),
    },
    eventLog: client.events,
    audioTooling: tooling,
  };
}

/** 校验入库短片段确实是「记录里那段」：重算 sha256 必须一致。 */
export function verifyAudioHash(filePath: string, expectedSha: string, readFile: (p: string) => Buffer): boolean {
  return sha256(readFile(filePath)) === expectedSha;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待条件超时（${timeoutMs}ms）`);
    await sleep(20);
  }
}
