/**
 * 音频 prototype 自动化证据采集：真实 Chrome（M1 本机）+ CDP 驱动完整链路。
 *
 * 链路（MYW-84 T1-S 验收项）：采集 → 播放 → 打断清空待播 → 手动「回答完毕」→
 * 按轮次落盘 → 回放 → 删除后无残留文件。
 *
 * 运行：npm run prototype:run（自动拉起 mock 服务与 headless Chrome，结束自动清理）
 * 产出：docs/t1s-audio-prototype-evidence.md（含逐步断言与真实文件查询证据）
 *
 * 说明：音频输入使用 Chrome 官方 fake media device（--use-fake-device-for-media-stream），
 * 走真实 getUserMedia/MediaRecorder/WebAudio API；回应音频为本地 mock 服务合成，无真实模型。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DATA_DIR = process.env.PROTOTYPE_DATA_DIR ? path.resolve(process.env.PROTOTYPE_DATA_DIR) : path.join(REPO_ROOT, 'data', 'prototype');
const EVIDENCE_FILE = path.join(REPO_ROOT, 'docs', 't1s-audio-prototype-evidence.md');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP_PORT = Number(process.env.PROTOTYPE_PORT ?? 8917);
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;
const CDP_PORT = 9333;

/** 判断端口上是不是我们的 mock 服务（防止撞上无关服务的同名端点）。 */
async function isOurServer(): Promise<boolean> {
  try {
    const r = await fetchJson<{ ok?: boolean; port?: number }>(`http://127.0.0.1:${APP_PORT}/api/health`);
    return r?.ok === true && r?.port === APP_PORT;
  } catch {
    return false;
  }
}

interface Step {
  name: string;
  detail: unknown;
  ms: number;
  assertions: Array<{ label: string; pass: boolean; evidence: string }>;
}

const steps: Step[] = [];
const t0 = Date.now();
let failures = 0;

function assert(label: string, pass: boolean, evidence: string): boolean {
  if (!pass) failures++;
  steps[steps.length - 1]?.assertions.push({ label, pass, evidence });
  return pass;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  steps.push({ name, detail: null, ms: 0, assertions: [] });
  const result = await fn();
  const s = steps[steps.length - 1]!;
  s.detail = result ?? null;
  s.ms = Date.now() - start;
  console.log(`[step] ${name} (${s.ms}ms)`);
  return result;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  return (await res.json()) as T;
}

