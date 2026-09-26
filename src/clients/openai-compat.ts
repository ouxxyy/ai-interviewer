/**
 * OpenAI 兼容接口适配器（高级设置：用户自配地址／模型／密钥）。
 * T1-S 状态：静态通过；真实调用未验证。
 * D10：自定义配置下界面须标注「评审一致性未经验证」。
 */
import type { CompletionRequest, CompletionResponse, TextLlmClient, TextModelConfig } from './types.js';
import { readCredential } from './types.js';

export interface OpenAiCompatOptions {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
}

export class OpenAiCompatClient implements TextLlmClient {
  readonly name = 'openai-compat';
  private readonly config: TextModelConfig;

  constructor(opts: OpenAiCompatOptions) {
    if (!opts.baseUrl || !opts.model) throw new Error('OpenAI 兼容配置需要 baseUrl 与 model');
    this.config = {
      baseUrl: opts.baseUrl.replace(/\/$/, ''),
      model: opts.model,
      apiKeyEnv: opts.apiKeyEnv ?? 'OPENAI_COMPAT_API_KEY',
      timeoutMs: opts.timeoutMs ?? 60_000,
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const apiKey = readCredential(this.config.apiKeyEnv);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: req.prompt }],
          temperature: req.temperature ?? 0.2,
          max_tokens: req.maxTokens ?? 4096,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`自定义端点 HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: object };
      const text = data.choices?.[0]?.message?.content ?? '';
      if (!text) throw new Error('自定义端点返回空内容');
      return { text, usage: data.usage as CompletionResponse['usage'] };
    } finally {
      clearTimeout(timer);
    }
  }
}
