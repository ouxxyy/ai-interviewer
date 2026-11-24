import { appPath, language, languageSnapshot, navigationPath, subscribeLanguage, t } from './lib/i18n.js';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, api } from './api';
import { ErrorState } from './components/ErrorState';
import { HistoryPage } from './pages/HistoryPage';
import { HomePage } from './pages/HomePage';
import { PrivacyPage } from './pages/PrivacyPage';
import { ReportPage } from './pages/ReportPage';
import { SessionPage } from './pages/SessionPage';
import { ModelSettingsPage } from './pages/ModelSettingsPage';
import { PublicResources } from './components/PublicResources';
import chineseContent from './public-content.json';
import englishContent from './public-content.en.json';
import type { AppErrorBody, MaterialsDraft, PreviewData, WebSettings } from './types';

/** 预览只在开发构建里通过查询参数开启；生产构建里这个分支会被整体消除（P2-1）。 */
function previewName(): string | null {
  if (import.meta.env.DEV) return new URLSearchParams(location.search).get('preview');
  return null;
}

export default function App() {
  const preview = previewName();
  useSyncExternalStore(subscribeLanguage, languageSnapshot);
  const locale = language();
  const [path, setPath] = useState(() => appPath(location.pathname));
  useEffect(() => {
    const metadata = locale === 'en' ? englishContent : chineseContent;
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    document.title = metadata.title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', metadata.description);
  }, [locale]);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  /** 错误画廊也只是开发预览页，同样走 DEV-only 动态载入，不进生产包。 */
  const [errorGallery, setErrorGallery] = useState<React.ComponentType<{ onNavigate(path: string): void }> | null>(null);
  const [settings, setSettings] = useState<WebSettings | null>(null);
  const [modelConfigured, setModelConfigured] = useState<boolean | null>(null);
  const [bootError, setBootError] = useState<AppErrorBody | null>(null);
  const [pendingSetup, setPendingSetup] = useState<{ sid: string; materials: MaterialsDraft } | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  const navigate = useCallback((next: string) => {
    history.pushState({}, '', navigationPath(next));
    setPath(next);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  const consumeSetup = useCallback(() => setPendingSetup(null), []);

  useEffect(() => {
    const onPopState = () => setPath(appPath(location.pathname));
    addEventListener('popstate', onPopState);
    return () => removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (preview !== null) return;
    let active = true;
    void api.bootstrap().then(() => Promise.all([api.settings(), api.modelConfig()]))
      .then(([settingsResult, modelConfig]) => {
        if (!active) return;
        setSettings(settingsResult.settings);
        setModelConfigured(modelConfig.configured);
      })
      .catch((caught) => active && setBootError(caught instanceof ApiError ? caught.body : { code: 'E_OFFLINE', message: t('暂时无法读取应用设置'), hint: t('请检查网络连接后刷新重试') }));
    return () => { active = false; };
  }, [preview]);

  useEffect(() => {
    if (preview === null) return;
    let active = true;
    if (import.meta.env.DEV) {
      void import('./preview').then((module) => {
        if (!active) return;
        const bundle = module.previewBundle(preview);
        setPreviewData(bundle);
        if (bundle !== null) {
          setSettings(bundle.settings);
        }
      });
      void import('./pages/ErrorGalleryPage').then((module) => {
        if (active) setErrorGallery(() => module.ErrorGalleryPage);
      });
    }
    return () => { active = false; };
  }, [preview]);

  /** 设置只有一个真相：App。隐私页改完立刻回写，首页再读到的就不会是旧值（P0-2）。 */
  const updateSettings = useCallback(async (patch: Partial<Pick<WebSettings, 'saveHistory' | 'saveAudio' | 'answerStartMode'>>) => {
    const result = await api.updateSettings(patch);
    setSettings(result.settings);
    return result.settings;
  }, []);

  const onSessionReady = useCallback((sid: string, materials: MaterialsDraft) => {
    setPendingSetup({ sid, materials });
    navigate(`/session/${encodeURIComponent(sid)}`);
  }, [navigate]);

  const previewKind = previewData?.kind ?? null;
  let content: React.ReactNode;
  if (settings === null || (preview === null && modelConfigured === null)) {
    content = bootError !== null ? <main className="standalone-state"><ErrorState error={bootError} onAction={() => location.reload()} /></main> : <main className="app-loading" aria-live="polite"><div className="loading-logo">8</div><p>{t("正在打开欧八面试陪练…")}</p></main>;
  } else if (previewKind === 'session' && previewData?.snapshot != null) {
    content = <SessionPage sid={previewData.snapshot.sid} preview={previewData.snapshot} previewTranscript={previewData.transcript ?? undefined} answerStartMode={settings.answerStartMode} onSetupConsumed={consumeSetup} onNavigate={navigate} />;
  } else if (previewKind === 'report' && previewData?.detail != null) {
    content = <ReportPage sid={previewData.detail.sid} preview={previewData.detail} onNavigate={navigate} />;
  } else if (previewKind === 'errors' && errorGallery !== null) {
    const Gallery = errorGallery;
    content = <Gallery onNavigate={navigate} />;
  } else if (path === '/history') {
    content = <HistoryPage onNavigate={navigate} />;
  } else if (path === '/privacy') {
    content = <PrivacyPage settings={settings} onUpdate={updateSettings} onNavigate={navigate} />;
  } else if (path === '/settings') {
    content = <ModelSettingsPage settings={settings} setupRequired={modelConfigured === false} onConfigured={setModelConfigured} onUpdate={updateSettings} onNavigate={navigate} />;
  } else if (preview === null && !modelConfigured && !path.startsWith('/report/')) {
    content = <ModelSettingsPage settings={settings} setupRequired onConfigured={setModelConfigured} onUpdate={updateSettings} onNavigate={navigate} />;
  } else if (path.startsWith('/session/')) {
    const sid = decodeURIComponent(path.slice('/session/'.length));
    content = <SessionPage sid={sid} setup={pendingSetup?.sid === sid ? pendingSetup.materials : undefined} answerStartMode={settings.answerStartMode} onSetupConsumed={consumeSetup} onNavigate={navigate} />;
  } else if (path.startsWith('/report/')) {
    content = <ReportPage sid={decodeURIComponent(path.slice('/report/'.length))} onNavigate={navigate} />;
  } else {
    content = <HomePage preview={previewKind === 'home'} settings={settings} onNavigate={navigate} onSessionReady={onSessionReady} />;
  }

  return <div ref={shellRef} id="app-shell">{content}{path === '/' && preview === null ? <PublicResources /> : null}</div>;
}
