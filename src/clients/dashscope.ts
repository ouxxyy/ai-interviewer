/**
 * 阿里百炼（DashScope）OpenAI 兼容模式适配器。
 *
 * 状态（2026-09-26 T1-R 实测）：**真实调用已验证**——模型 `qwen3.8-flash`、地域
 * `cn-beijing`（dashscope.aliyuncs.com）。凭证只从环境变量／`.env` 注入，不进日志与错误信息。
 *
 * 注意（PM §4 T0 节）：百炼为国内端点。本机若开 Clash 全局代理会拦截国内 API，
 * 真实调用时须确保 `NO_PROXY` 含 `dashscope.aliyuncs.com`（见 `.env.example`）。
 */
import type { CompletionRequest, CompletionResponse, TextLlmClient, TextModelConfig } from './types.js';
import { readCredential } from './types.js';

export interface DashscopeOptions {
  credential?: () => string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export const DASHSCOPE_DEFAULTS: Required<Pick<DashscopeOptions, 'model' | 'baseUrl' | 'timeoutMs'>> = {
  // T1-R 核定：账号下可用模型 261 个，文本默认取 qwen3.8-flash（实测 HTTP 200）。
  model: 'qwen3.8-flash',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  timeoutMs: 120_000,
};

interface ChatCompletionPayload {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
  id?: string;
}

export class DashscopeTextClient implements TextLlmClient {
  readonly name = 'dashscope';
  private readonly config: TextModelConfig;

  constructor(private readonly opts: DashscopeOptions = {}) {
    this.config = {
      baseUrl: opts.baseUrl ?? DASHSCOPE_DEFAULTS.baseUrl,
      model: opts.model ?? DASHSCOPE_DEFAULTS.model,
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      timeoutMs: opts.timeoutMs ?? DASHSCOPE_DEFAULTS.timeoutMs,
    };
  }

  get model(): string {
    return this.config.model;
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /**
   * 多轮对话补全（T3 简版 Prompt 入口用）。
   * 「把 Prompt 粘贴进普通聊天对话」在 API 层就是一次带历史的多轮 messages 调用——
   * 用它来实测「自包含、不依赖仓库」这条。
   */
  async completeChat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, req: Omit<CompletionRequest, 'prompt'> = {}): Promise<CompletionResponse> {
    return this.call({ ...req, prompt: '' }, messages);
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    return this.call(req, null);
  }

  private async call(req: CompletionRequest, messages: Array<{ role: string; content: string }> | null): Promise<CompletionResponse> {
    const apiKey = this.opts.credential ? this.opts.credential() : readCredential(this.config.apiKeyEnv);
    if (!apiKey) throw new Error('请先配置百炼 API Key');
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? this.config.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages: messages ?? [{ role: 'user', content: req.prompt }],
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? 4096,
      };
      if (req.jsonMode) body.response_format = { type: 'json_object' };
      if (req.enableThinking !== undefined) body.enable_thinking = req.enableThinking;
      const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        // 错误体可能很长，截断且不含凭证；状态码与 request id 是排障关键。
        const text = await res.text().catch(() => '');
        throw new Error(`DashScope HTTP ${res.status}（model=${this.config.model}）：${text.split(apiKey).join('<redacted>').slice(0, 300)}`);
      }
      const data = (await res.json()) as ChatCompletionPayload;
      const text = data.choices?.[0]?.message?.content ?? '';
      if (text === '') throw new Error(`DashScope 返回空内容（model=${this.config.model}）`);
      return {
        text,
        usage: {
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens,
        },
        latencyMs,
        httpStatus: res.status,
        requestId: res.headers.get('x-request-id'),
        model: data.model ?? this.config.model,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
