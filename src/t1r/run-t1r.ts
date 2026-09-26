/**
 * T1-R 验收运行器：一次执行「模型核定 → 链 A → 链 B → 延迟抽样 → 证据清单」。
 *
 * 用法：
 *   node dist/src/t1r/run-t1r.js all             # 全部（默认）
 *   node dist/src/t1r/run-t1r.js models          # 只核定模型/地域/配额
 *   node dist/src/t1r/run-t1r.js chain-a
 *   node dist/src/t1r/run-t1r.js chain-b
 *   node dist/src/t1r/run-t1r.js latency
 *
 * 凭证只从项目根 `.env` 显式读取，不依赖 shell；任何落盘内容先过密钥防线。
 */
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DashscopeTextClient, DASHSCOPE_DEFAULTS } from '../clients/dashscope.js';
import { DashscopeRealtimeClient } from '../clients/realtime-dashscope.js';
import { credentialStatus, loadDotEnv, REPO_ROOT, requireCredential } from './env.js';
import { sha256 } from './audio.js';
import { EvidenceWriter, DATA_DIR, EVIDENCE_DIR } from './evidence.js';
import { runChainA, type ChainAResult } from './chain-a.js';
import { runChainB, type ChainBResult } from './chain-b.js';
import { runRealtimeLatency, runReviewLatency, type LatencyResult } from './latency.js';

interface ModelCatalog {
  httpStatus: number;
  latencyMs: number;
  total: number;
  realtimeIds: string[];
  verifiedTextModel: { id: string; httpStatus: number; latencyMs: number; totalTokens: number; replyChars: number };
  rateLimitHeaders: Record<string, string>;
}

