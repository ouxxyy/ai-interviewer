import { language, t, type InterviewLanguage } from './lib/i18n.js';
import type { AppErrorBody, Disclosure, ModelConfigStatus, SessionDetail, SessionListItem, Snapshot, WebSettings } from './types';

export class ApiError extends Error {
  readonly body: AppErrorBody;

  constructor(body: AppErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.body = body;
  }
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'Accept-Language': language(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError({ code: 'E_OFFLINE', message: t('网络连接中断'), hint: t('检查本地服务和网络后重新连接') });
  }
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text === '' ? null : JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const fallback: AppErrorBody = { code: `E_HTTP_${response.status}`, message: t("请求失败（{0}）", response.status) };
    const error = payload !== null && typeof payload === 'object' && 'error' in payload
      ? (payload as { error: AppErrorBody }).error
      : fallback;
    throw new ApiError(error);
  }
  return payload as T;
}

export const api = {
  bootstrap: () => request<{ mode: { public: boolean; keyConfigured: boolean } }>('GET', '/api/bootstrap'),
  settings: () => request<{ settings: WebSettings; disclosureVersion: string; needsDisclosure: boolean }>('GET', '/api/settings'),
  disclosure: () => request<{ disclosure: Disclosure; acknowledged: boolean; current: WebSettings }>('GET', '/api/disclosure'),
  acknowledgeDisclosure: () => request<{ settings: WebSettings; needsDisclosure: boolean }>('PATCH', '/api/settings', { disclosureAck: true }),
  updateSettings: (patch: Partial<Pick<WebSettings, 'saveHistory' | 'saveAudio' | 'answerStartMode'>>) => request<{ settings: WebSettings; needsDisclosure: boolean }>('PATCH', '/api/settings', patch),
  createSession: (body: { language: InterviewLanguage; synthetic: false; saveHistory: boolean; saveAudio: boolean; disclosureAck: true }) => request<{ sid: string; snapshot: Snapshot }>('POST', '/api/sessions', body),
  modelConfig: () => request<ModelConfigStatus>('GET', '/api/model-config'),
  async updateModelConfig(apiKey: string, configToken: string): Promise<ModelConfigStatus> {
    let response: Response;
    try {
      response = await fetch('/api/model-config', {
        method: 'PATCH',
        headers: { 'Accept-Language': language(), 'Content-Type': 'application/json', 'X-Config-Token': configToken },
        body: JSON.stringify({ apiKey }),
      });
    } catch {
      throw new ApiError({ code: 'E_OFFLINE', message: t('本地服务未连接'), hint: t('请先启动 npm run web:serve') });
    }
    const payload = await response.json() as ModelConfigStatus | { error: AppErrorBody };
    if (!response.ok || 'error' in payload) throw new ApiError('error' in payload ? payload.error : { code: `E_HTTP_${response.status}`, message: t('模型配置保存失败') });
    return payload;
  },
  detail: (sid: string) => request<SessionDetail>('GET', `/api/sessions/${encodeURIComponent(sid)}`),
  snapshot: (sid: string) => request<{ snapshot: Snapshot }>('GET', `/api/sessions/${encodeURIComponent(sid)}/snapshot`),
  action: (sid: string, action: string, body?: unknown) => request<{ snapshot: Snapshot }>('POST', `/api/sessions/${encodeURIComponent(sid)}/${action}`, body),
  listSessions: (limit = 50, offset = 0) => request<{ items: SessionListItem[]; total: number; limit: number; offset: number }>('GET', `/api/sessions?includeSynthetic=false&limit=${limit}&offset=${offset}`),
  deleteSession: (sid: string) => request<{ verified: boolean; removed: { sessions: number; turns: number; audioFiles: string[] } }>('DELETE', `/api/sessions/${encodeURIComponent(sid)}`),
  async uploadMaterial(sid: string, file: File): Promise<{ text: string; parsed: { kind: string; chars: number; extractor: string; note?: string } }> {
    let response: Response;
    try {
      response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/materials/upload?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Accept-Language': language(), 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': file.name },
        body: await file.arrayBuffer(),
      });
    } catch {
      throw new ApiError({ code: 'E_OFFLINE', message: t('网络连接中断'), hint: t('恢复后重新读取文件') });
    }
    const payload = await response.json() as { text?: string; parsed?: { kind: string; chars: number; extractor: string; note?: string }; error?: AppErrorBody };
    if (!response.ok || payload.text === undefined || payload.parsed === undefined) {
      throw new ApiError(payload.error ?? { code: 'E_PARSE_FAILED', message: t('文件没有读出来'), hint: t('改为粘贴文本') });
    }
    return { text: payload.text, parsed: payload.parsed };
  },
};
