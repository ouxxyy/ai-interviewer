import { CheckCircle, Cpu, CursorClick, Key, Microphone, ShieldCheck, Waveform } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { BrandHeader } from '../components/BrandHeader';
import { ErrorState } from '../components/ErrorState';
import type { AppErrorBody, ModelConfigStatus, WebSettings } from '../types';

interface ModelSettingsPageProps {
  settings: WebSettings;
  onUpdate(patch: Partial<Pick<WebSettings, 'answerStartMode'>>): Promise<WebSettings>;
  onNavigate(path: string): void;
}

export function ModelSettingsPage({ settings, onUpdate, onNavigate }: ModelSettingsPageProps) {
  const [config, setConfig] = useState<ModelConfigStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savingMode, setSavingMode] = useState(false);
  const [modeSaved, setModeSaved] = useState(false);
  const [error, setError] = useState<AppErrorBody | null>(null);

  const loadConfig = useCallback(async () => {
    setError(null);
    try {
      setConfig(await api.modelConfig());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.body : { code: 'E_OFFLINE', message: '本地服务未连接' });
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (config === null || apiKey.trim().length < 20) {
      setError({ code: 'E_VALIDATION', message: '请输入完整的百炼 API Key' });
      return;
    }
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const next = await api.updateModelConfig(apiKey.trim(), config.configToken);
      setConfig(next);
      setApiKey('');
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.body : { code: 'E_INTERNAL', message: '保存失败，请重试' });
    } finally {
      setBusy(false);
    }
  };

  const changeAnswerMode = async (answerStartMode: WebSettings['answerStartMode']) => {
    if (answerStartMode === settings.answerStartMode) return;
    setSavingMode(true);
    setModeSaved(false);
    setError(null);
    try {
      await onUpdate({ answerStartMode });
      setModeSaved(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.body : { code: 'E_INTERNAL', message: '面试节奏保存失败，请重试' });
    } finally {
      setSavingMode(false);
    }
  };

  return (
    <div className="page page--model-settings">
      <BrandHeader onNavigate={onNavigate} />
      <main className="model-settings-main">
        <header className="list-heading">
          <div><h1>面试与模型设置</h1><p>设置开麦节奏，并管理题目、评审与实时语音使用的百炼 API Key。</p></div>
          <span className={`config-status${config?.configured ? ' is-ready' : ''}`}><CheckCircle size={19} weight="fill" aria-hidden="true" />{config?.configured ? '已配置' : '未配置'}</span>
        </header>

        {error !== null ? <ErrorState error={error} onAction={(action) => { if (action === 'retry') void loadConfig(); }} /> : null}
        <section className="model-config-grid" aria-label="当前模型配置">
          <ConfigCard icon={Cpu} label="题目与评审" value={config?.textModel ?? '读取中…'} />
          <ConfigCard icon={Waveform} label="实时对话" value={config?.realtimeModel ?? '读取中…'} detail={config ? `音色 ${config.voice}` : undefined} />
          <ConfigCard icon={ShieldCheck} label="保存位置" value="项目根 .env" detail="不写入浏览器存储，不回显原值" />
        </section>

        <section className="answer-mode-panel" aria-labelledby="answer-mode-title">
          <div className="answer-mode-heading"><span><Microphone size={23} weight="bold" aria-hidden="true" /></span><div><h2 id="answer-mode-title">开麦方式</h2><p>回答仍由你点“说完了”结束；这里仅决定小八说完后是否自动开始下一轮录音。</p></div></div>
          <div className="answer-mode-options" role="radiogroup" aria-label="开麦方式">
            <label className={settings.answerStartMode === 'continuous' ? 'is-selected' : ''}>
              <input type="radio" name="answer-start-mode" value="continuous" checked={settings.answerStartMode === 'continuous'} disabled={savingMode} onChange={() => void changeAnswerMode('continuous')} />
              <Waveform size={21} weight="bold" aria-hidden="true" />
              <span><strong>连续面试（默认）</strong><small>第一题点击一次；之后主问题、追问和重答在小八说完后自动开麦。</small></span>
            </label>
            <label className={settings.answerStartMode === 'manual' ? 'is-selected' : ''}>
              <input type="radio" name="answer-start-mode" value="manual" checked={settings.answerStartMode === 'manual'} disabled={savingMode} onChange={() => void changeAnswerMode('manual')} />
              <CursorClick size={21} weight="bold" aria-hidden="true" />
              <span><strong>每轮手动开始</strong><small>保留当前方式：每个主问题和追问都要点击“开始作答”。</small></span>
            </label>
          </div>
          {modeSaved ? <p className="config-saved" role="status"><CheckCircle size={17} weight="fill" aria-hidden="true" />开麦方式已保存。</p> : null}
        </section>

        <form className="credential-form" onSubmit={(event) => void save(event)}>
          <div className="credential-form__heading"><span><Key size={23} weight="bold" aria-hidden="true" /></span><div><h2>配置百炼 API Key</h2><p>提交只经过 <code>127.0.0.1</code> 同源请求；服务端不记录、不回显密钥。对之后新建的场次立即生效。</p></div></div>
          <label htmlFor="dashscope-api-key">{config?.configured ? '替换现有 Key' : '输入 API Key'}</label>
          <div className="credential-input-row">
            <input id="dashscope-api-key" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setSaved(false); }} autoComplete="off" spellCheck={false} placeholder="sk-…" disabled={busy || config === null} />
            <button className="button button--primary" type="submit" disabled={busy || config === null || apiKey.trim().length < 20}>{busy ? '正在保存…' : config?.configured ? '更新配置' : '保存配置'}</button>
          </div>
          {saved ? <p className="config-saved" role="status"><CheckCircle size={17} weight="fill" aria-hidden="true" />已保存。新建一场训练即可使用。</p> : null}
          <small>Key 不会出现在健康检查、日志、历史报告或页面回显中。</small>
        </form>
      </main>
    </div>
  );
}

function ConfigCard({ icon: Icon, label, value, detail }: { icon: typeof Cpu; label: string; value: string; detail?: string }) {
  return <article><span><Icon size={23} weight="bold" aria-hidden="true" /></span><div><p>{label}</p><strong>{value}</strong>{detail ? <small>{detail}</small> : null}</div></article>;
}
