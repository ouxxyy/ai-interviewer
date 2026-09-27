/**
 * 隐私开关的纯策略层（P0-2）。
 *
 * 不变量：**录音依附于会话记录**——关掉「保存历史」时录音必须一起关。
 * 这条不变量的单源在服务端 `src/web/settings.ts`，前端这里只是同一口径的镜像，
 * 用来保证界面状态、写回服务端的补丁、以及建会话请求体三者不会互相漂移。
 */
import type { WebSettings } from '../types.js';

export interface Toggles {
  saveHistory: boolean;
  saveAudio: boolean;
}

/** 关掉历史就不可能有录音（没有可归属的会话记录）。 */
export function effectiveSaveAudio(saveHistory: boolean, saveAudio: boolean): boolean {
  return saveHistory ? saveAudio : false;
}

/** 由当前设置算出「本场新建会话」应使用的开关。 */
export function sessionToggles(settings: Pick<WebSettings, 'saveHistory' | 'saveAudio'>): Toggles {
  return {
    saveHistory: settings.saveHistory,
    saveAudio: effectiveSaveAudio(settings.saveHistory, settings.saveAudio),
  };
}

/** `POST /api/sessions` 的请求体：显式带上开关，避免落到服务端旧默认值。 */
export function sessionCreateBody(settings: Pick<WebSettings, 'saveHistory' | 'saveAudio'>): { synthetic: false } & Toggles {
  return { synthetic: false, ...sessionToggles(settings) };
}

/** 单开关变更对应的服务端补丁：关历史必须连带关录音。 */
export function togglePatch(current: Pick<WebSettings, 'saveHistory' | 'saveAudio'>, key: keyof Toggles, value: boolean): Partial<Toggles> {
  if (key === 'saveHistory') return value ? { saveHistory: true } : { saveHistory: false, saveAudio: false };
  return { saveAudio: effectiveSaveAudio(current.saveHistory, value) };
}

/** 两个开关是否等价（用于判断草稿会话的开关是否已经过期）。 */
export function togglesEqual(a: Toggles, b: Toggles): boolean {
  return a.saveHistory === b.saveHistory && a.saveAudio === b.saveAudio;
}
