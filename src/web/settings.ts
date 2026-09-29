/**
 * 本机设置与首次使用告知（MYW-85「保存与隐私」）。
 *
 * 两个**互相独立**的开关（PM §5）：
 * - `saveHistory`：关掉后**不产生新的持久记录**（会话、轮次、反馈、报告都不入库）；
 * - `saveAudio`：关掉后**不产生新的音频文件**；
 * - `answerStartMode`：默认 continuous（第一题手动，后续小八说完自动开麦）；manual 为每轮手动开始；
 * - 关闭历史时不保存录音——录音依附于会话记录，没有记录就没有可归属的录音。
 * 关开关**不删除旧记录**：老会话要用户显式删除（见 store.deleteSession）。
 *
 * 告知文案与版本冻结在 `DISCLOSURE`，`disclosureAckVersion` 记录用户确认到哪一版；
 * 文案升版后旧确认失效，服务会再次要求确认（`needsDisclosure()`）。
 */
import { DISCLOSURE_VERSION } from './disclosure.js';
import type { InterviewDb } from './db.js';

export { DISCLOSURE, DISCLOSURE_VERSION } from './disclosure.js';

export type AnswerStartMode = 'continuous' | 'manual';

export interface WebSettings {
  saveHistory: boolean;
  saveAudio: boolean;
  answerStartMode: AnswerStartMode;
  disclosureAckVersion: string | null;
  disclosureAckAt: string | null;
  updatedAt: string | null;
}

const KEYS = {
  saveHistory: 'save_history',
  saveAudio: 'save_audio',
  answerStartMode: 'answer_start_mode',
  disclosureAckVersion: 'disclosure_ack_version',
  disclosureAckAt: 'disclosure_ack_at',
  updatedAt: 'settings_updated_at',
} as const;

/** 默认值（用户已决定默认开启自动保存历史与录音，PM §5）。 */
export const DEFAULT_SETTINGS: WebSettings = {
  saveHistory: true,
  saveAudio: true,
  answerStartMode: 'continuous',
  disclosureAckVersion: null,
  disclosureAckAt: null,
  updatedAt: null,
};

export class SettingsStore {
  constructor(private readonly db: InterviewDb, private readonly disclosureVersion = DISCLOSURE_VERSION) {}

  get(): WebSettings {
    const rows = this.db.raw.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const bool = (key: string, fallback: boolean): boolean => {
      const v = map.get(key);
      return v === undefined ? fallback : v === '1';
    };
    const answerStartMode = map.get(KEYS.answerStartMode);
    return {
      saveHistory: bool(KEYS.saveHistory, DEFAULT_SETTINGS.saveHistory),
      saveAudio: bool(KEYS.saveAudio, DEFAULT_SETTINGS.saveAudio),
      answerStartMode: answerStartMode === 'manual' || answerStartMode === 'continuous' ? answerStartMode : DEFAULT_SETTINGS.answerStartMode,
      disclosureAckVersion: map.get(KEYS.disclosureAckVersion) ?? null,
      disclosureAckAt: map.get(KEYS.disclosureAckAt) ?? null,
      updatedAt: map.get(KEYS.updatedAt) ?? null,
    };
  }

  /** 局部更新；`null` 表示显式清除（用于撤销告知确认）。 */
  update(patch: { saveHistory?: boolean; saveAudio?: boolean; answerStartMode?: AnswerStartMode; disclosureAckVersion?: string | null }): WebSettings {
    const now = new Date().toISOString();
    const put = (key: string, value: string): void => {
      this.db.raw
        .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run(key, value, now);
    };
    if (patch.saveHistory !== undefined || patch.saveAudio !== undefined) {
      // 不变量（PM §5）：录音依附于会话记录，关掉历史就不可能有录音。
      // 在写入口收敛，任何调用方都无法把这两项写成互相矛盾的值。
      const saveHistory = patch.saveHistory ?? this.get().saveHistory;
      const saveAudio = saveHistory ? (patch.saveAudio ?? this.get().saveAudio) : false;
      put(KEYS.saveHistory, saveHistory ? '1' : '0');
      put(KEYS.saveAudio, saveAudio ? '1' : '0');
    }
    if (patch.answerStartMode !== undefined) put(KEYS.answerStartMode, patch.answerStartMode);
    if (patch.disclosureAckVersion !== undefined) {
      if (patch.disclosureAckVersion === null) {
        this.db.raw.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(KEYS.disclosureAckVersion, KEYS.disclosureAckAt);
      } else {
        put(KEYS.disclosureAckVersion, patch.disclosureAckVersion);
        put(KEYS.disclosureAckAt, now);
      }
    }
    put(KEYS.updatedAt, now);
    return this.get();
  }

  /** 告知是否已按**当前版本**确认过；未确认时界面与服务都应先要求确认。 */
  needsDisclosure(): boolean {
    return this.get().disclosureAckVersion !== this.disclosureVersion;
  }
}