/** 最小 CDP 客户端（ws）。 */
class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  constructor(private ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      }
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e) => reject(new Error(`ws: ${(e as Error).message}`)));
    });
    return new Cdp(ws);
  }
  send(method: string, params: object = {}): Promise<unknown> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval<T>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (r.exceptionDetails) {
      throw new Error(`页面执行异常: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result?.value as T;
  }
  close(): void {
    this.ws.close();
  }
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await wait(300);
  }
  throw new Error(`等待超时: ${label}`);
}

function listFilesRecursiveSafe(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFilesRecursiveSafe(p));
    else out.push(path.relative(DATA_DIR, p));
  }
  return out;
}

async function main(): Promise<void> {
  if (!existsSync(CHROME)) throw new Error(`未找到 Chrome: ${CHROME}`);

  // 1. mock 服务：已在跑且确认是我们的，则复用；否则拉起
  let serverProc: ChildProcess | null = null;
  let serverOwned = false;
  if (await isOurServer()) {
    console.log('[setup] mock server already running');
  } else {
    serverProc = spawn(process.execPath, [path.join(REPO_ROOT, 'dist/src/prototype/server.js')], { stdio: 'inherit' });
    serverOwned = true;
    await waitFor(isOurServer, 15000, 'mock server health');
    console.log('[setup] mock server started');
  }

  // 2. headless Chrome（真实 Chrome，fake 音频输入设备）
  const tmpProfile = path.join(REPO_ROOT, 'data', 'chrome-profile-tmp');
  rmSync(tmpProfile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${tmpProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });

  let chromeVersion = '';
  try {
    await waitFor(async () => {
      try {
        const v = await fetchJson<{ Browser?: string }>(`http://127.0.0.1:${CDP_PORT}/json/version`);
        chromeVersion = v.Browser ?? '';
        return chromeVersion.length > 0;
      } catch {
        return false;
      }
    }, 20000, 'chrome devtools endpoint');
  } catch (e) {
    chrome.kill();
    if (serverOwned) serverProc?.kill();
    throw e;
  }
  console.log(`[setup] chrome: ${chromeVersion}`);

  let cdp: Cdp | null = null;
  try {
    const targets = await fetchJson<Array<{ type: string; webSocketDebuggerUrl: string }>>(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('无 page target');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitFor(async () => {
      const ready = await cdp!.eval<string>('document.readyState');
      return ready === 'complete';
    }, 15000, 'page load');
    console.log('[setup] page loaded');

    // ===== 链路驱动 =====
    const sid = await step('创建会话', () => cdp!.eval<string>('window.__protoDriver.createSession()'));
    assert('会话 id 生成', /^s-/.test(sid ?? ''), String(sid));

    const cap1 = await step('采集（turn 1，2.0s，fake mic 走真实 getUserMedia/MediaRecorder）', () =>
      cdp!.eval<{ ok: boolean; micDenied: boolean }>('window.__protoDriver.startCapture(2.0)'));
    assert('麦克风授权成功（fake device）', cap1?.ok === true, JSON.stringify(cap1));
    const stCap = await cdp!.eval<{ lastBlobSize: number }>('window.__protoDriver.status()');
    assert('采集产生非空音频数据', (stCap?.lastBlobSize ?? 0) > 0, `blob=${stCap?.lastBlobSize}B`);

    await step('注入问题文本并触发 mock 回应（D2：只朗读注入文本）', () =>
      cdp!.eval<boolean>('window.__protoDriver.injectAndRespond("第一题：请介绍你做过的一个最有代表性的项目")'));

    await step('播放（回应音频已入队并开始播放）', () => cdp!.eval('window.__protoDriver.sleep(450)'));
    const stPlay = await cdp!.eval<{ playing: boolean; queueLength: number; lastResponseText: string | null; injectedText: string | null }>('window.__protoDriver.status()');
    assert('回应音频正在播放或已入队', (stPlay?.playing ?? false) || (stPlay?.queueLength ?? 0) > 0, JSON.stringify(stPlay));
    assert('播放文本逐字来自注入文本（D2）', stPlay?.lastResponseText === stPlay?.injectedText && stPlay?.lastResponseText !== null, JSON.stringify({ injected: stPlay?.injectedText, response: stPlay?.lastResponseText }));

    const cleared = await step('打断：停止当前播放并清空待播队列', () => cdp!.eval<number>('window.__protoDriver.interrupt()'));
    const stInt = await cdp!.eval<{ playing: boolean; queueLength: number }>('window.__protoDriver.status()');
    assert('打断后播放停止', stInt?.playing === false, JSON.stringify(stInt));
    assert('打断后待播队列清空', (stInt?.queueLength ?? -1) === 0, `cleared=${cleared}, queue=${stInt?.queueLength}`);

    const done1 = await step('手动「回答完毕」：上传用户音频并按轮次落盘（turn 1）', () =>
      cdp!.eval<{ tid: string; userBytes: number; interviewerBytes: number }>('window.__protoDriver.finalizeTurn("第一题：请介绍你做过的一个最有代表性的项目")'));
    assert('turn 1 用户音频落盘 >0 字节', (done1?.userBytes ?? 0) > 0, JSON.stringify(done1));
    assert('turn 1 面试官音频落盘 >0 字节', (done1?.interviewerBytes ?? 0) > 0, JSON.stringify(done1));

    const cap2 = await step('采集（turn 2，1.5s）', () => cdp!.eval('window.__protoDriver.startCapture(1.5)'));
    assert('turn 2 采集成功', (cap2 as { ok?: boolean })?.ok === true, JSON.stringify(cap2));
    const done2 = await step('手动「回答完毕」（turn 2，含触发回应并完整播放）', () =>
      cdp!.eval('window.__protoDriver.manualAnswerDone("第二题：这件事里你个人的贡献是什么")'));
    assert('turn 2 落盘完成', (done2 as { userBytes?: number })?.userBytes! > 0 && (done2 as { interviewerBytes?: number })?.interviewerBytes! > 0, JSON.stringify(done2));
    await step('等待回应音频完整播放（约 1.5s）', () => cdp!.eval('window.__protoDriver.sleep(1600)'));
    const stPlayed = await cdp!.eval<{ playedMs: number; queueLength: number }>('window.__protoDriver.status()');
    assert('回应音频实际播放了（playedMs>0 且队列排空）', (stPlayed?.playedMs ?? 0) > 0 && (stPlayed?.queueLength ?? -1) === 0, JSON.stringify(stPlayed));

    const replay = await step('回放 turn 1 用户音频（从服务器取回并解码播放）', () =>
      cdp!.eval<{ tid: string; bytes: number; durationSec: number; playedMs: number }>('window.__protoDriver.replayTurn("1")'));
    assert('回放文件取回并解码（duration>0）', (replay?.durationSec ?? 0) > 0, JSON.stringify(replay));
    assert('回放真实出声（playedMs>0）', (replay?.playedMs ?? 0) > 0, JSON.stringify(replay));

    const sessionBefore = await step('删除前文件清单（服务端视角）', () =>
      fetchJson<{ sid: string; turns: unknown[]; filesOnDisk: string[] }>(`http://127.0.0.1:${APP_PORT}/api/sessions/${sid}`));
    assert('删除前磁盘上有轮次音频文件', (sessionBefore?.filesOnDisk?.length ?? 0) >= 4, JSON.stringify(sessionBefore?.filesOnDisk));

    const del = await step('删除会话（数据库记录+音频+临时文件）', () =>
      cdp!.eval<{ sid: string; removedFiles: string[]; remainingFilesInDataDir: string[]; sessionCount: number }>('window.__protoDriver.deleteSession()'));
    assert('删除返回的移除文件数 ≥4', (del?.removedFiles?.length ?? 0) >= 4, JSON.stringify(del?.removedFiles));
    assert('数据目录剩余文件为 0（服务端扫描）', (del?.remainingFilesInDataDir?.length ?? -1) === 0, JSON.stringify(del?.remainingFilesInDataDir));
    assert('会话记录清空（sessionCount=0）', del?.sessionCount === 0, `sessionCount=${del?.sessionCount}`);

    const listAfter = await step('删除后查询会话列表与磁盘（OS 级独立复核）', () =>
      fetchJson<{ sessions: unknown[] }>(`http://127.0.0.1:${APP_PORT}/api/sessions`));
    const osScan = listFilesRecursiveSafe(DATA_DIR);
    assert('API 会话列表为空', (listAfter?.sessions?.length ?? -1) === 0, JSON.stringify(listAfter));
    assert('OS 级 fs 扫描数据目录为空（无残留）', osScan.length === 0, `${DATA_DIR} 下残留: ${JSON.stringify(osScan)}`);
    // chrome 临时 profile 属运行产物，一并清理
    rmSync(tmpProfile, { recursive: true, force: true });
  } finally {
    cdp?.close();
    chrome.kill();
    if (serverOwned) serverProc?.kill();
  }

  // ===== 证据文档 =====
  mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
  const lines: string[] = [];
  lines.push('# T1-S 音频 prototype 运行证据（真实 Chrome · mock 实时服务）');
  lines.push('');
  lines.push(`- 运行时间：${new Date().toISOString()}`);
  lines.push(`- 运行方式：\`npm run prototype:run\`（自动拉起 mock 服务与 Chrome，CDP 驱动页面 \`window.__proto\* \` 接口）`);
  lines.push(`- Chrome：\`${chromeVersion}\`（本机 M1，headless=new）`);
  lines.push('- 关键 flags：`--use-fake-device-for-media-stream`（Chrome 官方假音频输入设备，走真实 getUserMedia/MediaRecorder/WebAudio API）、`--use-fake-ui-for-media-stream`（自动授予麦克风权限）');
  lines.push('- 音频来源声明：用户侧＝fake device 采集的真实 MediaRecorder 输出；面试官侧＝本地 mock 服务合成 WAV。**无真实模型参与，本证据只证明浏览器音频链路与文件链路，不涉及模型质量。**');
  lines.push('');
  lines.push('| # | 步骤 | 耗时 | 断言 |');
  lines.push('| --- | --- | --- | --- |');
  steps.forEach((s, i) => {
    const a = s.assertions.map((x) => `${x.pass ? '✅' : '❌'} ${x.label}`).join('<br>') || '—';
    lines.push(`| ${i + 1} | ${s.name} | ${s.ms}ms | ${a} |`);
  });
  lines.push('');
  lines.push('## 断言明细');
  for (const s of steps) {
    for (const a of s.assertions) {
      lines.push(`- ${a.pass ? 'PASS' : 'FAIL'} ${a.label}｜证据：${a.evidence}`);
    }
  }
  lines.push('');
  lines.push(`## 结论：${failures === 0 ? '静态通过（浏览器音频链路与文件链路全部断言通过）' : `存在 ${failures} 个失败断言`}`);
  lines.push('');
  lines.push(`总耗时 ${Date.now() - t0}ms。本次数据目录：\`${DATA_DIR}\`；删除后 OS 级扫描为空（见最后两步断言）。`);
  writeFileSync(EVIDENCE_FILE, lines.join('\n'), 'utf8');
  console.log(`[evidence] written: ${EVIDENCE_FILE}`);

  if (failures > 0) {
    console.error(`[result] FAIL：${failures} 个断言未通过`);
    process.exit(1);
  }
  console.log('[result] PASS：全部断言通过');
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
