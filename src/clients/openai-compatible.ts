/** Server-only OpenAI-compatible text API. No provider response body reaches clients/logs. */
import type { CompletionRequest, CompletionResponse, TextLlmClient } from './types.js';

export interface OpenAiConfig {
  apiKey: string; baseUrl: string; textModel: string; speechModel: string; transcriptionModel: string; voice: string;
}
export const OPENAI_DEFAULTS = { baseUrl: 'https://api.openai.com/v1', textModel: 'gpt-4.1-mini', speechModel: 'gpt-4o-mini-tts', transcriptionModel: 'gpt-transcribe', voice: 'coral' };
export function openAiConfig(env: NodeJS.ProcessEnv = process.env): OpenAiConfig | null {
  if (env.AI_INTERVIEWER_FREE_ENABLED !== 'on' || !env.OPENAI_API_KEY?.trim()) return null;
  const baseUrl = (env.OPENAI_BASE_URL?.trim() || OPENAI_DEFAULTS.baseUrl).replace(/\/+$/, '');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('OPENAI_BASE_URL 必须是无凭证、无查询参数的 HTTPS 地址');
  return { apiKey: env.OPENAI_API_KEY.trim(), baseUrl,
    textModel: env.OPENAI_TEXT_MODEL?.trim() || OPENAI_DEFAULTS.textModel,
    speechModel: env.OPENAI_SPEECH_MODEL?.trim() || OPENAI_DEFAULTS.speechModel,
    transcriptionModel: env.OPENAI_TRANSCRIPTION_MODEL?.trim() || OPENAI_DEFAULTS.transcriptionModel,
    voice: env.OPENAI_VOICE?.trim() || OPENAI_DEFAULTS.voice };
}
export type CallGuard = () => () => void;
export async function openAiRequest(config: OpenAiConfig, endpoint: string, body: string | FormData, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}${endpoint}`, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${config.apiKey}`, ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}) }, body, signal });
  } catch {
    throw new Error(signal.aborted ? '免费模型调用超时或已取消' : '免费模型网络不可达');
  }
  if (!res.ok) {
    // Discard upstream bodies: they can echo Authorization or arbitrary input.
    await res.body?.cancel();
    throw new Error(res.status === 429 ? '免费模型额度不足或请求繁忙（HTTP 429）' : `免费模型服务暂不可用（HTTP ${res.status}）`);
  }
  return res;
}
/** Enforce response size locally; upstream token settings are not a memory bound. */
export async function readOpenAiJson(res: Response, maxBytes: number): Promise<unknown> {
  const error = () => new Error('免费模型响应超过大小上限或格式无效');
  if (!res.body) throw error();
  if (Number(res.headers.get('content-length')) > maxBytes) { await res.body.cancel(); throw error(); }
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw error();
      chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw error(); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class OpenAiTextClient implements TextLlmClient {
  readonly name = 'openai-compatible';
  constructor(private readonly config: OpenAiConfig, private readonly guard: CallGuard = () => () => {}) {}
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (req.prompt.length > 100_000) throw new Error('面试材料与回答过长，请精简后重试');
    const release = this.guard();
    const started = Date.now();
    try {
      const res = await openAiRequest(this.config, '/chat/completions', JSON.stringify({
        model: this.config.textModel, messages: [{ role: 'user', content: req.prompt }],
        temperature: req.temperature ?? 0.2, max_tokens: Math.min(req.maxTokens ?? 4096, 8192),
        ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }), AbortSignal.timeout(Math.min(req.timeoutMs ?? 120_000, 120_000)));
      let data: { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
      data = await readOpenAiJson(res, 512 * 1024) as typeof data;
      const text = data?.choices?.[0]?.message?.content;
      if (!text || typeof text !== 'string' || text.length > 64_000) throw new Error('免费模型未返回有效文本');
      if (text.includes(this.config.apiKey)) throw new Error('免费模型返回内容被安全检查拒绝');
      return { text, model: this.config.textModel, httpStatus: res.status, latencyMs: Date.now() - started,
        usage: { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens, totalTokens: data.usage?.total_tokens } };
    } finally { release(); }
  }
}
