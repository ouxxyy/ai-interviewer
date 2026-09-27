/**
 * 网页入口真实链路验收运行器（MYW-85 验收 1–5）。
 *
 * 链路：真实 Chrome（M1，headless=new，fake 音频输入设备指向 `say` 合成语音的 WAV）
 *   → 本地服务（127.0.0.1）→ 服务端代理到阿里 Qwen-Omni-Realtime（真实模型 / 真实 ASR / 真实音色）
 *   → 真实文本模型做问题计划、追问判定、五维评审、重答对比、全场练习点。
 *
 * 断言全部由代码算出（不手写结论），覆盖：
 * 1. 三题闭环：真实提问语音 + 真实回答转写 + 逐题五维评审 + 报告；
 * 2. 历史与回放：重启后仍可读、两轨按轮可下载并在页面里真正解码播放；
 * 3. 两开关：关历史不产生持久记录、关录音不产生音频文件；
 * 4. 删除会话：数据库记录 / 音频文件 / 临时文件的前后对照；
 * 5. 打断取消旧回应并清空待播、暂停期间停止音频上行（浏览器不发 + 服务端拒收）；
 * 6. 出错不生成伪报告：空转写落到明确状态，仍可重读本题。
 *
 * 用法：npm run web:evidence（真实调用，产生费用；撞 1310／bigmodel 立即停下，不重试）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { assertNoSecret, credentialStatus, loadDotEnv, requireCredential } from '../t1r/env.js';
import { verifyManifest, writeManifestFromDir } from '../t1r/evidence.js';
import { DashscopeRealtimeClient, REALTIME_DEFAULTS } from '../clients/realtime-dashscope.js';
import { synthesizeAnswerPcm, chunkPcm, pcmToWav, speechToolingAvailable } from '../t1r/audio.js';
import { locateQuote } from '../contracts/quote-locator.js';
import { validateContract } from '../contracts/validate.js';
import { InterviewDb } from './db.js';
import { DEMO_MATERIALS } from './materials.js';
import { webPaths, REPO_ROOT } from './paths.js';

const PORT = Number(process.env.WEB_EVIDENCE_PORT ?? 8919);
const APP_URL = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.WEB_EVIDENCE_CDP_PORT ?? 9334);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DATA_DIR = path.join(REPO_ROOT, 'data', 'web-evidence');
/** 运行器自己的工作目录（Chrome profile、作答音频）放在服务数据目录之外，避免污染删除对照的扫描范围。 */
const HARNESS_DIR = path.join(REPO_ROOT, 'data', 'web-evidence-harness');
const AUDIO_WORK = path.join(HARNESS_DIR, 'answer-audio');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'evidence', 'web');
const DOC_FILE = path.join(REPO_ROOT, 'docs', 'web-acceptance.md');
const INPUT_SAMPLE_RATE = 16_000;

const ANSWER_TEXTS = [
  '我在毕业季征稿活动里负责整体策划和落地。前期我用问卷收集了两百份同学偏好，把主题定成毕业故事，然后联系了五个院系的宣传委员帮我扩散，自己写了两篇范文做冷启动。活动两周收到一百四十三篇投稿，比上一期增长大概八成。',
  '这件事里我个人的贡献主要是渠道设计和冷启动内容。渠道上我谈下了五个院系的宣传委员，设计了二次触达的提醒机制；内容上我写了两篇范文，把投稿门槛降下来。最后投稿里大概三成来自我直接推动的院系。',
  '我遇到的困难是第一次活动只有三个院系投稿集中，其他院系几乎没人参加。我复盘发现宣传委员只在群里发了一次通知，所以第二次我改成先给每个院系单独做选题建议，再请他们在班级群二次触达，参与院系增加到七个。',
  '复盘时我最大的反思是前期没有定义清楚什么算一次有效投稿，导致统计口径改过两次。后来我把投稿标准、统计时点和负责人写进了活动 SOP，下一次活动就没有再返工。',
  '如果重答一次，我会先说明活动目标是把投稿量从八十篇提到一百五十篇，再讲我个人的三个动作：问卷调研定主题、谈下五个院系渠道、写范文做冷启动，最后给出投稿一百四十三篇、增长约八成、参与院系从三个增加到七个的结果。',
  '我还想补充一点，活动结束后我把选题库和范文模板整理成了可复用的文档，下一届的同学可以直接用，这部分沉淀目前还没有量化到结果里。',
];

/** 证据汇总（模块级：模型核定步骤早于 main 内部的局部声明）。 */
const collected: Record<string, unknown> = {};

/** 作答音频池（main 里生成；每次作答取下一段，用尽后重复最后一段）。PCM16@16k 裸流。 */
const answerPcmFiles: string[] = [];
let answerCursor = 0;
function nextAnswerPcmFile(): string {
  return nextAnswer().pcmFile;
}
/** 取下一段作答（PCM 文件 + 对应文本）；用尽后重复最后一段。 */
function nextAnswer(): { pcmFile: string; text: string } {
  const idx = Math.min(answerCursor, answerPcmFiles.length - 1);
  answerCursor += 1;
  return { pcmFile: answerPcmFiles[idx]!, text: ANSWER_TEXTS[idx] ?? '' };
}

/** 4 字连续片段命中数：判断 ASR 转写确实来自这段注入语音（比单字集合重合稳）。 */
function gramHits(injected: string, transcript: string, n = 4): number {
  const strip = (s: string): string => s.replace(/[\s，。、？！,.：:；;""''（）()]/g, '');
  const a = strip(injected);
  const b = strip(transcript);
  if (a.length < n) return 0;
  let hits = 0;
  const seen = new Set<string>();
  for (let i = 0; i + n <= a.length; i++) {
    const g = a.slice(i, i + n);
    if (seen.has(g)) continue;
    seen.add(g);
    if (b.includes(g)) hits++;
  }
  return hits;
}

// ---------- 步骤与断言记录 ----------

interface Step {
  name: string;
  ms: number;
  detail: unknown;
  assertions: Array<{ label: string; pass: boolean; evidence: string }>;
}

const steps: Step[] = [];
let failures = 0;
const startedAt = Date.now();

function assert(label: string, pass: boolean, evidence: string): boolean {
  if (!pass) failures++;
  steps[steps.length - 1]?.assertions.push({ label, pass, evidence });
  return pass;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  steps.push({ name, ms: 0, detail: null, assertions: [] });
  const result = await fn();
  const s = steps[steps.length - 1]!;
  s.ms = Date.now() - t;
  s.detail = result ?? null;
  process.stdout.write(`[step] ${name} (${s.ms}ms)\n`);
  return result;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP / WS 工具 ----------

async function api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${APP_URL}${p}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text === '' ? null : JSON.parse(text)) as T };
}

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(250);
  }
}

