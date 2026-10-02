/**
 * 浏览器音频 prototype 的本地 mock 实时服务（T1-S：只验证浏览器音频链路，不涉及真实模型）。
 *
 * - 仅绑定 127.0.0.1
 * - HTTP：静态页面 + 会话/轮次/音频文件的落盘、列表、回放、删除
 * - WebSocket /realtime：mock 实时链路。D2 约束的 mock 版：服务端只朗读应用层 inject_text
 *   注入的文本（合成为 WAV 音频），绝不自行生成问题。
 */
import http from 'node:http';
import { mkdirSync, rmSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'src', 'prototype', 'public');
const DATA_DIR = process.env.PROTOTYPE_DATA_DIR ? path.resolve(process.env.PROTOTYPE_DATA_DIR) : path.join(REPO_ROOT, 'data', 'prototype');
const PORT = Number(process.env.PROTOTYPE_PORT ?? 8917);
const HOST = '127.0.0.1';

interface TurnRecord {
  tid: string;
  seq: number;
  questionText: string;
  startedAt: string;
  endedAt: string | null;
  userAudioBytes: number;
  interviewerAudioBytes: number;
}

interface SessionRecord {
  sid: string;
  createdAt: string;
  turns: Map<string, TurnRecord>;
}

const sessions = new Map<string, SessionRecord>();

/** 生成一段 16kHz 单声道 16bit PCM WAV（基频 440Hz 的调制音，模拟面试官语音）。 */
function synthesizeInterviewerWav(seconds = 1.2): Buffer {
  const sampleRate = 16000;
  const numSamples = Math.floor(sampleRate * seconds);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = 0.5 * (1 + Math.sin(2 * Math.PI * 0.8 * t)); // 模拟音节起伏
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * t) * 0.4 * envelope * 32767);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

function sessionDir(sid: string): string {
  return path.join(DATA_DIR, sid);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(path.relative(DATA_DIR, p));
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, host: HOST, port: PORT });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = (await import('node:fs')).readFileSync(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      const sid = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      sessions.set(sid, { sid, createdAt: new Date().toISOString(), turns: new Map() });
      mkdirSync(sessionDir(sid), { recursive: true });
      console.log(`[session] created ${sid}`);
      return json(res, 200, { sid });
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      return json(res, 200, { sessions: [...sessions.values()].map((s) => ({ sid: s.sid, turns: s.turns.size })) });
    }
    let m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const s = sessions.get(m[1]!);
      if (!s) return json(res, 404, { error: 'session not found' });
      return json(res, 200, {
        sid: s.sid,
        turns: [...s.turns.values()],
        filesOnDisk: listFilesRecursive(sessionDir(s.sid)),
      });
    }
    m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/user-audio$/);
    if (req.method === 'POST' && m) {
      const s = sessions.get(m[1]!);
      if (!s) return json(res, 404, { error: 'session not found' });
      const body = await readBody(req);
      if (body.length === 0) return json(res, 400, { error: 'empty audio body' });
      const file = `turn-${m[2]}-user.webm`;
      writeFileSync(path.join(sessionDir(s.sid), file), body);
      const rec = s.turns.get(m[2]!) ?? {
        tid: m[2]!,
        seq: s.turns.size + 1,
        questionText: '',
        startedAt: new Date().toISOString(),
        endedAt: null,
        userAudioBytes: 0,
        interviewerAudioBytes: 0,
      };
      rec.userAudioBytes = body.length;
      s.turns.set(m[2]!, rec);
      console.log(`[turn] ${s.sid}/${m[2]} user audio saved: ${body.length} bytes`);
      return json(res, 200, { file, bytes: body.length });
    }
    m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/close$/);
    if (req.method === 'POST' && m) {
      const s = sessions.get(m[1]!);
      if (!s) return json(res, 404, { error: 'session not found' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { questionText?: string; startedAt?: string };
      const wav = synthesizeInterviewerWav();
      const file = `turn-${m[2]}-interviewer.wav`;
      writeFileSync(path.join(sessionDir(s.sid), file), wav);
      const rec = s.turns.get(m[2]!) ?? {
        tid: m[2]!,
        seq: s.turns.size + 1,
        questionText: '',
        startedAt: new Date().toISOString(),
        endedAt: null,
        userAudioBytes: 0,
        interviewerAudioBytes: 0,
      };
      rec.questionText = body.questionText ?? '';
      if (body.startedAt) rec.startedAt = body.startedAt;
      rec.endedAt = new Date().toISOString();
      rec.interviewerAudioBytes = wav.length;
      s.turns.set(m[2]!, rec);
      console.log(`[turn] ${s.sid}/${m[2]} closed, interviewer wav: ${wav.length} bytes`);
      return json(res, 200, { turn: rec, interviewerWav: wav.length });
    }
    m = url.pathname.match(/^\/api\/files\/([^/]+)\/(.+)$/);
    if (req.method === 'GET' && m) {
      const p = path.join(DATA_DIR, m[1]!, m[2]!);
      if (!p.startsWith(DATA_DIR) || !existsSync(p)) return json(res, 404, { error: 'file not found' });
      const ext = path.extname(p);
      res.writeHead(200, { 'Content-Type': ext === '.wav' ? 'audio/wav' : 'audio/webm' });
      return res.end((await import('node:fs')).readFileSync(p));
    }
    m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (req.method === 'DELETE' && m) {
      const sid = m[1]!;
      const s = sessions.get(sid);
      if (!s) return json(res, 404, { error: 'session not found' });
      const filesBefore = listFilesRecursive(sessionDir(sid));
      rmSync(sessionDir(sid), { recursive: true, force: true });
      sessions.delete(sid);
      const remaining = listFilesRecursive(DATA_DIR);
      console.log(`[session] deleted ${sid}: removed ${filesBefore.length} files, remaining in data dir: ${remaining.length}`);
      return json(res, 200, { sid, removedFiles: filesBefore, remainingFilesInDataDir: remaining, sessionCount: sessions.size });
    }
    return json(res, 404, { error: `no route: ${req.method} ${url.pathname}` });
  } catch (e) {
    console.error(`[error] ${req.method} ${url.pathname}:`, (e as Error).message);
    return json(res, 500, { error: (e as Error).message });
  }
});

