/**
 * 本地服务（MYW-85）：只绑 `127.0.0.1`，浏览器不接触密钥。
 *
 * 两套通道：
 * - HTTP JSON API：材料、会话、评审、报告、历史、回放、删除、设置、首次使用告知；
 *   统一错误响应 `{error:{code,message,hint?,detail?}}`（见 errors.ts），列表接口带分页。
 * - WebSocket `/realtime`：浏览器 ↔ 服务端音频与阶段事件；服务端再经 `RealtimeBridge` 代理到百炼。
 *   **服务端 → 浏览器的任何消息里都不含凭证**（测试里逐条断言）。
 *
 * `/harness` 保留验收用最小客户端；方案 C 的正式产品构建产物由同一服务同源托管。
 * 本模块只负责托管，不包含视觉/交互层实现。
 */
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { validateContract } from '../contracts/validate.js';
import { CONTRACT_VERSION } from '../contracts/version.js';
import { RULES_VERSION, rulesDigest } from '../rules/rules.js';
import { DASHSCOPE_DEFAULTS } from '../clients/dashscope.js';
import { REALTIME_DEFAULTS } from '../clients/realtime-dashscope.js';
import { DISCLOSURE, DISCLOSURE_VERSION } from './disclosure.js';
import { AppError, asAppError, type ErrorBody } from './errors.js';
import type { Logger } from './log.js';
import type { SessionManager } from './manager.js';
import { parseMaterialFile } from './materials.js';
import { REPO_ROOT, type WebPaths } from './paths.js';
import type { SettingsStore } from './settings.js';
import type { Store } from './store.js';
import type { CredentialConfigStore } from './credentials.js';

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const HARNESS_FILE = path.join(REPO_ROOT, 'src', 'web', 'public', 'harness.html');

export interface ServerDeps {
  manager: SessionManager;
  store: Store;
  settings: SettingsStore;
  credentials: CredentialConfigStore;
  logger: Logger;
  paths: WebPaths;
  staticDir: string;
  port: number;
  host: string;
}

