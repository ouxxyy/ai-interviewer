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

interface ErrorStateProps {
  error: AppErrorBody;
  compact?: boolean;
  onAction?(action: ErrorAction): void;
}

export function ErrorState({ error, compact = false, onAction }: ErrorStateProps) {
  const halt = error.halt === true || error.code === 'E_QUOTA';
  const spec: ErrorSpec = ERROR_SPECS[error.code] ?? {
    title: error.message,
    fallbackHint: '按提示检查后再继续。',
    icon: Gear,
    actions: halt ? [{ id: 'home', label: '返回首页' }] : [{ id: 'retry', label: '再试一次', primary: true }],
  };
  const Icon = spec.icon;
  const actions = halt ? spec.actions.filter((action) => action.id !== 'retry' && action.id !== 'reconnect') : spec.actions;

  return (
    <section className={`error-state${halt ? ' error-state--halt' : ''}${compact ? ' error-state--compact' : ''}`} role={halt ? 'alert' : undefined} aria-live={halt ? undefined : 'polite'}>
      <div className="error-icon"><Icon size={24} weight="bold" aria-hidden={true} /></div>
      <div className="error-content">
        <code>{error.code}</code>
        <h2>{spec.title}</h2>
        <p>{error.hint ?? spec.fallbackHint}</p>
      </div>
      <div className="error-actions">
        {actions.map((action) => (
          <button key={action.id} className={`button ${action.primary ? 'button--primary' : 'button--paper'}`} type="button" onClick={() => onAction?.(action.id)}>
            {action.id === 'home' ? <ArrowLeft size={16} weight="bold" aria-hidden="true" /> : null}
            {action.label}
          </button>
        ))}
      </div>
    </section>
  );
}
