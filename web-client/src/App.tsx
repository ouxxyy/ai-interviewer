import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';
import { DisclosureDialog } from './components/DisclosureDialog';
import { ErrorState } from './components/ErrorState';
import { previewDisclosure, previewReport, previewSession, previewSettings } from './preview';
import { ErrorGalleryPage } from './pages/ErrorGalleryPage';
import { HistoryPage } from './pages/HistoryPage';
import { HomePage } from './pages/HomePage';
import { PrivacyPage } from './pages/PrivacyPage';
import { ReportPage } from './pages/ReportPage';
import { SessionPage } from './pages/SessionPage';
import type { AppErrorBody, Disclosure, MaterialsDraft, WebSettings } from './types';

function previewName(): string | null {
  return import.meta.env.DEV ? new URLSearchParams(location.search).get('preview') : null;
}

export default function App() {
  const preview = previewName();
  const [path, setPath] = useState(location.pathname);
  const [settings, setSettings] = useState<WebSettings | null>(preview ? previewSettings : null);
  const [disclosure, setDisclosure] = useState<Disclosure | null>(preview === 'home' ? previewDisclosure : null);
  const [needsDisclosure, setNeedsDisclosure] = useState(preview === 'home');
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
    if (shellRef.current !== null) shellRef.current.inert = needsDisclosure;
  }, [needsDisclosure]);

  const acknowledge = async () => {
    if (preview === 'home') {
      setNeedsDisclosure(false);
      setSettings({ ...previewSettings, disclosureAckVersion: previewDisclosure.version });
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

  let content: React.ReactNode;
  if (settings === null) {
    content = bootError !== null ? <main className="standalone-state"><ErrorState error={bootError} onAction={() => location.reload()} /></main> : <main className="app-loading" aria-live="polite"><div className="loading-logo">8</div><p>正在打开欧八面试陪练…</p></main>;
  } else if (preview === 'session') {
    content = <SessionPage sid="preview-session" preview={previewSession} onSetupConsumed={consumeSetup} onNavigate={navigate} />;
  } else if (preview === 'report') {
    content = <ReportPage sid="preview-report" preview={previewReport} onNavigate={navigate} />;
  } else if (preview === 'errors') {
    content = <ErrorGalleryPage onNavigate={navigate} />;
  } else if (path === '/history') {
    content = <HistoryPage onNavigate={navigate} />;
  } else if (path === '/privacy') {
    content = <PrivacyPage initialSettings={settings} onNavigate={navigate} />;
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