async function probeModelCatalog(client: DashscopeTextClient, credential: string): Promise<ModelCatalog> {
  const base = DASHSCOPE_DEFAULTS.baseUrl;
  const started = Date.now();
  const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${credential}` } });
  const latencyMs = Date.now() - started;
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  const ids = (body.data ?? []).map((m) => m.id);

  // 真实文本调用 1 次：既核模型可用，也采一次限流响应头。
  const probe = await client.complete({ prompt: '只回复两个字：通过', maxTokens: 32, temperature: 0, enableThinking: false });
  const probeRes = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
    body: JSON.stringify({ model: DASHSCOPE_DEFAULTS.model, messages: [{ role: 'user', content: '只回复两个字：通过' }], max_tokens: 16, enable_thinking: false }),
  });
  const rateLimitHeaders: Record<string, string> = {};
  probeRes.headers.forEach((v, k) => {
    if (/rate|limit|quota|request-id|x-log/i.test(k)) rateLimitHeaders[k] = v;
  });

  return {
    httpStatus: res.status,
    latencyMs,
    total: ids.length,
    realtimeIds: ids.filter((i) => /realtime/i.test(i)).sort(),
    verifiedTextModel: {
      id: DASHSCOPE_DEFAULTS.model,
      httpStatus: probe.httpStatus ?? 0,
      latencyMs: probe.latencyMs ?? 0,
      totalTokens: probe.usage?.totalTokens ?? 0,
      replyChars: probe.text.length,
    },
    rateLimitHeaders,
  };
}

/** 把 1–2 个短音频片段复制进仓库（其余大文件留在 gitignore 的 data/）。 */
function commitShortClips(writer: EvidenceWriter, clips: Array<{ src: string; name: string; note: string }>): Array<{ name: string; bytes: number; sha256: string; durationSeconds: number; note: string }> {
  const dir = path.join(EVIDENCE_DIR, 'audio');
  mkdirSync(dir, { recursive: true });
  const out: Array<{ name: string; bytes: number; sha256: string; durationSeconds: number; note: string }> = [];
  for (const clip of clips) {
    const dest = path.join(dir, clip.name);
    copyFileSync(clip.src, dest);
    const buf = readFileSync(dest);
    const rel = path.relative(REPO_ROOT, dest);
    writer.artifacts.push({ path: rel, kind: 'wav', bytes: buf.length, sha256: sha256(buf), committed: true, note: clip.note });
    out.push({ name: rel, bytes: buf.length, sha256: sha256(buf), durationSeconds: Number(((buf.length - 44) / 2 / 24_000).toFixed(3)), note: clip.note });
  }
  return out;
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'all';
  const envReport = loadDotEnv();
  const credential = requireCredential();
  const writer = new EvidenceWriter();
  const text = new DashscopeTextClient();

  writer.note('env', {
    dotenvPath: envReport.path,
    filePresent: envReport.filePresent,
    injectedKeys: envReport.injectedKeys,
    emptyKeys: envReport.emptyKeys,
    credential: credentialStatus(),
  });

  const summary: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    command: cmd,
    runtime: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      host: process.env.HOSTNAME ?? 'local',
      region: 'cn-beijing（dashscope.aliyuncs.com，中国大陆地域）',
      egress: '本机直连（NO_PROXY 含 dashscope.aliyuncs.com；Node fetch/ws 不经系统代理）',
      network: '家庭／办公宽带（未做带宽测量，见验收记录「未核定项」）',
    },
    credential: credentialStatus(),
  };

  if (cmd === 'all' || cmd === 'models') {
    const catalog = await probeModelCatalog(text, credential);
    writer.writeJson('models/catalog.json', catalog);
    summary.models = catalog;
  }

  if (cmd === 'all' || cmd === 'chain-a') {
    const result: ChainAResult = await runChainA(text, { evidence: writer });
    writer.writeJson('chain-a/summary.json', result);
    summary.chainA = {
      planQuestions: result.plan.questions.length,
      planSchemaOk: result.planSchemaOk,
      planCall: result.planCall,
      planExcerptLocatable: result.planExcerptLocatable,
      reviews: result.reviews.map((r) => ({
        caseId: r.caseId, outcomeKind: r.outcomeKind, attempts: r.attempts, schemaOk: r.schemaOk,
        quotesTotal: r.quotesTotal, quotesLocated: r.quotesLocated, quoteFailures: r.quoteFailures,
        levels: r.levels, calls: r.calls,
      })),
      promptVersion: result.promptVersion,
    };
  }

  if (cmd === 'all' || cmd === 'chain-b') {
    const rt = new DashscopeRealtimeClient(credential, {});
    const result: ChainBResult = await runChainB({ client: rt, evidence: writer });
    writer.writeJson('chain-b/summary.json', result);
    writer.appendJsonl('chain-b/events.jsonl', result.eventLog);
    const clips = commitShortClips(writer, [
      ...(result.turns.find((t) => t.kind === 'question')?.interviewerAudio
        ? [{ src: result.turns.find((t) => t.kind === 'question')!.interviewerAudio!.path, name: 'clip-interviewer-question.wav', note: '面试官提问（服务端产出并落盘，取自链 B 轮 1）' }]
        : []),
      ...(result.turns.find((t) => t.kind === 'followup')?.interviewerAudio
        ? [{ src: result.turns.find((t) => t.kind === 'followup')!.interviewerAudio!.path, name: 'clip-interviewer-followup.wav', note: '面试官追问（服务端注入文本后朗读，取自链 B 轮 3）' }]
        : []),
    ]);
    summary.chainB = { ok: result.ok, failure: result.failure, session: result.session, turns: result.turns, premiseInjectText: result.premiseInjectText, premisePersistInterviewerAudio: result.premisePersistInterviewerAudio, committedClips: clips };
  }

  if (cmd === 'all' || cmd === 'latency') {
    const rt = new DashscopeRealtimeClient(credential, {});
    const rtInfo = await rt.open('latency');
    let realtime: LatencyResult['realtime'];
    try {
      realtime = await runRealtimeLatency(rt, { evidence: writer, rounds: 20 });
    } finally {
      rt.close();
    }
    const review = await runReviewLatency(text, { evidence: writer, rounds: 20, enableThinking: false });
    writer.writeJson('latency/summary.json', {
      realtime: { stats: realtime.stats, asrStats: realtime.asrStats, failures: realtime.failures, samples: realtime.samples },
      review: { stats: review.stats, failures: review.failures, samples: review.samples },
      config: { realtimeModel: rtInfo.model, voice: rtInfo.voice, textModel: DASHSCOPE_DEFAULTS.model, rounds: 20 },
    });
    summary.latency = {
      realtime: { stats: realtime.stats, asrStats: realtime.asrStats, failures: realtime.failures, samples: realtime.samples },
      review: { stats: review.stats, failures: review.failures, samples: review.samples },
    };
  }

  // 成本估算（D7）：先给真实用量，单价能核实才给金额，核不到就如实标注。
  const usage = collectUsage(summary);
  summary.cost = {
    usage,
    note: 'token 数为百炼响应中的真实 usage；语音按音频秒数计量。单价以百炼官方定价页为准——若验收记录中标注「未核定」，表示本轮未能核实官方单价，只报用量不报金额。',
  };

  writer.writeJson('run-summary.json', summary);
  writer.writeJson('manifest.json', {
    generatedAt: new Date().toISOString(),
    artifacts: writer.artifacts,
    notes: writer.notes,
  });

  // 控制台只打印结论摘要（不含任何凭证）
  console.log(JSON.stringify({ ok: true, command: cmd, dataDir: path.relative(REPO_ROOT, DATA_DIR), summaryKeys: Object.keys(summary) }, null, 2));
}

function collectUsage(summary: Record<string, unknown>): Record<string, unknown> {
  const chainA = summary.chainA as { reviews?: Array<{ calls: Array<{ totalTokens: number; promptTokens: number; completionTokens: number }> }>; planCall?: { totalTokens: number; promptTokens: number; completionTokens: number } } | undefined;
  const latency = summary.latency as { realtime?: { samples: Array<{ ok: boolean; answerAudioSeconds: number }> }; review?: { samples: Array<{ totalTokens: number; completionTokens: number }> } } | undefined;
  const planTokens = chainA?.planCall?.totalTokens ?? 0;
  const reviewTokens = (chainA?.reviews ?? []).reduce((a, r) => a + r.calls.reduce((b, c) => b + c.totalTokens, 0), 0);
  const latencyReviewTokens = (latency?.review?.samples ?? []).reduce((a, s) => a + s.totalTokens, 0);
  const speechSeconds = (latency?.realtime?.samples ?? []).filter((s) => s.ok).reduce((a, s) => a + s.answerAudioSeconds, 0);
  return { planTokens, reviewTokens, latencyReviewTokens, totalTextTokens: planTokens + reviewTokens + latencyReviewTokens, userSpeechSeconds: Number(speechSeconds.toFixed(1)) };
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`T1-R 运行失败：${msg}`);
  process.exit(1);
});