export interface RunningServer {
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function errorJson(res: http.ServerResponse, err: AppError): void {
  const body: ErrorBody = err.toBody();
  json(res, err.httpStatus, body);
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/** 同源托管 Vite 构建产物；无扩展名路由回退 index.html，API 与 harness 不走这里。 */
function serveStatic(staticDir: string, pathname: string, res: http.ServerResponse): boolean {
  const root = path.resolve(staticDir);
  const index = path.join(root, 'index.html');
  if (!existsSync(index)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return false;
  const relative = decoded.replace(/^\/+/, '');
  const candidate = path.resolve(root, relative === '' ? 'index.html' : relative);
  const relativeToRoot = path.relative(root, candidate);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) return false;
  const candidateIsFile = existsSync(candidate) && statSync(candidate).isFile();
  const file = candidateIsFile ? candidate : path.extname(relative) === '' ? index : null;
  if (file === null) return false;
  const body = readFileSync(file);
  res.writeHead(200, {
    'Content-Type': STATIC_CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(body.length),
    'Cache-Control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(body);
  return true;
}

async function readBody(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > limit) {
        reject(new AppError('E_BAD_REQUEST', `请求体超过上限 ${limit} 字节`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (e) => reject(new AppError('E_BAD_REQUEST', `读取请求体失败：${e.message}`)));
  });
}

async function readJsonObject(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  try {
    const parsed = JSON.parse(buf.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层必须是 JSON 对象');
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new AppError('E_BAD_REQUEST', `请求体不是合法 JSON 对象：${(e as Error).message}`);
  }
}

function requireString(body: Record<string, unknown>, key: string, opts: { min?: number; max?: number } = {}): string {
  const v = body[key];
  if (typeof v !== 'string') throw new AppError('E_VALIDATION', `字段 ${key} 必须是字符串`);
  const trimmed = v.trim();
  if (opts.min !== undefined && trimmed.length < opts.min) throw new AppError('E_VALIDATION', `字段 ${key} 至少 ${opts.min} 个字符`);
  if (opts.max !== undefined && trimmed.length > opts.max) throw new AppError('E_VALIDATION', `字段 ${key} 最多 ${opts.max} 个字符`);
  return trimmed;
}

function optionalBool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new AppError('E_VALIDATION', `字段 ${key} 必须是布尔值`);
  return v;
}

function optionalAnswerStartMode(body: Record<string, unknown>): 'continuous' | 'manual' | undefined {
  const value = body.answerStartMode;
  if (value === undefined) return undefined;
  if (value !== 'continuous' && value !== 'manual') throw new AppError('E_VALIDATION', '字段 answerStartMode 只能是 continuous 或 manual');
  return value;
}

export function createServer(deps: ServerDeps): RunningServer {
  const { manager, store, settings, credentials, logger } = deps;
  let configToken = randomUUID();
  let configWrites: number[] = [];

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${deps.host}:${deps.port}`);
    const route = `${req.method ?? 'GET'} ${url.pathname}`;
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, {
          ok: true,
          host: deps.host,
          port: deps.port,
          credential: { key: credentials.status().keyName, present: credentials.status().configured },
          versions: { contract: CONTRACT_VERSION, rules: RULES_VERSION, rulesDigest: rulesDigest(), disclosure: DISCLOSURE_VERSION },
          liveSessions: manager.listLive().length,
          dbVersion: store.dataPaths.dbFile === '' ? 0 : undefined,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/disclosure') {
        return json(res, 200, { disclosure: DISCLOSURE, acknowledged: !settings.needsDisclosure(), current: settings.get() });
      }
      if (req.method === 'GET' && url.pathname === '/api/model-config') {
        return json(res, 200, {
          ...credentials.status(),
          textModel: process.env.AI_INTERVIEWER_TEXT_MODEL?.trim() || DASHSCOPE_DEFAULTS.model,
          realtimeModel: process.env.AI_INTERVIEWER_REALTIME_MODEL?.trim() || REALTIME_DEFAULTS.model,
          voice: REALTIME_DEFAULTS.defaultVoice,
          configToken,
        });
      }
      if (req.method === 'PATCH' && url.pathname === '/api/model-config') {
        if (req.headers['x-config-token'] !== configToken) {
          throw new AppError('E_FORBIDDEN', '模型配置令牌无效或已过期', { hint: '刷新模型配置页后重试' });
        }
        const now = Date.now();
        configWrites = configWrites.filter((at) => now - at < 60_000);
        if (configWrites.length >= 5) throw new AppError('E_CONFLICT', '一分钟内配置次数过多', { hint: '稍后再试' });
        const body = await readJsonObject(req, 4096);
        const status = credentials.update(requireString(body, 'apiKey', { min: 20, max: 512 }));
        configWrites.push(now);
        configToken = randomUUID();
        logger.info('model_config.updated', { configured: status.configured, keyName: status.keyName });
        return json(res, 200, {
          ...status,
          textModel: process.env.AI_INTERVIEWER_TEXT_MODEL?.trim() || DASHSCOPE_DEFAULTS.model,
          realtimeModel: process.env.AI_INTERVIEWER_REALTIME_MODEL?.trim() || REALTIME_DEFAULTS.model,
          voice: REALTIME_DEFAULTS.defaultVoice,
          configToken,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/settings') {
        return json(res, 200, { settings: settings.get(), disclosureVersion: DISCLOSURE_VERSION, needsDisclosure: settings.needsDisclosure() });
      }
      if ((req.method === 'PATCH' || req.method === 'POST') && url.pathname === '/api/settings') {
        const body = await readJsonObject(req);
        const saveHistory = optionalBool(body, 'saveHistory');
        const saveAudio = optionalBool(body, 'saveAudio');
        const answerStartMode = optionalAnswerStartMode(body);
        const disclosureAck = optionalBool(body, 'disclosureAck');
        const updated = settings.update({
          ...(saveHistory === undefined ? {} : { saveHistory }),
          ...(saveAudio === undefined ? {} : { saveAudio }),
          ...(answerStartMode === undefined ? {} : { answerStartMode }),
          ...(disclosureAck === true ? { disclosureAckVersion: DISCLOSURE_VERSION } : {}),
        });
        logger.info('settings.updated', { saveHistory: updated.saveHistory, saveAudio: updated.saveAudio, answerStartMode: updated.answerStartMode, disclosureAck: updated.disclosureAckVersion });
        return json(res, 200, { settings: updated, needsDisclosure: settings.needsDisclosure() });
      }
      if (req.method === 'GET' && url.pathname === '/api/stats') {
        return json(res, 200, { stats: store.stats(), liveSessions: manager.listLive() });
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const limit = Number(url.searchParams.get('limit') ?? '20');
        const offset = Number(url.searchParams.get('offset') ?? '0');
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError('E_VALIDATION', 'limit 必须是 1–100 的整数');
        if (!Number.isInteger(offset) || offset < 0) throw new AppError('E_VALIDATION', 'offset 必须是非负整数');
        const includeSynthetic = url.searchParams.get('includeSynthetic') !== 'false';
        return json(res, 200, store.listSessions({ limit, offset, includeSynthetic }));
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const body = await readJsonObject(req);
        const synthetic = optionalBool(body, 'synthetic') ?? true;
        const saveHistory = optionalBool(body, 'saveHistory');
        const saveAudio = optionalBool(body, 'saveAudio');
        const ack = optionalBool(body, 'disclosureAck');
        if (ack === true) settings.update({ disclosureAckVersion: DISCLOSURE_VERSION });
        if (settings.needsDisclosure()) {
          throw new AppError('E_DISCLOSURE_REQUIRED', '首次使用前需要先确认告知内容', {
            hint: 'GET /api/disclosure 查看内容后，带 disclosureAck: true 再创建会话',
          });
        }
        const current = settings.get();
        // 与 SettingsStore 同一不变量：关历史就不可能存录音。请求体也不能写出矛盾组合。
        const wantHistory = saveHistory ?? current.saveHistory;
        const wantAudio = wantHistory ? (saveAudio ?? current.saveAudio) : false;
        const runner = manager.create({
          synthetic,
          saveHistory: wantHistory,
          saveAudio: wantAudio,
        });
        return json(res, 201, { sid: runner.sid, snapshot: runner.snapshot() });
      }

      const sidMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
      if (sidMatch) {
        const sid = decodeURIComponent(sidMatch[1]!);
        const rest = sidMatch[2] ?? '';
        if (req.method === 'GET' && rest === '') {
          return json(res, 200, manager.detail(sid));
        }
        if (req.method === 'GET' && rest === '/snapshot') {
          return json(res, 200, { snapshot: manager.requireLive(sid).snapshot() });
        }
        if (req.method === 'DELETE' && rest === '') {
          const report = manager.delete(sid);
          return json(res, 200, report);
        }
        const runner = () => manager.requireLive(sid);
        if (req.method === 'POST' && rest === '/materials') {
          const body = await readJsonObject(req);
          const stage = body.stage === '应届' || body.stage === '社招' ? body.stage : null;
          if (stage === null) throw new AppError('E_VALIDATION', 'stage 只能是「应届」或「社招」');
          const snapshot = await runner().confirmMaterials({
            jd: requireString(body, 'jd', { min: 10, max: 20_000 }),
            experience: requireString(body, 'experience', { min: 30, max: 40_000 }),
            stage,
            targetRole: typeof body.targetRole === 'string' ? body.targetRole : '',
          });
          return json(res, 200, { snapshot });
        }
        if (req.method === 'POST' && rest === '/materials/upload') {
          const filename = String(req.headers['x-filename'] ?? url.searchParams.get('filename') ?? 'upload.bin');
          const buffer = await readBody(req, 12 * 1024 * 1024);
          const r = runner();
          const parsed = parseMaterialFile({
            filename,
            buffer,
            contentType: String(req.headers['content-type'] ?? ''),
            tmpDir: deps.paths.uploadTmpDir,
            sessionId: r.sid,
          });
          if (!parsed.outcome.ok) {
            logger.warn('materials.parse_failed', { sid, filename, reason: parsed.outcome.reason, tmpRemoved: parsed.tmpRemoved });
            throw new AppError('E_PARSE_FAILED', parsed.outcome.message, { hint: parsed.outcome.hint, detail: `reason=${parsed.outcome.reason}` });
          }
          logger.info('materials.parsed', { sid, filename, kind: parsed.outcome.kind, chars: parsed.outcome.chars, extractor: parsed.outcome.extractor, tmpRemoved: parsed.tmpRemoved });
          return json(res, 200, {
            parsed: { kind: parsed.outcome.kind, chars: parsed.outcome.chars, extractor: parsed.outcome.extractor, note: parsed.outcome.note },
            text: parsed.outcome.text,
            tmp: { file: parsed.tmpFile === null ? null : path.basename(parsed.tmpFile), removed: parsed.tmpRemoved },
            next: '把 text 显示在可编辑框里，用户确认后再 POST /materials',
          });
        }
        if (req.method === 'POST' && rest === '/materials/retry-plan') {
          return json(res, 200, { snapshot: await runner().retryPlan() });
        }
        if (req.method === 'POST' && rest === '/answer/start') {
          return json(res, 200, { snapshot: await runner().answerStart() });
        }
        if (req.method === 'POST' && rest === '/answer/done') {
          return json(res, 200, { snapshot: await runner().answerDone() });
        }
        if (req.method === 'POST' && rest === '/answer/repeat-question') {
          return json(res, 200, { snapshot: await runner().repeatQuestion() });
        }
        if (req.method === 'POST' && rest === '/pause') {
          return json(res, 200, { snapshot: runner().pause() });
        }
        if (req.method === 'POST' && rest === '/resume') {
          return json(res, 200, { snapshot: runner().resume() });
        }
        if (req.method === 'POST' && rest === '/interrupt') {
          return json(res, 200, { interrupt: runner().interrupt(), snapshot: runner().snapshot() });
        }
        if (req.method === 'POST' && rest === '/mic-denied') {
          const body = await readJsonObject(req);
          return json(res, 200, { snapshot: runner().micDenied(typeof body.detail === 'string' ? body.detail : undefined) });
        }
        if (req.method === 'POST' && rest === '/review') {
          return json(res, 200, { snapshot: await runner().submitReview() });
        }
        if (req.method === 'POST' && rest === '/rewrite/start') {
          return json(res, 200, { snapshot: await runner().rewriteStart() });
        }
        if (req.method === 'POST' && rest === '/next') {
          return json(res, 200, { snapshot: await runner().nextQuestion() });
        }
        if (req.method === 'POST' && rest === '/end') {
          return json(res, 200, { snapshot: await runner().endSession() });
        }
        if (req.method === 'POST' && rest === '/report') {
          return json(res, 200, { snapshot: await runner().generateReport() });
        }
        const reviseMatch = rest.match(/^\/turns\/([^/]+)\/revise$/);
        if (req.method === 'POST' && reviseMatch) {
          const body = await readJsonObject(req);
          const text = requireString(body, 'text', { min: 1, max: 20_000 });
          return json(res, 200, { snapshot: await runner().reviseTurn(decodeURIComponent(reviseMatch[1]!), text) });
        }
        const audioMatch = rest.match(/^\/turns\/([^/]+)\/audio\/(user|interviewer)$/);
        if (req.method === 'GET' && audioMatch) {
          const audio = manager.readAudio(sid, decodeURIComponent(audioMatch[1]!), audioMatch[2] as 'user' | 'interviewer');
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(audio.wav.length), 'X-Audio-Source': audio.source, 'Cache-Control': 'no-store' });
          res.end(audio.wav);
          return;
        }
      }

      if (req.method === 'GET' && (url.pathname === '/harness' || url.pathname === '/harness.html')) {
        if (!existsSync(HARNESS_FILE)) throw new AppError('E_NOT_FOUND', '验收用最小客户端不存在');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(readFileSync(HARNESS_FILE));
        return;
      }
      if (req.method === 'GET' && url.pathname !== '/api' && !url.pathname.startsWith('/api/') && serveStatic(deps.staticDir, url.pathname, res)) return;
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return json(res, 200, {
          service: 'ai-interviewer-web',
          note: '方案 C 已选定但正式产品前端尚未构建；本包交付服务端与数据层，并提供同源静态托管，验收用最小客户端在 /harness',
          docs: ['GET /api/health', 'GET /api/disclosure', 'GET /api/sessions'],
        });
      }
      throw new AppError('E_NOT_FOUND', `没有这个路由：${route}`);
    } catch (e) {
      const err = asAppError(e, `处理 ${route} 失败`);
      if (err.code === 'E_INTERNAL' || err.httpStatus >= 500) {
        logger.error('http.error', { route, code: err.code, message: err.message, detail: err.detail });
      } else {
        logger.warn('http.rejected', { route, code: err.code, message: err.message });
      }
      if (!res.headersSent) errorJson(res, err);
      else res.end();
    }
  }

  // ---------- WebSocket：浏览器音频与阶段事件 ----------

  const wss = new WebSocketServer({ server, path: '/realtime' });
  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const url = new URL(req.url ?? '/', `http://${deps.host}:${deps.port}`);
    const sid = url.searchParams.get('sid') ?? '';
    const runner = manager.get(sid);
    const send = (msg: Record<string, unknown>): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    if (!runner) {
      send({ type: 'error', error: { code: 'E_NOT_FOUND', message: `会话不存在或已归档：${sid}` } });
      ws.close();
      return;
    }
    runner.setAudioSink((chunk, seq) => send({ type: 'interviewer.audio', seq, sampleRate: 24_000, format: 'pcm16', audio: chunk.toString('base64') }));
    runner.setTranscriptSink((partial, final) => send({ type: final ? 'transcript.final' : 'transcript.partial', text: partial }));
    send({ type: 'state', snapshot: runner.snapshot() });
    logger.info('ws.connected', { sid });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        send({ type: 'error', error: { code: 'E_BAD_REQUEST', message: '音频请用 JSON 的 audio.append（base64 PCM16@16k）发送' } });
        return;
      }
      let msg: { type?: string; audio?: string; detail?: string };
      try {
        msg = JSON.parse(data.toString()) as typeof msg;
      } catch {
        send({ type: 'error', error: { code: 'E_BAD_REQUEST', message: '不是合法 JSON' } });
        return;
      }
      void (async () => {
        try {
          switch (msg.type) {
            case 'ping':
              send({ type: 'pong', at: Date.now() });
              return;
            case 'answer.start':
              send({ type: 'state', snapshot: await runner.answerStart() });
              return;
            case 'audio.append': {
              const pcm = Buffer.from(String(msg.audio ?? ''), 'base64');
              if (pcm.length === 0) throw new AppError('E_VALIDATION', 'audio.append 的 audio 为空');
              const snapshot = runner.appendAudio(pcm);
              send({ type: 'audio.ack', bytes: pcm.length, state: snapshot.state });
              return;
            }
            case 'answer.commit':
              send({ type: 'state', snapshot: await runner.answerDone() });
              return;
            case 'repeat.question':
              send({ type: 'state', snapshot: await runner.repeatQuestion() });
              return;
            case 'pause':
              send({ type: 'paused', snapshot: runner.pause() });
              return;
            case 'resume':
              send({ type: 'resumed', snapshot: runner.resume() });
              return;
            case 'interrupt': {
              const r = runner.interrupt();
              send({ type: 'interrupted', ...r });
              return;
            }
            case 'mic.denied':
              send({ type: 'state', snapshot: runner.micDenied(msg.detail) });
              return;
            default:
              throw new AppError('E_BAD_REQUEST', `未知消息类型：${String(msg.type)}`);
          }
        } catch (e) {
          const err = asAppError(e, `WS 处理 ${String(msg.type)} 失败`);
          send({ type: 'error', error: { code: err.code, message: err.message, ...(err.hint === undefined ? {} : { hint: err.hint }) } });
        }
      })();
    });
    ws.on('close', () => {
      runner.setAudioSink(null);
      runner.setTranscriptSink(null);
      logger.info('ws.closed', { sid });
    });
  });

  return {
    server,
    url: `http://${deps.host}:${deps.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

/** 校验一份 Feedback 是否仍然过契约（历史回放前用；不过就明确报错，不展示坏数据）。 */
export function assertFeedbackValid(feedback: unknown): void {
  const check = validateContract('feedback', feedback);
  if (!check.ok) throw new AppError('E_CONFLICT', '该轮反馈未通过契约校验，拒绝展示', { detail: check.errors.join('; ').slice(0, 200) });
}
