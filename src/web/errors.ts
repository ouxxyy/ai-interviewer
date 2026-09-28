/**
 * 统一错误响应（网页入口对外接口契约）。
 *
 * - 每个错误有稳定 `code`（前端据此切状态，不靠 message 字符串匹配）；
 * - `hint` 是给用户看的下一步动作（例如「请直接粘贴经历文本」）；
 * - `httpStatus` 只做传输层映射，业务状态以 `code` 为准。
 *
 * 上游（百炼）错误分类集中在这里：1310／bigmodel 立刻停，不重试（Mika 的止损要求）。
 */
export type ErrorCode =
  | 'E_BAD_REQUEST'
  | 'E_VALIDATION'
  | 'E_FORBIDDEN'
  | 'E_NOT_FOUND'
  | 'E_CONFLICT'
  | 'E_STATE'
  | 'E_DISCLOSURE_REQUIRED'
  | 'E_MATERIALS_UNCONFIRMED'
  | 'E_PARSE_FAILED'
  | 'E_PLAN_FAILED'
  | 'E_REALTIME'
  | 'E_REALTIME_TIMEOUT'
  | 'E_EMPTY_TRANSCRIPT'
  | 'E_MIC_DENIED'
  | 'E_UPLINK_PAUSED'
  | 'E_MODEL_TIMEOUT'
  | 'E_QUOTA'
  | 'E_OFFLINE'
  | 'E_UPSTREAM'
  | 'E_REPORT_FAILED'
  | 'E_INTERNAL';

const HTTP: Record<ErrorCode, number> = {
  E_BAD_REQUEST: 400,
  E_VALIDATION: 400,
  E_FORBIDDEN: 403,
  E_NOT_FOUND: 404,
  E_CONFLICT: 409,
  E_STATE: 409,
  E_DISCLOSURE_REQUIRED: 428,
  E_MATERIALS_UNCONFIRMED: 409,
  E_PARSE_FAILED: 422,
  E_PLAN_FAILED: 502,
  E_REALTIME: 502,
  E_REALTIME_TIMEOUT: 504,
  E_EMPTY_TRANSCRIPT: 422,
  E_MIC_DENIED: 403,
  E_UPLINK_PAUSED: 409,
  E_MODEL_TIMEOUT: 504,
  E_QUOTA: 429,
  E_OFFLINE: 503,
  E_UPSTREAM: 502,
  E_REPORT_FAILED: 502,
  E_INTERNAL: 500,
};

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    hint?: string;
    detail?: string;
    /** true＝本次会话已按止损停下，不要重试（1310／bigmodel 等情况）。 */
    halt?: boolean;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly detail: string | undefined;
  readonly halt: boolean;
  constructor(code: ErrorCode, message: string, opts: { hint?: string; detail?: string; halt?: boolean } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.hint = opts.hint;
    this.detail = opts.detail;
    this.halt = opts.halt ?? false;
  }

  get httpStatus(): number {
    return HTTP[this.code];
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint === undefined ? {} : { hint: this.hint }),
        ...(this.detail === undefined ? {} : { detail: this.detail }),
        ...(this.halt ? { halt: true } : {}),
      },
    };
  }
}

/** 上游文本／实时模型错误的分类。命中 1310／bigmodel 一律 `halt`（停，不重试）。 */
export function classifyUpstreamError(e: unknown, context: string): AppError {
  const message = e instanceof Error ? e.message : String(e);
  const detail = message.slice(0, 300);
  if (/1310|bigmodel|usage limit|配额|额度不足|Arrearage|欠费|Quota/i.test(message)) {
    return new AppError('E_QUOTA', `${context}：上游额度不足`, {
      hint: '按止损要求本次不再重试；请到百炼控制台确认配额或稍后再试',
      detail,
      halt: true,
    });
  }
  if (/timeout|超时|aborted|abort|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(message)) {
    return new AppError('E_MODEL_TIMEOUT', `${context}：调用超时`, { hint: '可以重试本次操作；已完成的轮次不会丢失', detail });
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|network|socket hang up|离线/i.test(message)) {
    return new AppError('E_OFFLINE', `${context}：网络不可达`, { hint: '检查网络与代理设置（国内端点不要走全局代理）；恢复后可重试', detail });
  }
  return new AppError('E_UPSTREAM', `${context}：上游调用失败`, { hint: '可以重试；若反复失败请查看本地日志', detail });
}

/** 任何异常 → AppError（未知异常按 500，不泄露堆栈到响应体）。 */
export function asAppError(e: unknown, context = '请求处理失败'): AppError {
  if (e instanceof AppError) return e;
  return classifyUpstreamError(e, context);
}
