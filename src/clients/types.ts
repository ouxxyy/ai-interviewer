/**
 * 模型客户端抽象（T1-S：接口与注入点就绪；真实连通性属 T1-R，未验证）。
 * D2：实时语音模型只管听说；流程判断全部在文本层与应用状态机。
 */

export interface TextModelConfig {
  /** OpenAI 兼容 base URL，如 https://dashscope.aliyuncs.com/compatible-mode/v1 */
  baseUrl: string;
  model: string;
  /** 凭证从环境变量注入，不落盘、不进日志。 */
  apiKeyEnv: string;
  timeoutMs: number;
}

export interface CompletionRequest {
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  /** 要求返回严格 JSON 对象（OpenAI 兼容 `response_format: json_object`）。 */
  jsonMode?: boolean;
  /** 单次调用超时覆盖。 */
  timeoutMs?: number;
  /** 关闭/开启思维链（百炼 `enable_thinking`）。结构化评审默认关闭，降低延迟与 token 抖动。 */
  enableThinking?: boolean;
}

export interface CompletionResponse {
  text: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  /** T1-R 新增：真实调用的可观测字段（延迟／HTTP 状态／服务端 request id），供验收记录留证。 */
  latencyMs?: number;
  httpStatus?: number;
  requestId?: string | null;
  /** 请求的模型 ID（可能被服务端回写为具体快照版本）。 */
  model?: string;
}

/** 文本模型客户端（问题计划／追问判定／评审／报告共用）。 */
export interface TextLlmClient {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

/** 实时语音客户端（链 B）。T1-S 仅定义接口形态；真实实现与验证属 T1-R。 */
export interface RealtimeVoiceClient {
  readonly name: string;
  connect(sessionId: string): Promise<void>;
  /** D2：应用层注入要朗读的文本，语音层不得自行生成问题。 */
  injectText(text: string): void;
  onTranscript(cb: (partial: string, final: boolean) => void): void;
  onInterviewerAudio(cb: (chunk: Buffer, seq: number) => void): void;
  close(): void;
}

export class MissingCredentialError extends Error {
  constructor(readonly envVar: string) {
    super(`缺少凭证：请设置环境变量 ${envVar}（不要写入代码或仓库）`);
  }
}

/** 凭证注入点：运行时从环境变量读取，绝不接受字面量密钥参数。 */
export function readCredential(envVar: string): string {
  const v = process.env[envVar];
  if (!v || v.trim() === '') throw new MissingCredentialError(envVar);
  return v.trim();
}
