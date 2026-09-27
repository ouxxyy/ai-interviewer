import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';
import { DisclosureDialog } from './components/DisclosureDialog';
import { ErrorState } from './components/ErrorState';
import { HistoryPage } from './pages/HistoryPage';
import { HomePage } from './pages/HomePage';
import { PrivacyPage } from './pages/PrivacyPage';
import { ReportPage } from './pages/ReportPage';
import { SessionPage } from './pages/SessionPage';
import type { AppErrorBody, Disclosure, MaterialsDraft, PreviewData, WebSettings } from './types';

/** 预览只在开发构建里通过查询参数开启；生产构建里这个分支会被整体消除（P2-1）。 */
function previewName(): string | null {
  if (import.meta.env.DEV) return new URLSearchParams(location.search).get('preview');
  return null;
}

export default function App() {
  const preview = previewName();
  const [path, setPath] = useState(location.pathname);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  /** 错误画廊也只是开发预览页，同样走 DEV-only 动态载入，不进生产包。 */
  const [errorGallery, setErrorGallery] = useState<React.ComponentType<{ onNavigate(path: string): void }> | null>(null);
  const [settings, setSettings] = useState<WebSettings | null>(null);
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [needsDisclosure, setNeedsDisclosure] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [bootError, setBootError] = useState<AppErrorBody | null>(null);
  const [pendingSetup, setPendingSetup] = useState<{ sid: string; materials: MaterialsDraft } | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  const navigate = useCallback((next: string) => {
    history.pushState({}, '', next);
    setPath(next);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  const consumeSetup = useCallback(() => setPendingSetup(null), []);

  useEffect(() => {
    const onPopState = () => setPath(location.pathname);
    addEventListener('popstate', onPopState);
    return () => removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (preview !== null) return;
    let active = true;
    void Promise.all([api.settings(), api.disclosure()])
      .then(([settingsResult, disclosureResult]) => {
        if (!active) return;
        setSettings(settingsResult.settings);
        setDisclosure(disclosureResult.disclosure);
        setNeedsDisclosure(settingsResult.needsDisclosure);
      })
      .catch((caught) => active && setBootError(caught instanceof ApiError ? caught.body : { code: 'E_OFFLINE', message: '本地服务未连接', hint: '请先启动 npm run web:serve' }));
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
          setDisclosure(bundle.disclosure);
          setNeedsDisclosure(bundle.needsDisclosure);
        }
      });
      void import('./pages/ErrorGalleryPage').then((module) => {
        if (active) setErrorGallery(() => module.ErrorGalleryPage);
      });
    }
    return () => { active = false; };
  }, [preview]);

  useEffect(() => {
    if (shellRef.current !== null) shellRef.current.inert = needsDisclosure;
  }, [needsDisclosure]);

  /** 设置只有一个真相：App。隐私页改完立刻回写，首页再读到的就不会是旧值（P0-2）。 */
  const updateSettings = useCallback(async (patch: Partial<Pick<WebSettings, 'saveHistory' | 'saveAudio'>>) => {
    const result = await api.updateSettings(patch);
    setSettings(result.settings);
    setNeedsDisclosure(result.needsDisclosure);
    return result.settings;
  }, []);

  const acknowledge = async () => {
    if (previewData !== null && previewData.kind === 'home' && previewData.disclosure !== null) {
      setNeedsDisclosure(false);
      setSettings({ ...previewData.settings, disclosureAckVersion: previewData.disclosure.version });
      return;
    }
    setAcknowledging(true);
    try {
      const result = await api.acknowledgeDisclosure();
      setSettings(result.settings);
      setNeedsDisclosure(result.needsDisclosure);
    } catch (caught) {
      setBootError(caught instanceof ApiError ? caught.body : { code: 'E_OFFLINE', message: '确认未保存' });
    } finally {
      setAcknowledging(false);
    }
  };

  const onSessionReady = useCallback((sid: string, materials: MaterialsDraft) => {
    setPendingSetup({ sid, materials });
    navigate(`/session/${encodeURIComponent(sid)}`);
  }, [navigate]);

  const previewKind = previewData?.kind ?? null;
  let content: React.ReactNode;
  if (settings === null) {
    content = bootError !== null ? <main className="standalone-state"><ErrorState error={bootError} onAction={() => location.reload()} /></main> : <main className="app-loading" aria-live="polite"><div className="loading-logo">8</div><p>正在打开欧八面试陪练…</p></main>;
  } else if (previewKind === 'session' && previewData?.snapshot != null) {
    content = <SessionPage sid={previewData.snapshot.sid} preview={previewData.snapshot} previewTranscript={previewData.transcript ?? undefined} onSetupConsumed={consumeSetup} onNavigate={navigate} />;
  } else if (previewKind === 'report' && previewData?.detail != null) {
    content = <ReportPage sid={previewData.detail.sid} preview={previewData.detail} onNavigate={navigate} />;
  } else if (previewKind === 'errors' && errorGallery !== null) {
    const Gallery = errorGallery;
    content = <Gallery onNavigate={navigate} />;
  } else if (path === '/history') {
    content = <HistoryPage onNavigate={navigate} />;
  } else if (path === '/privacy') {
    content = <PrivacyPage settings={settings} onUpdate={updateSettings} onNavigate={navigate} />;
  } else if (path.startsWith('/session/')) {
    const sid = decodeURIComponent(path.slice('/session/'.length));
    content = <SessionPage sid={sid} setup={pendingSetup?.sid === sid ? pendingSetup.materials : undefined} onSetupConsumed={consumeSetup} onNavigate={navigate} />;
  } else if (path.startsWith('/report/')) {
    content = <ReportPage sid={decodeURIComponent(path.slice('/report/'.length))} onNavigate={navigate} />;
  } else {
    content = <HomePage settings={settings} onNavigate={navigate} onSessionReady={onSessionReady} />;
  }

  return (
    <>
      <div ref={shellRef} id="app-shell">{content}</div>
      {needsDisclosure && disclosure !== null ? <DisclosureDialog disclosure={disclosure} busy={acknowledging} onConfirm={() => void acknowledge()} onLeave={() => setNeedsDisclosure(false)} /> : null}
    </>
  );
}
