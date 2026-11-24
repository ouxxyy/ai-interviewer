import { t } from '../lib/i18n.js';
import { CheckCircle, Cpu, CursorClick, Key, Microphone, ShieldCheck, Waveform } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { BrandHeader } from '../components/BrandHeader';
import { ErrorState } from '../components/ErrorState';
import type { AppErrorBody, ModelConfigStatus, WebSettings } from '../types';

interface ModelSettingsPageProps {
  settings: WebSettings;
  setupRequired?: boolean;
  onConfigured(configured: boolean): void;
  onUpdate(patch: Partial<Pick<WebSettings, 'answerStartMode'>>): Promise<WebSettings>;
  onNavigate(path: string): void;
}

export function ModelSettingsPage({ settings, setupRequired = false, onConfigured, onUpdate, onNavigate }: ModelSettingsPageProps) {
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
      setError(caught instanceof ApiError ? caught.body : { code: 'E_OFFLINE', message: t('本地服务未连接') });
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (config === null || apiKey.trim().length < 20) {
      setError({ code: 'E_VALIDATION', message: t('请输入完整的百炼 API Key') });
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
      onConfigured(next.configured);
      if (setupRequired && next.configured) onNavigate('/');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.body : { code: 'E_INTERNAL', message: t('保存失败，请重试') });
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
      setError(caught instanceof ApiError ? caught.body : { code: 'E_INTERNAL', message: t('面试节奏保存失败，请重试') });
    } finally {
      setSavingMode(false);
    }
  };

  return (
    <div className="page page--model-settings">
      <BrandHeader onNavigate={onNavigate} />
      <main className="model-settings-main">
        <header className="list-heading">
          <div><h1>{setupRequired ? t('先配置百炼，再开始面试') : t('面试与模型设置')}</h1><p>{setupRequired ? t('首次使用需要填入你自己的百炼 API Key。保存后即可填写岗位和经历，开始训练。') : t('默认可使用本站免费面试服务；填写自己的百炼 API Key 后，新建面试优先使用百炼。')}</p></div>
          <span className={`config-status${config?.configured ? ' is-ready' : ''}`}><CheckCircle size={19} weight="fill" aria-hidden="true" />{config === null ? t('读取中…') : config.provider === 'free-openai' ? t('免费服务可用') : config.configured ? t('百炼已配置') : t('未配置')}</span>
        </header>

        {error !== null ? <ErrorState error={error} onAction={(action) => { if (action === 'retry') void loadConfig(); }} /> : null}
        {config?.freeAvailable ? <section className="credential-form" aria-label={t("免费面试服务")}><h2>{config.userConfigured ? t('当前使用你的百炼') : t('免费面试，无需配置 Key')}</h2><p>{config.userConfigured ? t('新建场次使用你的百炼账号，费用由该账号承担。本站免费服务不会替代你已保存的配置。') : t('直接返回首页，填写岗位和经历即可开始。每位访客每天可免费新建 3 场；共享额度繁忙或用完时会明确提示。')}</p><p>{t("免费模式的回答在点击“说完了”后转写；面试官声音由 AI 合成。")}</p><button type="button" className="button button--primary" onClick={() => onNavigate('/')}>{t("返回首页开始练习")}</button></section> : null}
        <form className="credential-form" onSubmit={(event) => void save(event)}>
          <div className="credential-form__heading"><span><Key size={23} weight="bold" aria-hidden="true" /></span><div><h2>{t("使用自己的百炼（可选）")}</h2><p>{config?.storage === 'visitor-encrypted' ? t('Key 经同源 HTTPS 提交，服务器按访客隔离加密保存。访客 Cookie 用于识别你的浏览器；清除 Cookie 或换浏览器后须重新配置。') : t('Key 经同源请求提交到本地服务，仅保存在项目根 .env。')}{t("服务端不在日志中记录、不回显密钥。新建场次优先使用你的百炼配置；调用失败时不会自动切换免费服务。")}</p></div></div>
          <label htmlFor="dashscope-api-key">{(config?.userConfigured ?? config?.configured) ? t('替换现有百炼 Key') : t('输入百炼 API Key（可选）')}</label>
          <div className="credential-input-row">
            <input id="dashscope-api-key" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setSaved(false); }} autoComplete="off" spellCheck={false} placeholder="sk-…" disabled={busy || config === null} />
            <button className="button button--primary" type="submit" disabled={busy || config === null || apiKey.trim().length < 20}>{busy ? t('正在保存…') : (config?.userConfigured ?? config?.configured) ? t('更新配置') : setupRequired ? t('保存并开始练习') : t('保存配置')}</button>
          </div>
          {saved ? <p className="config-saved" role="status"><CheckCircle size={17} weight="fill" aria-hidden="true" />{t("已保存。新建一场训练即可使用。")}</p> : null}
          <small>{t("Key 不会出现在健康检查、日志、历史报告或页面回显中。")}</small>
        </form>

        <section className="credential-form" aria-labelledby="key-help-title">
          <h2 id="key-help-title">{t("如何申请百炼 API Key")}</h2>
          <ol>
            <li>{t("注册并登录阿里云账号，按控制台提示完成实名认证、开通百炼模型服务。")}</li>
            <li>{t("打开")}<a href="https://bailian.console.aliyun.com/" target="_blank" rel="noreferrer">{t("百炼控制台")}</a>{t("，选择")}<strong>{t("华北 2（北京）")}</strong>{t("地域，进入“密钥管理 / API Key”。本应用使用北京端点，其他地域的 Key 不能混用。")}</li>
            <li>{t("点击“创建 API Key”，按页面选择归属账号和业务空间（个人使用可选默认业务空间）。创建成功后立即复制并保存完整 Key；新版 Key 只显示一次。没有创建权限时联系账号管理员。")}</li>
            <li>{t("将 Key 粘贴到本页输入框并保存，再新建一场训练。这里需要百炼 API Key，不是阿里云 AccessKey ID / Secret。")}</li>
          </ol>
          <p>{t("保存成功仅代表格式与存储成功，模型权限与余额要在实际调用时验证。费用由你的百炼账号承担，请检查模型权限、额度与账单；不要把 Key 发给他人或写进简历。")}</p>
          <p>{t("若提示鉴权失败，核对地域、Key 是否撤销及模型权限；额度不足请前往百炼查看账单。详见")}<a href="https://help.aliyun.com/zh/model-studio/get-api-key/" target="_blank" rel="noreferrer">{t("阿里云官方获取说明")}</a>{t("。")}</p>
        </section>

        <section className="model-config-grid" aria-label={t("当前模型配置")}>
          <ConfigCard icon={Cpu} label={t("题目与评审")} value={config?.textModel ?? t('读取中…')} />
          <ConfigCard icon={Waveform} label={config?.provider === 'free-openai' ? t('语音朗读') : t('实时对话')} value={config?.realtimeModel ?? t('读取中…')} detail={config ? t("音色 {0}", config.voice) : undefined} />
          <ConfigCard icon={ShieldCheck} label={t("保存位置")} value={config?.provider === 'free-openai' ? t('本站服务端私有配置') : config?.storage === 'visitor-encrypted' ? t('服务器加密存储（按访客隔离）') : t('项目根 .env')} detail={t("不写入浏览器存储，不回显原值")} />
        </section>

        {!setupRequired && <section className="answer-mode-panel" aria-labelledby="answer-mode-title">
          <div className="answer-mode-heading"><span><Microphone size={23} weight="bold" aria-hidden="true" /></span><div><h2 id="answer-mode-title">{t("开麦方式")}</h2><p>{t("回答仍由你点“说完了”结束；这里仅决定小八说完后是否自动开始下一轮录音。")}</p></div></div>
          <div className="answer-mode-options" role="radiogroup" aria-label={t("开麦方式")}>
            <label className={settings.answerStartMode === 'continuous' ? 'is-selected' : ''}>
              <input type="radio" name="answer-start-mode" value="continuous" checked={settings.answerStartMode === 'continuous'} disabled={savingMode} onChange={() => void changeAnswerMode('continuous')} />
              <Waveform size={21} weight="bold" aria-hidden="true" />
              <span><strong>{t("连续面试（默认）")}</strong><small>{t("第一题点击一次；之后主问题、追问和重答在小八说完后自动开麦。")}</small></span>
            </label>
            <label className={settings.answerStartMode === 'manual' ? 'is-selected' : ''}>
              <input type="radio" name="answer-start-mode" value="manual" checked={settings.answerStartMode === 'manual'} disabled={savingMode} onChange={() => void changeAnswerMode('manual')} />
              <CursorClick size={21} weight="bold" aria-hidden="true" />
              <span><strong>{t("每轮手动开始")}</strong><small>{t("保留当前方式：每个主问题和追问都要点击“开始作答”。")}</small></span>
            </label>
          </div>
          {modeSaved ? <p className="config-saved" role="status"><CheckCircle size={17} weight="fill" aria-hidden="true" />{t("开麦方式已保存。")}</p> : null}
        </section>}



      </main>
    </div>
  );
}

function ConfigCard({ icon: Icon, label, value, detail }: { icon: typeof Cpu; label: string; value: string; detail?: string }) {
  return <article><span><Icon size={23} weight="bold" aria-hidden="true" /></span><div><p>{label}</p><strong>{value}</strong>{detail ? <small>{detail}</small> : null}</div></article>;
}