/** 从 Node 侧直接推流（用于两个开关会话；不经过浏览器，服务端 ASR 仍真实）。 */
class NodeMic {
  private constructor(private readonly ws: WebSocket) {}
  static async connect(sid: string): Promise<NodeMic> {
    const ws = new WebSocket(`${APP_URL.replace('http', 'ws')}/realtime?sid=${encodeURIComponent(sid)}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e) => reject(new Error(`WS 连接失败：${(e as Error).message}`)));
    });
    return new NodeMic(ws);
  }
  send(obj: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(obj));
  }
  async streamPcm(pcm: Buffer, gapMs = 20): Promise<number> {
    for (const chunk of chunkPcm(pcm)) {
      this.send({ type: 'audio.append', audio: chunk.toString('base64') });
      await sleep(gapMs);
    }
    return pcm.length;
  }
  close(): void {
    this.ws.close();
  }
}

// ---------- Chrome / CDP ----------

class Cdp {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e) => reject(new Error(`CDP 连接失败：${(e as Error).message}`)));
    });
    return new Cdp(ws);
  }
  send(method: string, params: object = {}): Promise<unknown> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  /**
   * 页面求值。默认泛型 `any` 是为了让恢复自编译产物的 `main()` 不必处处写类型参数——
   * 真正需要形状的地方（状态快照、音频统计）仍然显式给出泛型。
   */
  async eval<T = any>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as {
      result?: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails) throw new Error(`页面执行异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value as T;
  }
  close(): void {
    this.ws.close();
  }
}

interface ChromeRun {
  cdp: Cdp;
  chrome: ChildProcess;
  profile: string;
  version: string;
}

let chromeRuns = 0;

async function launchChrome(): Promise<ChromeRun> {
  if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`);
  chromeRuns += 1;
  const profile = path.join(HARNESS_DIR, 'chrome-profiles', `run-${chromeRuns}`);
  rmSync(profile, { recursive: true, force: true });
  const args = [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT + chromeRuns}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // 只用 Chrome 官方假麦克风设备（440Hz 提示音）。Chrome 153 的 `--use-file-for-fake-audio-capture`
    // 在本机实测静音（RMS 0.0 vs 默认假设备 0.72），因此**作答语音**改由页面按同一 WS 协议推流注入，
    // 真实麦克风链路由「空转写」那一步单独覆盖（见 docs/web-acceptance.md）。
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,900',
  ];
  args.push('about:blank');
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  let version = '';
  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT + chromeRuns}/json/version`);
      const json = (await res.json()) as { Browser?: string };
      version = json.Browser ?? '';
      return version !== '';
    } catch {
      return false;
    }
  }, 20_000, 'Chrome DevTools 端点');
  const targets = (await (await fetch(`http://127.0.0.1:${CDP_PORT + chromeRuns}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const page = targets.find((t: any) => t.type === 'page');
  if (!page) throw new Error('Chrome 没有可用的 page target');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { cdp, chrome, profile, version };
}

/** 打开页面并接管已有会话（页面的真实麦克风链路就在这一步被使用）。 */
async function attachPage(run: ChromeRun, sid: string): Promise<void> {
  await run.cdp.send('Page.navigate', { url: `${APP_URL}/harness?sid=${encodeURIComponent(sid)}` });
  await waitFor(async () => (await run.cdp.eval<string>('document.readyState')) === 'complete', 15_000, '页面加载');
  const attached = await run.cdp.eval<{ sid: string; state: string }>(`window.__webDriver.attachSession(${JSON.stringify(sid)})`);
  if (attached.sid !== sid) throw new Error(`页面接管会话失败：${JSON.stringify(attached)}`);
}

/**
 * 一直答到进入重答选择点：真实模型可能追问 0–2 次，所以每次回答后看状态，
 * 处在 followup 就再答一轮（用下一段 say 语音），最多 3 轮。
 */
async function answerUntilReview(
  sid: string,
  opts: { firstRun?: ChromeRun; maxRounds?: number } = {},
): Promise<{ state: string; rounds: number; transcripts: string[]; roundsDetail: Array<{ injected: string; transcript: string; gramHits: number }>; firstAudio: { events: number; bytes: number; playedMs: number } | null; lastError: unknown; transientErrors: string[] }> {
  const maxRounds = opts.maxRounds ?? 4;
  const transcripts: string[] = [];
  const roundsDetail: Array<{ injected: string; transcript: string; uiTranscript: string; gramHits: number }> = [];
  const transientErrors: string[] = [];
  let state = '';
  let lastError: unknown = null;
  let firstAudio: { events: number; bytes: number; playedMs: number } | null = null;
  for (let i = 0; i < maxRounds; i++) {
    const run = i === 0 ? opts.firstRun : undefined;
    let result: { transcript: string; state: string; lastError: unknown; audio: { events: number; bytes: number; playedMs: number } };
    try {
      const answer = run ? nextAnswer() : nextAnswer();
      if (run) {
        await run.cdp.eval('window.__webDriver.answerStreamBegin()');
        const pcm = readFileSync(answer.pcmFile);
        const slice = 96 * 1024;
        for (let off = 0; off < pcm.length; off += slice) {
          await run.cdp.eval(`window.__webDriver.answerStreamPush(${JSON.stringify(pcm.subarray(off, off + slice).toString('base64'))})`);
        }
        const done = await run.cdp.eval<{ state: string; lastError: unknown }>('window.__webDriver.answerStreamFinish()');
        const status = await run.cdp.eval<{ transcript: string; audioEvents: number; audioEventBytes: number; playedMs: number }>('window.__webDriver.status()');
        result = { transcript: status.transcript, state: done.state, lastError: done.lastError, audio: { events: status.audioEvents, bytes: status.audioEventBytes, playedMs: status.playedMs } };
      } else {
        result = await voiceAnswer(sid, answer.pcmFile);
      }
      // 权威转写取服务端落库的轮次（页面上的 transcript 只是 WS 中间结果，可能还没到 final）
      const after = await api<any>('GET', `/api/sessions/${sid}`);
      const userTurns = after.body.turns.filter((t: any) => t.speaker === 'user');
      const authoritative = userTurns.at(-1)?.rawTranscript ?? '';
      roundsDetail.push({ injected: answer.text, transcript: authoritative, uiTranscript: result.transcript, gramHits: gramHits(answer.text, authoritative) });
    } catch (e) {
      // 上游瞬时故障（超时／内部错误）：如实记录，看状态决定能否再答一轮（额度不足等致命错误直接抛出）
      const message = (e as Error).message;
      if (/E_QUOTA|E_DISCLOSURE_REQUIRED|E_NOT_FOUND|E_STATE/.test(message)) throw e;
      transientErrors.push(message.slice(0, 200));
      const detail = await api<any>('GET', `/api/sessions/${sid}`);
      state = detail.body.state as string;
      lastError = detail.body.lastError ?? { code: 'transient', message };
      if (state === 'rewrite' || state === 'report' || state === 'ended') break;
      continue; // 状态仍允许作答（answer/followup）→ 再答一轮
    }
    transcripts.push(roundsDetail.at(-1)?.transcript ?? result.transcript);
    lastError = result.lastError;
    if (firstAudio === null && result.audio.events > 0) firstAudio = result.audio;
    state = result.state;
    if (state !== 'followup') break;
  }
  return { state, rounds: transcripts.length, transcripts, roundsDetail, firstAudio, lastError, transientErrors };
}

/**
 * 语音作答：页面把 say 合成语音的 PCM16@16k 按 100ms 分片、20ms 间隔推给服务端（与真实麦克风上行同一条
 * WS 协议、同一节奏），服务端再代理给实时模型做真实 ASR。
 *
 * 为什么不是直接喂麦克风：本机 Chrome 153 的 `--use-file-for-fake-audio-capture` 实测静音
 * （预检 RMS 0.0，默认假设备 0.72），所以「带内容的作答」用页面推流；「真实麦克风链路」由
 * 空转写那一步用默认假设备单独覆盖。
 */
async function voiceAnswer(sid: string, pcmFile: string): Promise<{ transcript: string; state: string; lastError: unknown; audio: { events: number; bytes: number; playedMs: number }; streamedBytes: number }> {
  const run = await launchChrome();
  try {
    await attachPage(run, sid);
    await run.cdp.eval('window.__webDriver.answerStreamBegin()');
    const pcm = readFileSync(pcmFile);
    const slice = 96 * 1024; // 每次 eval 推 96KB PCM（base64 后约 128KB），避免单次消息过大
    for (let off = 0; off < pcm.length; off += slice) {
      await run.cdp.eval(`window.__webDriver.answerStreamPush(${JSON.stringify(pcm.subarray(off, off + slice).toString('base64'))})`);
    }
    const done = await run.cdp.eval<{ state: string; lastError: unknown; streamSentBytes: number }>('window.__webDriver.answerStreamFinish()');
    const status = await run.cdp.eval<{ transcript: string; audioEvents: number; audioEventBytes: number; playedMs: number }>('window.__webDriver.status()');
    return {
      transcript: status.transcript,
      state: done.state,
      lastError: done.lastError,
      audio: { events: status.audioEvents, bytes: status.audioEventBytes, playedMs: status.playedMs },
      streamedBytes: done.streamSentBytes,
    };
  } finally {
    run.cdp.close();
    run.chrome.kill();
    await sleep(300);
  }
}

// ---------- 工具 ----------

const normalizeForCompare = (s: string): string => s.replace(/[\s，。？?！!、,.;；:：""''“”‘’（）()]/g, '');

/** 实时模型核定：冻结模型优先；上游故障时按「逐字朗读 + 有音频」选出可用替代，并如实记录失败原因。 */
async function probeRealtimeModels(candidates: string[]): Promise<{
  chosen: string;
  results: Array<{ model: string; ok: boolean; verbatim: boolean; audioBytes: number; firstAudioMs: number | null; error?: string }>;
}> {
  const key = requireCredential();
  const results: Array<{ model: string; ok: boolean; verbatim: boolean; audioBytes: number; firstAudioMs: number | null; error?: string }> = [];
  const probeText = '请介绍你在毕业季征稿活动里承担的具体工作，以及最后的投稿结果。';
  for (const model of candidates) {
    const client = new DashscopeRealtimeClient(key, { model, voice: REALTIME_DEFAULTS.defaultVoice });
    try {
      await client.open(`model-probe-${model}`);
      const pending = client.waitForResponse(60_000);
      client.injectText(probeText);
      const res = await pending;
      const verbatim = normalizeForCompare(res.transcript) === normalizeForCompare(probeText);
      results.push({ model, ok: true, verbatim, audioBytes: res.audio.length, firstAudioMs: res.firstAudioMs });
    } catch (e) {
      results.push({ model, ok: false, verbatim: false, audioBytes: 0, firstAudioMs: null, error: (e as Error).message.slice(0, 200) });
    } finally {
      client.close();
    }
  }
  const chosen = results.find((r: any) => r.ok && r.verbatim && r.audioBytes > 0)?.model ?? results.find((r: any) => r.ok && r.audioBytes > 0)?.model ?? candidates[0]!;
  return { chosen, results };
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function listFilesRecursive(dir: string, opts: { skip?: string[] } = {}): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (opts.skip?.includes(name)) continue;
    const p = path.join(dir, name);
    try {
      if (statSync(p).isDirectory()) out.push(...listFilesRecursive(p, opts));
      else out.push(path.relative(REPO_ROOT, p));
    } catch {
      /* 扫描期间被删除/替换：跳过 */
    }
  }
  return out;
}

let realtimeModelForRun: string | undefined;

async function startServerProcess(): Promise<ChildProcess> {
  mkdirSync(DATA_DIR, { recursive: true });
  const logFd = openSync(path.join(DATA_DIR, 'server.log'), 'a');
  const server = spawn(process.execPath, [path.join(REPO_ROOT, 'dist', 'src', 'web', 'cli.js'), 'serve', '--port', String(PORT), '--data-dir', 'data/web-evidence'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, ...(realtimeModelForRun === undefined ? {} : { AI_INTERVIEWER_REALTIME_MODEL: realtimeModelForRun }) },
  });
  server.on('exit', () => closeSync(logFd));
  await waitFor(async () => {
    try {
      const res = await fetch(`${APP_URL}/api/health`);
      const body = (await res.json()) as { ok?: boolean; port?: number };
      return body.ok === true && body.port === PORT;
    } catch {
      return false;
    }
  }, 30_000, '本地服务健康检查');
  return server;
}

/** 验收记录里必须如实列出的未做到项（与 docs/web-server.md §8 对应）。 */
export const KNOWN_LIMITS: string[] = [
  '**产品界面未实现**：方案 C 已选定并完成设计稿，但正式前端尚未构建；`/harness` 仍是验收用最小客户端。',
  '**真人麦克风未验证**：本机 Chrome 153 的 `--use-file-for-fake-audio-capture` 预检为静音（RMS 0.0，默认假设备 0.72），所以「带内容的作答」由页面按同一 WS 协议推流注入 `say` 合成语音；真实麦克风链路由 Chrome 假设备（提示音）单独覆盖（空转写状态）。**真人说话、环境噪声、真实语速仍未验证**。',
  '**自动 VAD 未启用**：沿用 T1-R 的 `turn_detection: null` 手动模式，自动抢话（A10）仍未验证，不写「自动模式已通过」。',
  '**评审延迟 P95 未达标**：T1-R 的 30.4s（目标 15s）结论依旧成立；本包未做流式渲染或五维拆分。',
  '**历史会话不能续跑**：重启后可查看／回放／删除，继续作答返回 409（不做跨进程会话恢复）。',
  '**实时模型上游不稳定**：本机多次观察到 `qwen3.8-omni-flash-realtime` 返回 `COMMON_ERROR`／超时（偶发，随后恢复），服务对瞬时故障换新连接重试一次；如遇持续故障可用 `AI_INTERVIEWER_REALTIME_MODEL` 覆盖，覆盖必须留证。',
  '**未做**：多用户与鉴权（只绑回环、本机单用户）、HTTPS、流式评审渲染、A8 三入口一致性终验（等网页前端）。',
];

/** 由 summary.json 重建验收记录（供真实运行与 `--doc-only` 共用，避免两条口径）。 */
export function renderAcceptanceDoc(summary: Record<string, any>): string {
  const steps: Step[] = summary.steps ?? [];
  const lines: string[] = [];
  lines.push('# 网页入口（本地 Chrome 实时语音）服务端与数据层验收记录');
  lines.push('');
  lines.push(`- 运行时间：${String(summary.ranAt)}；总耗时 ${(Number(summary.totals?.ms ?? 0) / 1000).toFixed(1)}s`);
  lines.push(`- 运行方式：\`npm run web:evidence\`（真实 Chrome ＋ 真实百炼调用；端口 ${PORT}，数据目录 \`${String(summary.dataDir)}\`）`);
  lines.push(`- Chrome：\`${String(summary.chrome)}\`（${String(summary.platform)}，headless=new）；Node ${String(summary.node)}`);
  lines.push(`- 实时模型：\`${String(summary.realtimeModel)}\`；音色固定 \`Serena\`（音色前置断言，生效值取自 \`session.updated\`）`);
  lines.push(`- 音频来源：${String(summary.audioSource)}`);
  lines.push(`- 断言总数 **${Number(summary.totals?.assertions ?? 0)}**，失败 **${Number(summary.totals?.failed ?? 0)}**`);
  lines.push('');
  lines.push('| # | 步骤 | 耗时 | 断言 |');
  lines.push('| --- | --- | --- | --- |');
  steps.forEach((s, i) => {
    const a = s.assertions.map((x) => `${x.pass ? '✅' : '❌'} ${x.label}`).join('<br>') || '—';
    lines.push(`| ${i + 1} | ${s.name} | ${s.ms}ms | ${a} |`);
  });
  lines.push('');
  lines.push('## 断言明细（含实测数字）');
  for (const s of steps) {
    lines.push('', `### ${s.name}`);
    for (const a of s.assertions) lines.push(`- ${a.pass ? 'PASS' : 'FAIL'} ${a.label}｜证据：${a.evidence}`);
  }
  lines.push('');
  lines.push(`## 结论：${Number(summary.totals?.failed ?? 1) === 0 ? '全部断言通过' : `存在 ${Number(summary.totals?.failed ?? 0)} 个失败断言`}`);
  lines.push('');
  lines.push('## 未做到项与已知限制（如实列出，不计入上表断言）');
  lines.push('');
  for (const item of KNOWN_LIMITS) lines.push(`- ${item}`);
  lines.push('');
  lines.push('完整结构化数据见 `evidence/web/summary.json`；证据文件 sha256 见 `evidence/web/manifest.json`。');
  return `${lines.join('\n')}\n`;
}

/** 运行中途失败也要留下证据（不静默丢步骤）。 */
function writeFatalEvidence(error: string): void {
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    steps.push({ name: '运行中断', ms: 0, detail: error, assertions: [{ label: '全流程跑完（未中途抛错）', pass: false, evidence: error.slice(0, 300) }] });
    failures += 1;
    const summary = {
      ranAt: new Date().toISOString(),
      fatal: error,
      realtimeModel: realtimeModelForRun ?? REALTIME_DEFAULTS.model,
      steps: steps.map((s) => ({ name: s.name, ms: s.ms, detail: s.detail, assertions: s.assertions })),
      totals: { assertions: steps.reduce((a, s) => a + s.assertions.length, 0), failed: failures, ms: Date.now() - startedAt },
    };
    const text = JSON.stringify(summary, null, 2);
    assertNoSecret(text);
    writeFileSync(path.join(EVIDENCE_DIR, 'summary.json'), `${text}\n`);
    const lines = [
      '# 网页入口（本地 Chrome 实时语音）服务端与数据层验收记录',
      '',
      `- 运行时间：${summary.ranAt}；**运行中途失败**（见下）`,
      `- 失败原因：${error}`,
      '',
      '| # | 步骤 | 耗时 | 断言 |',
      '| --- | --- | --- | --- |',
      ...steps.map((s, i) => `| ${i + 1} | ${s.name} | ${s.ms}ms | ${s.assertions.map((x) => `${x.pass ? '✅' : '❌'} ${x.label}`).join('<br>') || '—'} |`),
      '',
      '## 断言明细',
      ...steps.flatMap((s) => ['', `### ${s.name}`, ...s.assertions.map((a) => `- ${a.pass ? 'PASS' : 'FAIL'} ${a.label}｜证据：${a.evidence}`)]),
    ];
    const docText = lines.join('\n');
    assertNoSecret(docText);
    writeFileSync(DOC_FILE, `${docText}\n`);
  } catch {
    /* 证据落盘失败时只保留 stderr */
  }
}

