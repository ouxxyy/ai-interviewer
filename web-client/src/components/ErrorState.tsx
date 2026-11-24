import { language, t } from '../lib/i18n.js';
import { ArrowClockwise, ArrowLeft, FileText, Gear, MicrophoneSlash, SpeakerHigh, StopCircle, WifiSlash } from '@phosphor-icons/react';
import type { AppErrorBody, ErrorCode } from '../types';

type ErrorAction = 'retry' | 'repeat' | 'permission' | 'end' | 'reconnect' | 'paste' | 'settings' | 'home';

interface ErrorSpec {
  title: string;
  fallbackHint: string;
  icon: React.ComponentType<{ size?: number; weight?: 'bold' | 'fill'; 'aria-hidden'?: boolean }>;
  actions: Array<{ id: ErrorAction; label: string; primary?: boolean }>;
}

const ERROR_SPECS: Partial<Record<ErrorCode, ErrorSpec>> = {
  E_EMPTY_TRANSCRIPT: {
    title: '这次没有听清',
    fallbackHint: '保留在当前回答，你可以再答一次或重听本题。',
    icon: SpeakerHigh,
    actions: [{ id: 'retry', label: '再答一次', primary: true }, { id: 'repeat', label: '重听本题' }],
  },
  E_MIC_DENIED: {
    title: '麦克风没有开始采集',
    fallbackHint: '允许浏览器使用麦克风后，可以继续当前题。',
    icon: MicrophoneSlash,
    actions: [{ id: 'permission', label: '检查权限', primary: true }, { id: 'end', label: '结束本场' }],
  },
  E_OFFLINE: {
    title: '网络连接中断',
    fallbackHint: '当前内容已保留，恢复后重新连接，不会重复新建会话。',
    icon: WifiSlash,
    actions: [{ id: 'reconnect', label: '重新连接', primary: true }],
  },
  E_MODEL_TIMEOUT: {
    title: '这次处理超时',
    fallbackHint: '已提交的回答不会丢失，可以再试一次。',
    icon: ArrowClockwise,
    actions: [{ id: 'retry', label: '再试一次', primary: true }],
  },
  E_PARSE_FAILED: {
    title: '文件没有读出来',
    fallbackHint: '已填内容不会清空，可以改为粘贴文本。',
    icon: FileText,
    actions: [{ id: 'paste', label: '改为粘贴', primary: true }],
  },
  E_CONFLICT: {
    title: '这场练习不能继续作答',
    fallbackHint: '历史记录只能查看或删除，新建一场就可以继续练。',
    icon: Gear,
    actions: [{ id: 'home', label: '返回首页', primary: true }],
  },
  E_QUOTA: {
    title: '本场已暂停，当前额度不足',
    fallbackHint: '本场不再自动重试。你可以查看设置或返回首页。',
    icon: StopCircle,
    actions: [{ id: 'settings', label: '查看设置' }, { id: 'home', label: '返回首页' }],
  },
};

const englishErrorTitles: Record<string, string> = {
  E_BAD_REQUEST: 'The request could not be processed',
  E_VALIDATION: 'Check your input',
  E_FORBIDDEN: 'Access denied',
  E_UNAUTHORIZED: 'Authentication failed',
  E_NOT_FOUND: 'Interview or resource not found',
  E_STATE: 'This action is unavailable at this stage',
  E_DISCLOSURE_REQUIRED: 'Review the privacy notice before continuing',
  E_MATERIALS_UNCONFIRMED: 'Confirm your interview materials',
  E_PLAN_FAILED: 'The interview questions could not be generated',
  E_REALTIME: 'Voice connection failed',
  E_REALTIME_TIMEOUT: 'The voice connection timed out',
  E_UPLINK_PAUSED: 'Audio uploads are paused',
  E_UPSTREAM: 'The model service is unavailable',
  E_REPORT_FAILED: 'The report could not be generated',
  E_INTERNAL: 'The service could not complete this request',
};

function errorCopy(message: string, fallback: string): string {
  const translated = t(message);
  return language() === 'en' && /\p{Script=Han}/u.test(translated) ? fallback : translated;
}

interface ErrorStateProps {
  error: AppErrorBody;
  compact?: boolean;
  onAction?(action: ErrorAction): void;
}

export function ErrorState({ error, compact = false, onAction }: ErrorStateProps) {
  const halt = error.halt === true || error.code === 'E_QUOTA';
  const spec: ErrorSpec = ERROR_SPECS[error.code] ?? {
    title: error.message,
    fallbackHint: t('按提示检查后再继续。'),
    icon: Gear,
    actions: halt ? [{ id: 'home', label: t('返回首页') }] : [{ id: 'retry', label: t('再试一次'), primary: true }],
  };
  const Icon = spec.icon;
  const actions = halt ? spec.actions.filter((action) => action.id !== 'retry' && action.id !== 'reconnect') : spec.actions;

  return (
    <section className={`error-state${halt ? ' error-state--halt' : ''}${compact ? ' error-state--compact' : ''}`} role={halt ? 'alert' : undefined} aria-live={halt ? undefined : 'polite'}>
      <div className="error-icon"><Icon size={24} weight="bold" aria-hidden={true} /></div>
      <div className="error-content">
        <code>{error.code}</code>
        <h2>{errorCopy(spec.title, englishErrorTitles[error.code] ?? 'The request could not be completed')}</h2>
        <p>{errorCopy(error.hint ?? (error.code === 'E_QUOTA' ? error.message : spec.fallbackHint), t(spec.fallbackHint))}</p>
      </div>
      <div className="error-actions">
        {actions.map((action) => (
          <button key={action.id} className={`button ${action.primary ? 'button--primary' : 'button--paper'}`} type="button" onClick={() => onAction?.(action.id)}>
            {action.id === 'home' ? <ArrowLeft size={16} weight="bold" aria-hidden="true" /> : null}
            {t(action.label)}
          </button>
        ))}
      </div>
    </section>
  );
}
