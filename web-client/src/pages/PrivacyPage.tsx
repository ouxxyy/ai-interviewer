import { CloudArrowUp, Coins, Database, FloppyDisk, HouseLine, Trash } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { BrandHeader } from '../components/BrandHeader';
import { ErrorState } from '../components/ErrorState';
import { togglePatch, type Toggles } from '../lib/privacy';
import type { AppErrorBody, Disclosure, WebSettings } from '../types';

interface PrivacyPageProps {
  settings: WebSettings;
  /** 设置由 App 持有（单一真相）；这里只发补丁，不保留第二份 state。 */
  onUpdate(patch: Partial<Toggles>): Promise<WebSettings>;
  onNavigate(path: string): void;
}

export function PrivacyPage({ settings, onUpdate, onNavigate }: PrivacyPageProps) {
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [error, setError] = useState<AppErrorBody | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.disclosure().then((result) => setDisclosure(result.disclosure)).catch((caught) => setError(caught instanceof ApiError ? caught.body : { code: 'E_OFFLINE', message: '网络连接中断' }));
  }, []);

  const update = async (key: keyof Toggles, value: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await onUpdate(togglePatch(settings, key, value));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.body : { code: 'E_OFFLINE', message: '保存设置失败' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page page--privacy">
      <BrandHeader onNavigate={onNavigate} />
      <main className="privacy-main">
        <header className="list-heading"><div><h1>隐私与保存</h1><p>每一项都来自服务端当前的告知版本，前端不另外复制一份。</p></div>{disclosure ? <span className="version-chip">{disclosure.version}</span> : null}</header>
        {error !== null ? <ErrorState error={error} /> : null}
        <section className="settings-panel" aria-labelledby="settings-title">
          <div><FloppyDisk size={26} weight="bold" aria-hidden="true" /><div><h2 id="settings-title">新会话的默认保存方式</h2><p>关闭开关不会删除已有记录。</p></div></div>
          <label><span><strong>保存历史</strong><small>保留转写、反馈和报告</small></span><input type="checkbox" checked={settings.saveHistory} disabled={saving} onChange={(event) => void update('saveHistory', event.target.checked)} /></label>
          <label><span><strong>保存录音</strong><small>录音依附于会话历史</small></span><input type="checkbox" checked={settings.saveAudio} disabled={saving || !settings.saveHistory} onChange={(event) => void update('saveAudio', event.target.checked)} /></label>
        </section>
        {disclosure === null ? <div className="privacy-skeleton"><span /><span /></div> : (
          <div className="privacy-sections">
            <DisclosureSection icon={HouseLine} title={disclosure.version.startsWith('disclosure@public') ? '保存在本站服务器' : '留在本机'} items={disclosure.staysLocal} />
            <DisclosureSection icon={CloudArrowUp} title="发给云模型" items={disclosure.sentToCloud} />
            <DisclosureSection icon={Database} title="保存位置" items={[disclosure.storage.root, disclosure.storage.database, disclosure.storage.audio, disclosure.storage.uploads, disclosure.storage.note]} />
            <DisclosureSection icon={Trash} title="删除方式" items={disclosure.deletion} />
            <DisclosureSection icon={Coins} title="费用说明" items={[disclosure.billing.payer, disclosure.billing.pricing, disclosure.billing.counter]} />
          </div>
        )}
      </main>
    </div>
  );
}

function DisclosureSection({ icon: Icon, title, items }: { icon: typeof HouseLine; title: string; items: readonly string[] }) {
  return <section><div className="privacy-section-title"><span><Icon size={23} weight="bold" aria-hidden="true" /></span><h2>{title}</h2></div><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></section>;
}