/** mock 实时链路：D2 的 mock 版——服务端只朗读 inject_text 注入的内容，不自行生成问题。 */
const wss = new WebSocketServer({ server, path: '/realtime' });
const pendingAudio = new WeakMap<WebSocket, Buffer>();

wss.on('connection', (ws) => {
  let lastInjectedText: string | null = null;
  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // 本 mock 不处理上行音频帧
    const msg = JSON.parse(data.toString()) as { type: string; sid?: string; text?: string; turnNo?: number };
    switch (msg.type) {
      case 'session_open':
        console.log(`[ws] session_open ${msg.sid}`);
        ws.send(JSON.stringify({ type: 'session_open_ack', sid: msg.sid }));
        break;
      case 'inject_text':
        lastInjectedText = msg.text ?? '';
        console.log(`[ws] inject_text (${lastInjectedText.length} chars)`);
        ws.send(JSON.stringify({ type: 'inject_ack', text: lastInjectedText }));
        break;
      case 'answer_done': {
        // 服务端合成“面试官回应音频”；文本必须逐字来自注入内容（D2 mock）。
        const wav = synthesizeInterviewerWav();
        pendingAudio.set(ws, wav);
        ws.send(JSON.stringify({ type: 'response_event', text: lastInjectedText, audioBytes: wav.length, turnNo: msg.turnNo }));
        ws.send(wav);
        console.log(`[ws] answer_done → response_event (${wav.length} bytes audio, text from inject_text)`);
        break;
      }
      case 'interrupt': {
        // mock 端无待发队列可清；真实端此事件会取消生成与待播分帧。此处回执确认。
        ws.send(JSON.stringify({ type: 'interrupt_ack', clearedPending: true }));
        console.log('[ws] interrupt → ack (server has no pending audio in mock)');
        break;
      }
      default:
        ws.send(JSON.stringify({ type: 'error', detail: `unknown type: ${(msg as { type: string }).type}` }));
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[prototype] mock server listening on http://${HOST}:${PORT} (ws: /realtime)`);
  console.log(`[prototype] data dir: ${DATA_DIR}`);
});
