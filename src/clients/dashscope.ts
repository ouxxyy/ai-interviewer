/**
 * 阿里百炼（DashScope OpenAI 兼容模式）适配器骨架。
 * T1-S 状态：静态通过（接口与凭证注入点就绪）；真实调用未验证（无凭证，属 T1-R）。
 *
 * 注意（PM §4 T0 节）：百炼为国内端点。本机 Clash 全局代理会拦截国内 API，
 * 真实调用时须确保 NO_PROXY 含 dashscope.aliyuncs.com（见 .env.example）。
 */
import type { CompletionRequest, CompletionResponse, TextLlmClient, TextModelConfig } from './types.js';
import { readCredential } from './types.js';

export interface DashscopeOptions {
  model?: string;
  baseUrl?: string;
}

export const DASHSCOPE_DEFAULTS: Required<Pick<DashscopeOptions, 'model' | 'baseUrl'>> = {
  // 模型 ID 与地域在 T1-R 接入时按阿里官方实时文档核定后固定到验收记录，当前值仅为占位，未验证。
  model: 'qwen-plus-TBD-at-t1r',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

export class DashscopeTextClient implements TextLlmClient {
  readonly name = 'dashscope';
  private readonly config: TextModelConfig;

  constructor(opts: DashscopeOptions = {}) {
    this.config = {
      baseUrl: opts.baseUrl ?? DASHSCOPE_DEFAULTS.baseUrl,
      model: opts.model ?? DASHSCOPE_DEFAULTS.model,
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      timeoutMs: 60_000,
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
        throw new Error(`DashScope HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: object };
      const text = data.choices?.[0]?.message?.content ?? '';
      if (!text) throw new Error('DashScope 返回空内容');
      return { text, usage: data.usage as CompletionResponse['usage'] };
    } finally {
      clearTimeout(timer);
    }
  }
}