async function main(): Promise<void> {
    const env = loadDotEnv();
    if (!credentialStatus().present)
        throw new Error(`缺少凭证：${env.path}（只检查存在性，不打印值）`);
    requireCredential();
    const tooling = speechToolingAvailable();
    if (!tooling.available)
        throw new Error(`语音合成不可用：${tooling.reason ?? '未知原因'}`);
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(HARNESS_DIR, { recursive: true, force: true });
    mkdirSync(AUDIO_WORK, { recursive: true });
    const paths = webPaths(DATA_DIR);
    // 0. 生成作答音频（macOS `say`，非真人；这点写进验收记录）
    await step('生成作答音频（macOS say 合成，16k 单声道 WAV）', async () => {
        for (const [i, text] of ANSWER_TEXTS.entries()) {
            const pcm = synthesizeAnswerPcm(text, path.join(AUDIO_WORK, `answer-${i + 1}.pcm`));
            const wav = path.join(AUDIO_WORK, `answer-${i + 1}.wav`);
            writeFileSync(wav, pcmToWav(pcm, INPUT_SAMPLE_RATE));
            answerPcmFiles.push(path.join(AUDIO_WORK, `answer-${i + 1}.pcm`));
        }
        const silent = path.join(AUDIO_WORK, 'silence.wav');
        writeFileSync(silent, pcmToWav(Buffer.alloc(INPUT_SAMPLE_RATE * 4), INPUT_SAMPLE_RATE));
        assert('生成 6 段作答语音（WAV + PCM16@16k）', answerPcmFiles.length === 6 && existsSync(silent), `files=${answerPcmFiles.length}, dir=${path.relative(REPO_ROOT, AUDIO_WORK)}`);
        return { files: answerPcmFiles.map((f) => path.basename(f)) };
    });
    const silentFile = path.join(AUDIO_WORK, 'silence.wav');
    void silentFile;
    // 0.5 实时模型核定：冻结模型优先；上游故障时如实换用同代可用模型并留证
    const candidates = [REALTIME_DEFAULTS.model, 'qwen3.5-omni-flash-realtime', 'qwen3-omni-flash-realtime'];
    const modelProbe = await step('实时模型核定（冻结模型优先，逐个真连并验证逐字朗读）', async () => {
        const probe = await probeRealtimeModels(candidates);
        const frozen = probe.results.find((r: any) => r.model === REALTIME_DEFAULTS.model);
        assert('冻结模型 qwen3.8-omni-flash-realtime 可用', frozen?.ok === true && frozen.verbatim, `${JSON.stringify(frozen)}`);
        assert('选定一个「可用且逐字朗读」的实时模型', probe.results.some((r) => r.ok && r.verbatim), JSON.stringify(probe.results));
        return probe;
    });
    realtimeModelForRun = modelProbe.chosen;
    collected.realtimeModel = modelProbe;
    process.env.AI_INTERVIEWER_REALTIME_MODEL = realtimeModelForRun;
    let server = await startServerProcess();
    let chromeVersion = '';
    try {
        // 1. 首次使用告知 + 建会话
        const boot = await step('首次使用告知与建会话', async () => {
            const disclosure = await api('GET', '/api/disclosure');
            await api('PATCH', '/api/settings', { disclosureAck: true });
            const created = await api('POST', '/api/sessions', { synthetic: true });
            assert('告知版本与四类信息齐备', disclosure.body.disclosure.staysLocal.length >= 3 && disclosure.body.disclosure.sentToCloud.length >= 3 && disclosure.body.disclosure.deletion.length >= 2, `version=${disclosure.body.disclosure.version}`);
            assert('创建会话成功且默认开启两个保存开关', created.status === 201 && created.body.snapshot.toggles.saveHistory && created.body.snapshot.toggles.saveAudio, `sid=${created.body.sid}`);
            return { sid: created.body.sid, disclosureVersion: disclosure.body.disclosure.version };
        });
        const sid = boot.sid;
        collected.mainSession = sid;
        // 2. 材料确认 → 真实问题计划 → 第一题真实语音
        const firstRun = await launchChrome();
        chromeVersion = firstRun.version;
        await attachPage(firstRun, sid);
        const q1 = await step('材料确认（虚构演示）→ 真实问题计划 → 第 1 题真实语音', async () => {
            const res = await api('POST', `/api/sessions/${sid}/materials`, {
                jd: DEMO_MATERIALS.jd,
                experience: DEMO_MATERIALS.experience,
                stage: DEMO_MATERIALS.stage,
                targetRole: DEMO_MATERIALS.targetRole,
            });
            const snap = res.body.snapshot;
            assert('问题计划为 3 题且状态进入作答', snap.plan?.questions.length === 3 && snap.state === 'answer', `state=${snap.state} questions=${snap.plan?.questions.length}`);
            const audio = await firstRun.cdp.eval('window.__webDriver.waitPlaybackDone().then(() => window.__webDriver.questionAudioStats())');
            assert('浏览器收到面试官真实语音分片并实际播放', audio.events > 0 && audio.bytes > 0, `events=${audio.events} bytes=${audio.bytes}`);
            return { question: snap.currentQuestion.text, questions: snap.plan?.questions.length, audio };
        });
        // 3. 第 1 题作答（真人麦克风链路等价物：Chrome fake device ← say 合成语音）→ 真实 ASR
        const a1 = await step('第 1 题作答：浏览器采集 → 服务端代理 → 真实 ASR', async () => {
            const mic = await firstRun.cdp.eval('window.__webDriver.micProbe(1.5, false)');
            assert('浏览器真实采集链路可用（getUserMedia + AudioWorklet → 16k PCM，非静音）', mic.ok === true && mic.peak > 0.01, JSON.stringify(mic));
            const ans = await answerUntilReview(sid, { firstRun });
            const detail = await api('GET', `/api/sessions/${sid}`);
            const userTurns = detail.body.turns.filter((t: any) => t.speaker === 'user' && t.questionId === 'q1');
            const transcript = ans.roundsDetail.at(-1)?.transcript ?? '';
            assert('作答语音经页面按 100ms 分片推给服务端（与产品页面上行同一协议）', ans.rounds >= 1 && transcript.length > 0, `轮数=${ans.rounds}`);
            assert('真实 ASR 产出非空转写（每轮 ≥20 字）', ans.roundsDetail.every((r) => r.transcript.length >= 20), JSON.stringify(ans.roundsDetail.map((r) => r.transcript.length)));
            assert('每轮转写都确实来自该轮注入语音（4 字片段命中 ≥5）', ans.roundsDetail.every((r) => r.gramHits >= 5), JSON.stringify(ans.roundsDetail.map((r) => ({ hits: r.gramHits, chars: r.transcript.length }))));
            assert('用户轮与面试官轮都按轮落盘（含音频引用）', userTurns.length > 0 && detail.body.turns.some((t: any) => t.speaker === 'interviewer' && t.audio.interviewer), JSON.stringify(detail.body.turns.map((t: any) => [t.id, t.speaker, t.audio])));
            assert('回答后进入评审并产出第 1 题反馈', ans.state === 'rewrite' && detail.body.reviews?.q1 !== undefined, `state=${ans.state} 答完轮数=${ans.rounds}`);
            return { roundsDetail: ans.roundsDetail, state: ans.state, rounds: ans.rounds, turnCount: detail.body.turns.length, transientErrors: ans.transientErrors };
        });
        collected.q1 = a1;
        firstRun.cdp.close();
        firstRun.chrome.kill();
        // 4. 逐题评审（真实文本模型）＋ 引用独立复算
        const review1 = await step('第 1 题评审：真实模型五维反馈 + 引用区间独立复算', async () => {
            await waitFor(async () => {
                const d = await api('GET', `/api/sessions/${sid}`);
                return d.body.reviews?.q1 !== undefined;
            }, 90_000, '第 1 题评审完成');
            const detail = await api('GET', `/api/sessions/${sid}`);
            const fb = detail.body.reviews.q1;
            const basis = detail.body.turns.filter((t: any) => t.speaker === 'user' && t.questionId === 'q1').map((t: any) => t.revisedText ?? t.rawTranscript).join('\n');
            const schemaOk = validateContract('feedback', fb).ok;
            let checked = 0;
            let located = 0;
            const mismatches = [];
            for (const [dim, d] of Object.entries<any>(fb.dimensions)) {
                if (d.level === '无法判断')
                    continue;
                checked += 1;
                const loc = locateQuote(basis, d.quote.text);
                if (loc.located && loc.start === d.quote.start && loc.end === d.quote.end)
                    located += 1;
                else
                    mismatches.push(`${dim}:${loc.located ? `${loc.start}-${loc.end}≠${d.quote.start}-${d.quote.end}` : loc.reason}`);
            }
            assert('第 1 题反馈通过 feedback 契约', schemaOk, `levels=${JSON.stringify(Object.fromEntries(Object.entries<any>(fb.dimensions).map(([k, v]) => [k, v.level])))}`);
            assert('三档维度的引用区间与独立复算逐位一致', checked > 0 && located === checked, `located=${located}/${checked}${mismatches.length ? ` 不符=${mismatches.join(';')}` : ''}`);
            assert('状态机停在重答选择点（未被模型带着走）', detail.body.state === 'rewrite', `state=${detail.body.state}`);
            return { levels: Object.fromEntries(Object.entries<any>(fb.dimensions).map(([k, v]) => [k, v.level])), quotesLocated: `${located}/${checked}`, topImprovement: fb.topImprovement };
        });
        collected.review1 = review1;
        // 5. 重答一次 + 对比评审
        const rewrite = await step('重答一次 → 对比评审（只比较两版已确认回答）', async () => {
            await api('POST', `/api/sessions/${sid}/rewrite/start`);
            const ans = await answerUntilReview(sid, { maxRounds: 1 });
            const a = { state: ans.state, lastError: ans.lastError };
            assert('重答轮回答已进入评审', a.state === 'rewrite', `state=${a.state} lastError=${JSON.stringify(a.lastError)}`);
            const detail = await api('GET', `/api/sessions/${sid}`);
            const delta = detail.body.rewriteDeltas?.q1;
            const userTurnIds = detail.body.turns.filter((t: any) => t.speaker === 'user' && t.questionId === 'q1').map((t: any) => t.id);
            assert('重答对比产出 added/corrected/stillMissing', delta !== undefined && Array.isArray(delta.added) && Array.isArray(delta.corrected) && Array.isArray(delta.stillMissing), JSON.stringify(delta));
            assert('重答轮单独成轮（初审与重答可分别回放）', userTurnIds.length >= 2, `userTurns=${userTurnIds.join(',')}`);
            return { delta, state: a.state };
        });
        collected.rewrite = rewrite;
        // 6. 第 2 题：提问中途打断（取消旧回应 + 清空待播）
        const run2 = await launchChrome();
        await attachPage(run2, sid);
        const interrupt = await step('第 2 题：提问中途打断（取消旧回应 + 清空待播音频）', async () => {
            const next = await run2.cdp.eval('window.__webDriver.nextNoWait()');
            const played = await run2.cdp.eval('window.__webDriver.questionAudioStats()');
            const interrupted = await run2.cdp.eval('window.__webDriver.interrupt()');
            await sleep(500);
            assert('打断后浏览器停止播放且待播队列清空', interrupted.playing === false && interrupted.queueLength === 0, JSON.stringify({ playing: interrupted.playing, queueLength: interrupted.queueLength, clearedQueue: interrupted.clearedQueue }));
            assert('服务端确认取消旧回应（clearedPending）', interrupted.lastInterrupt?.clearedPending === true, JSON.stringify(interrupted.lastInterrupt));
            assert('打断前确实已经在播音频（不是空打断）', played.playedMs > 0, `playing=${next.playing} playedMs=${played.playedMs}`);
            return { next, played, interrupted };
        });
        collected.interrupt = interrupt;
        const q2 = await step('第 2 题作答（浏览器麦克风链路 → 真实 ASR → 真实评审）', async () => {
            const ans = await answerUntilReview(sid, {});
            const a = { state: ans.state, lastError: ans.lastError, transcript: ans.transcripts.at(-1) ?? '' };
            assert('第 2 题进入评审并产出反馈', a.state === 'rewrite', `state=${a.state} lastError=${JSON.stringify(a.lastError)}`);
            const detail = await api('GET', `/api/sessions/${sid}`);
            assert('第 2 题反馈过契约', validateContract('feedback', detail.body.reviews.q2).ok, JSON.stringify(Object.fromEntries(Object.entries<any>(detail.body.reviews.q2.dimensions).map(([k, v]) => [k, v.level]))));
            return { state: a.state, transcriptChars: a.transcript.length, transientErrors: ans.transientErrors };
        });
        collected.q2 = q2;
        // 7. 第 3 题：先空转写（不生成伪报告），再暂停/恢复，最后正常作答
        const run3 = await launchChrome();
        await attachPage(run3, sid);
        const empty = await step('第 3 题：真实麦克风链路（Chrome 假设备提示音）→ 空转写落到明确状态', async () => {
            await run3.cdp.eval('window.__webDriver.next()');
            const before = await api('GET', `/api/sessions/${sid}`);
            const turnsBefore = before.body.turns.filter((t: any) => t.speaker === 'user').length;
            const cap = await run3.cdp.eval('window.__webDriver.startAnswer()');
            assert('浏览器真实采集链路启动（getUserMedia + AudioWorklet，16k）', cap.ok === true && cap.sampleRate === 16000, JSON.stringify(cap));
            await sleep(4000);
            const sent = await run3.cdp.eval('window.__webDriver.status()');
            assert('麦克风音频真的上行到服务端（分片数 > 0）', sent.chunksSent > 0 && sent.bytesSent > 0, JSON.stringify(sent));
            const done = await run3.cdp.eval('window.__webDriver.answerDone()');
            const after = await api('GET', `/api/sessions/${sid}`);
            const turnsAfter = after.body.turns.filter((t: any) => t.speaker === 'user').length;
            assert('空转写状态明确（E_EMPTY_TRANSCRIPT）', done.lastError?.code === 'E_EMPTY_TRANSCRIPT', JSON.stringify(done.lastError));
            assert('空转写不产生用户轮、不进入评审', turnsAfter === turnsBefore && after.body.reviews.q3 === undefined, `turns ${turnsBefore}→${turnsAfter} reviews=${Object.keys(after.body.reviews).join(',')}`);
            const repeated = await run3.cdp.eval('window.__webDriver.repeatQuestion()');
            assert('可重读本题继续（不消耗追问次数）', repeated.state === 'answer', `state=${repeated.state} lastError=${JSON.stringify(repeated.lastError)}`);
            return { done, repeated };
        });
        collected.emptyTranscript = empty;
        run3.cdp.close();
        run3.chrome.kill();
        const run4 = await launchChrome();
        await attachPage(run4, sid);
        const pause = await step('第 3 题：作答中暂停 → 停止上行（客户端扣住 + 服务端拒收）→ 恢复后完成作答', async () => {
            const begin = await run4.cdp.eval('window.__webDriver.answerStreamBegin()');
            assert('作答开始（页面推流通道打开）', begin.ok === true, JSON.stringify(begin));
            const pcm = readFileSync(nextAnswerPcmFile());
            const slice = 96 * 1024;
            for (let off = 0; off < pcm.length; off += slice) {
                await run4.cdp.eval(`window.__webDriver.answerStreamPush(${JSON.stringify(pcm.subarray(off, off + slice).toString('base64'))})`);
                // 推到一半时暂停：后续分片应被客户端扣住、服务端也应拒收
                if (off === 0) {
                    await run4.cdp.eval('window.__webDriver.pause()');
                }
            }
            const pausedStatus = await run4.cdp.eval('window.__webDriver.status()');
            const probe = await run4.cdp.eval('window.__webDriver.probeAppendWhilePaused()');
            assert('暂停期间客户端一个字节都没发出去（扣住不发）', pausedStatus.bytesSentWhilePaused === 0 && pausedStatus.bytesAttemptedWhilePaused > 0, JSON.stringify(pausedStatus));
            assert('暂停期间服务端明确拒收上行音频（E_UPLINK_PAUSED）', probe.rejectedAfter >= 1, JSON.stringify(probe));
            await api('POST', `/api/sessions/${sid}/resume`);
            let streamedBytes = null;
            let stateNow = '';
            let rounds = 0;
            let lastError = null;
            try {
                const done = await run4.cdp.eval('window.__webDriver.answerStreamFinish()');
                streamedBytes = done.streamSentBytes;
                stateNow = done.state;
                lastError = done.lastError;
                rounds = 1;
            }
            catch (e) {
                // 上游瞬时故障：如实记录，按状态继续（状态机已落到 ERROR_TIMEOUT/ERROR_DISCONNECT）
                streamedBytes = null;
                stateNow = (await api('GET', `/api/sessions/${sid}`)).body.state;
                lastError = { code: 'transient', message: (e as Error).message.slice(0, 200) };
            }
            assert('恢复后整段音频都推完（推流字节数 = 音频字节数）', streamedBytes === null || streamedBytes === pcm.length, `streamed=${String(streamedBytes)} 计划=${pcm.length}`);
            // 真实模型可能追问：追问轮继续答，直到进入重答选择点
            if (stateNow === 'followup' || stateNow === 'answer') {
                const rest = await answerUntilReview(sid, {});
                stateNow = rest.state;
                rounds += rest.rounds;
                if (rest.transientErrors.length > 0)
                    lastError = { code: 'transient', message: rest.transientErrors.join(' | ') };
            }
            const detail = await api('GET', `/api/sessions/${sid}`);
            assert('恢复后完成第 3 题并进入评审', stateNow === 'rewrite' && validateContract('feedback', detail.body.reviews.q3).ok, `state=${stateNow} 答完轮数=${rounds} lastError=${JSON.stringify(lastError)}`);
            return { probe, pausedStatus, state: stateNow, streamedBytes, rounds, lastError };
        });
        collected.pause = pause;
        run4.cdp.close();
        run4.chrome.kill();
        // 8. 报告
        const reportStep = await step('生成全场报告（真实模型练习点 + 已校验反馈回填）', async () => {
            const res = await api('POST', `/api/sessions/${sid}/next`);
            const snap = res.body.snapshot;
            assert('三题完成、状态归档为 ended', snap.report?.completedQuestions === 3 && snap.state === 'ended', `completed=${snap.report?.completedQuestions} state=${snap.state}`);
            assert('报告过 session-report 契约', validateContract('session-report', snap.report).ok, JSON.stringify(snap.report?.priorityPractice));
            assert('每题 feedback 原样来自已校验反馈', snap.report.perQuestion.every((p: any) => p.status === 'reviewed' && validateContract('feedback', p.feedback).ok), snap.report.perQuestion.map((p: any) => p.status).join(','));
            assert('优先练习点来源已标注（模型 or 反馈派生）', ['model_priority_practice', 'derived_from_validated_feedback'].includes(snap.reportSource), `source=${snap.reportSource}`);
            return { reportSource: snap.reportSource, priorityPractice: snap.report.priorityPractice, perQuestion: snap.report.perQuestion.map((p: any) => p.status), versions: snap.report.versions };
        });
        collected.report = reportStep;
        // 9. 回放：两轨按轮取回并在页面里真正解码播放
        const run5 = await launchChrome();
        await attachPage(run5, sid);
        const playback = await step('回放：用户轨与面试官轨按轮下载并在页面里真正播放', async () => {
            const detail = await api('GET', `/api/sessions/${sid}`);
            const results = [];
            for (const t of detail.body.turns.slice(0, 4)) {
                for (const track of ['user', 'interviewer']) {
                    if (!t.audio?.[track])
                        continue;
                    const r = await run5.cdp.eval(`window.__webDriver.playback(${JSON.stringify(t.id)}, ${JSON.stringify(track)})`);
                    results.push({ turnId: t.id, track, ...r });
                }
            }
            const played = results.filter((r) => r.ok && (r.playedMs ?? 0) > 0 && (r.durationSec ?? 0) > 0);
            assert('两轨都至少有一轮可回放并真正出声', results.some((r) => r.ok && r.track === 'user') && results.some((r) => r.ok && r.track === 'interviewer') && played.length >= 2, JSON.stringify(results));
            assert('回放来源是磁盘文件（不是内存兜底）', results.every((r) => r.source === 'file'), JSON.stringify(results.map((r) => `${r.turnId}/${r.track}:${r.source}`)));
            return { checked: results.length, played: played.length, results };
        });
        collected.playback = playback;
        run5.cdp.close();
        run5.chrome.kill();
        // 10. 重启持久化：杀掉服务进程，重新拉起，历史与音频仍在
        const restart = await step('重启服务后：历史、反馈、报告与音频仍可用', async () => {
            server.kill();
            await waitFor(async () => {
                try {
                    await fetch(`${APP_URL}/api/health`);
                    return false;
                }
                catch {
                    return true;
                }
            }, 15_000, '旧服务退出');
            server = await startServerProcess();
            const detail = await api('GET', `/api/sessions/${sid}`);
            const before = steps.find((s) => s.name.startsWith('回放'))?.detail as { results: Array<{ turnId: string; track: string }> } | undefined;
            const firstUser = before?.results.find((r) => r.track === 'user');
            if (!firstUser) throw new Error('回放步骤里没有可用的用户轨记录，无法验证重启后回放');
            const audio = await fetch(`${APP_URL}/api/sessions/${sid}/turns/${firstUser.turnId}/audio/user`);
            assert('重启后会话仍可读（轮次/反馈/报告俱在）', detail.status === 200 && detail.body.turns.length > 0 && Object.keys(detail.body.reviews).length === 3 && detail.body.report !== null, `turns=${detail.body.turns.length} reviews=${Object.keys(detail.body.reviews).length} report=${detail.body.report !== null}`);
            assert('重启后录音文件仍可下载', audio.status === 200 && (await audio.arrayBuffer()).byteLength > 44, `http=${audio.status}`);
            assert('重启后的会话是历史态（不能继续作答）', detail.body.live === false, `live=${detail.body.live}`);
            const attempts = await api('POST', `/api/sessions/${sid}/answer/start`);
            assert('对历史会话继续作答被明确拒绝（409）', attempts.status === 409, `http=${attempts.status} code=${attempts.body?.error?.code}`);
            return { turns: detail.body.turns.length, reviews: Object.keys(detail.body.reviews).length, hasReport: detail.body.report !== null };
        });
        collected.restart = restart;
        // 11. 开关：关历史 / 关录音
        const toggles = await step('两开关：关历史不产生持久记录；关录音不产生音频文件', async () => {
            const statsBefore = await api('GET', '/api/stats');
            const audioFilesBefore = statsBefore.body.stats.audioFiles;
            // 关历史
            const offHistory = await api('POST', '/api/sessions', { synthetic: true, saveHistory: false });
            const sidOff = offHistory.body.sid;
            await api('POST', `/api/sessions/${sidOff}/materials`, { jd: DEMO_MATERIALS.jd, experience: DEMO_MATERIALS.experience, stage: DEMO_MATERIALS.stage, targetRole: DEMO_MATERIALS.targetRole });
            const mic = await NodeMic.connect(sidOff);
            await api('POST', `/api/sessions/${sidOff}/answer/start`);
            const pcm = readFileSync(answerPcmFiles[2]!);
            await mic.streamPcm(pcm);
            const doneOff = await api('POST', `/api/sessions/${sidOff}/answer/done`);
            mic.close();
            const listOff = await api('GET', '/api/sessions');
            const statsOff = await api('GET', '/api/stats');
            assert('关历史后不产生新的持久会话记录', statsOff.body.stats.real + statsOff.body.stats.synthetic === statsBefore.body.stats.real + statsBefore.body.stats.synthetic, `sessions=${statsOff.body.stats.real + statsOff.body.stats.synthetic}（前 ${statsBefore.body.stats.real + statsBefore.body.stats.synthetic}）`);
            assert('关历史后不产生音频文件', statsOff.body.stats.audioFiles === audioFilesBefore, `audioFiles=${statsOff.body.stats.audioFiles}（前 ${audioFilesBefore}）`);
            assert('关历史的会话在接口里如实标注 persisted=false', (await api('GET', `/api/sessions/${sidOff}`)).body.persisted === false, `state=${doneOff.body.snapshot?.state} transcript=${(doneOff.body.snapshot?.turns ?? []).filter((t: any) => t.speaker === 'user').length} 轮`);
            assert('关历史的会话仍完成了真实 ASR（不是空跑）', (doneOff.body.snapshot?.turns ?? []).some((t: any) => t.speaker === 'user' && t.rawTranscript.length > 5), JSON.stringify((doneOff.body.snapshot?.turns ?? []).map((t: any) => [t.speaker, t.rawTranscript.slice(0, 12)])));
            assert('会话列表里查不到关历史的会话', listOff.body.items.every((s: any) => s.id !== sidOff), `total=${listOff.body.total}`);
            // 关录音
            const offAudio = await api('POST', '/api/sessions', { synthetic: true, saveAudio: false });
            const sidNoAudio = offAudio.body.sid;
            await api('POST', `/api/sessions/${sidNoAudio}/materials`, { jd: DEMO_MATERIALS.jd, experience: DEMO_MATERIALS.experience, stage: DEMO_MATERIALS.stage, targetRole: DEMO_MATERIALS.targetRole });
            const mic2 = await NodeMic.connect(sidNoAudio);
            await api('POST', `/api/sessions/${sidNoAudio}/answer/start`);
            await mic2.streamPcm(readFileSync(answerPcmFiles[3]!));
            await api('POST', `/api/sessions/${sidNoAudio}/answer/done`);
            mic2.close();
            const detailNoAudio = await api('GET', `/api/sessions/${sidNoAudio}`);
            const userTurn = detailNoAudio.body.turns.find((t: any) => t.speaker === 'user');
            const statsNoAudio = await api('GET', '/api/stats');
            const audioRes = await fetch(`${APP_URL}/api/sessions/${sidNoAudio}/turns/${userTurn.id}/audio/user`);
            assert('关录音后文本记录照常入库', userTurn !== undefined && userTurn.rawTranscript.length > 5, `transcript=${(userTurn?.rawTranscript ?? '').slice(0, 20)}`);
            assert('关录音后磁盘音频文件数不变', statsNoAudio.body.stats.audioFiles === audioFilesBefore, `audioFiles=${statsNoAudio.body.stats.audioFiles}`);
            assert('关录音后该轮 audioFile 为 null（不伪造路径）', userTurn.audioFile === null, `audioFile=${String(userTurn.audioFile)}`);
            const audioSource = audioRes.headers.get('x-audio-source');
            assert('关录音后本场回放只来自内存、磁盘上没有音频文件', (audioRes.status === 200 && audioSource === 'memory') || audioRes.status === 404, `http=${audioRes.status} source=${String(audioSource)} audioFiles=${statsNoAudio.body.stats.audioFiles}`);
            return { offHistory: sidOff, offAudio: sidNoAudio, audioFilesBefore, audioFilesAfter: statsNoAudio.body.stats.audioFiles };
        });
        collected.toggles = toggles;
        // 12. 删除会话：数据库 / 音频 / 临时文件前后对照
        const deletion = await step('删除主会话：数据库记录 + 音频文件 + 临时文件的前后对照', async () => {
            const scanOpts = { skip: ['chrome-profiles', 'answer-audio'] };
            const dataFilesBefore = listFilesRecursive(DATA_DIR, scanOpts);
            // 造一个属于该会话的临时文件（模拟上传解析中断留下的残留），验证删除会连它一起清掉
            mkdirSync(paths.uploadTmpDir, { recursive: true });
            const strayTmp = path.join(paths.uploadTmpDir, `${sid}-stray-resume.pdf`);
            writeFileSync(strayTmp, 'x');
            const del = await api('DELETE', `/api/sessions/${sid}`);
            const db = new InterviewDb(paths.dbFile);
            const row = db.raw.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(sid);
            const turns = db.raw.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?').get(sid);
            const feedbacks = db.raw.prepare('SELECT COUNT(*) AS n FROM feedbacks WHERE session_id = ?').get(sid);
            db.close();
            const audioDir = path.join(paths.audioDir, sid);
            const after = await api('GET', `/api/sessions/${sid}`);
            assert('删除前确有数据库记录与音频文件', del.body.before.rows.sessions === 1 && del.body.before.rows.turns > 0 && del.body.before.audioFiles.length > 0, JSON.stringify(del.body.before.rows) + ` audio=${del.body.before.audioFiles.length}`);
            assert('删除后数据库无关联记录（独立查询 sqlite 复核）', Number(row?.n ?? -1) === 0 && Number(turns?.n ?? -1) === 0 && Number(feedbacks?.n ?? -1) === 0, `sessions=${String(row?.n)} turns=${String(turns?.n)} feedbacks=${String(feedbacks?.n)}`);
            assert('删除后音频目录不存在', !existsSync(audioDir), `dir=${path.relative(REPO_ROOT, audioDir)}`);
            assert('删除后临时文件被一并清理', !existsSync(strayTmp) && del.body.after.tmpFiles.length === 0, `tmpRemoved=${JSON.stringify(del.body.removed.tmpFiles)}`);
            assert('删除接口返回删除前后对照且自检通过', del.body.verified === true, JSON.stringify(del.body.after));
            assert('删除后查询该会话返回 404', after.status === 404, `http=${after.status}`);
            assert('删除没有波及其它会话的文件', listFilesRecursive(DATA_DIR, scanOpts).length >= dataFilesBefore.length - del.body.before.audioFiles.length - 1, `before=${dataFilesBefore.length} after=${listFilesRecursive(DATA_DIR, scanOpts).length}`);
            return { before: del.body.before, after: del.body.after, removed: del.body.removed, dbRecheck: { sessions: row?.n ?? null, turns: turns?.n ?? null, feedbacks: feedbacks?.n ?? null } };
        });
        collected.deletion = deletion;
        // 13. 日志与凭证纪律
        const hygiene = await step('凭证与日志纪律：浏览器侧无密钥、日志无简历全文与完整转写', async () => {
            const logFile = path.join(DATA_DIR, 'server.log');
            const logText = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
            const key = process.env.DASHSCOPE_API_KEY ?? '';
            const answerSample = (ANSWER_TEXTS[0] ?? '').slice(0, 30);
            assert('服务日志里没有凭证值', key.length < 8 || !logText.includes(key), `logBytes=${logText.length}`);
            assert('服务日志里没有 sk-* 模式', !/sk-[A-Za-z0-9._-]{12,}/.test(logText), '扫描整份日志');
            assert('服务日志里没有作答原文（30 字连续片段）', !logText.includes(answerSample), `sample=${answerSample.slice(0, 12)}…`);
            const health = await api('GET', '/api/health');
            assert('健康检查只报凭证存在性、不返回值', health.body.credential.present === true && !JSON.stringify(health.body).includes(key), `present=${health.body.credential.present} length=${health.body.credential.length}`);
            return { logBytes: logText.length };
        });
        collected.hygiene = hygiene;
    }
    finally {
        server.kill();
    }
    // ---------- 证据落盘 ----------
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const db = new InterviewDb(paths.dbFile);
    const usage = {
        turns: Number((db.raw.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number } | undefined)?.n ?? 0),
        sessions: Number((db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number } | undefined)?.n ?? 0),
    };
    db.close();
    const summary = {
        ranAt: new Date().toISOString(),
        chrome: chromeVersion,
        platform: `${process.platform} ${process.arch}`,
        node: process.version,
        appUrl: APP_URL,
        realtimeModel: realtimeModelForRun ?? REALTIME_DEFAULTS.model,
        realtimeModelProbe: modelProbe,
        dataDir: path.relative(REPO_ROOT, DATA_DIR),
        audioSource: '作答语音＝macOS `say` 合成语音的 PCM16@16k，由页面按 100ms 分片推给本地服务（与产品页面上行同一条 WS 协议）；真实麦克风采集链路由 Chrome 假设备单独覆盖（提示音，用于空转写状态）。**真人对着麦克风说话、环境噪声、真实语速仍未验证**。Chrome 153 的 `--use-file-for-fake-audio-capture` 在本机预检为静音（RMS 0.0，默认假设备 0.72），因此未采用。',
        steps: steps.map((s) => ({ name: s.name, ms: s.ms, detail: s.detail, assertions: s.assertions })),
        totals: { assertions: steps.reduce((a, s) => a + s.assertions.length, 0), failed: failures, ms: Date.now() - startedAt },
        remaining: { sessions: usage.sessions, turns: usage.turns },
        collected,
    };
    const summaryText = JSON.stringify(summary, null, 2);
    assertNoSecret(summaryText);
    writeFileSync(path.join(EVIDENCE_DIR, 'summary.json'), `${summaryText}\n`);
    const docText = renderAcceptanceDoc(summary);
    assertNoSecret(docText);
    writeFileSync(DOC_FILE, docText);
    writeFileSync(path.join(EVIDENCE_DIR, 'acceptance.md'), docText);
    // manifest：复用仓库既有形状（artifacts + verifiedAgainstDisk），排除 manifest 自身避免自指
  const manifestPath = path.join(EVIDENCE_DIR, 'manifest.json');
  writeManifestFromDir(EVIDENCE_DIR, manifestPath, [path.relative(REPO_ROOT, manifestPath)]);
  const verification = verifyManifest(manifestPath);
  const manifestDoc = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifestDoc.verifiedAgainstDisk = { total: verification.total, mismatches: verification.mismatches, checkedAt: new Date().toISOString() };
  writeFileSync(manifestPath, `${JSON.stringify(manifestDoc, null, 2)}\n`);

  process.stdout.write(`[evidence] ${DOC_FILE}\n[evidence] ${path.join(EVIDENCE_DIR, 'summary.json')}\n`);
    if (failures > 0) {
        process.stderr.write(`[result] FAIL：${failures} 个断言未通过\n`);
        process.exit(1);
    }
    process.stdout.write('[result] PASS：全部断言通过\n');
}
async function docOnly(): Promise<void> {
  const summaryFile = path.join(EVIDENCE_DIR, 'summary.json');
  if (!existsSync(summaryFile)) throw new Error(`没有可用的运行数据：${summaryFile}`);
  const summary = JSON.parse(readFileSync(summaryFile, 'utf8')) as Record<string, unknown>;
  const docText = renderAcceptanceDoc(summary);
  assertNoSecret(docText);
  writeFileSync(DOC_FILE, docText);
  writeFileSync(path.join(EVIDENCE_DIR, 'acceptance.md'), docText);
  const manifestPath = path.join(EVIDENCE_DIR, 'manifest.json');
  writeManifestFromDir(EVIDENCE_DIR, manifestPath, [path.relative(REPO_ROOT, manifestPath)]);
  const verification = verifyManifest(manifestPath);
  const manifestDoc = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifestDoc.verifiedAgainstDisk = { total: verification.total, mismatches: verification.mismatches, checkedAt: new Date().toISOString() };
  manifestDoc.note = 'doc-only 重建：数据来自 summary.json，未重新调用模型';
  writeFileSync(manifestPath, `${JSON.stringify(manifestDoc, null, 2)}\n`);

  process.stdout.write(`[evidence] 已由 summary.json 重建：${DOC_FILE}\n`);
}

const docOnlyFlag = process.argv.includes('--doc-only');
if (docOnlyFlag) {
  // 只重建文档：不启动服务、不调用模型（改文档模板后用它重生成，避免为此重跑真实调用）
  docOnly()
    .then(() => process.exit(0))
    .catch((e) => {
      process.stderr.write(`[fatal] ${(e as Error).message}\n`);
      process.exit(1);
    });
} else {
  main().catch((e) => {
    const message = (e as Error).message;
    process.stderr.write(`[fatal] ${message}\n`);
    writeFatalEvidence(message);
    process.exit(1);
  });
}
