import { CloudArrowUp, Coins, Database, HouseLine, Trash } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';
import type { Disclosure } from '../types';

interface DisclosureDialogProps {
  disclosure: Disclosure;
  busy: boolean;
  onConfirm(): void;
  onLeave(): void;
}

export function DisclosureDialog({ disclosure, busy, onConfirm, onLeave }: DisclosureDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || dialogRef.current === null) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button,[href],input,[tabindex]:not([tabindex="-1"])')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="dialog-backdrop dialog-backdrop--strong">
      <section ref={dialogRef} className="disclosure-dialog" role="dialog" aria-modal="true" aria-labelledby="disclosure-title">
        <div className="disclosure-heading">
          <div>
            <h2 ref={titleRef} id="disclosure-title" tabIndex={-1}>开始前，先说清数据去哪里</h2>
            <p>这是一份可核对的使用告知。确认后才会创建面试会话。</p>
          </div>
          <span className="version-chip">{disclosure.version}</span>
        </div>
        <div className="disclosure-grid">
          <DisclosureCell icon={HouseLine} title={disclosure.version.startsWith('disclosure@public') ? '保存在本站服务器' : '留在本机'} items={disclosure.staysLocal} />
          <DisclosureCell icon={CloudArrowUp} title="发送到云服务" items={disclosure.sentToCloud} />
          <DisclosureCell icon={Database} title="保存位置" items={[disclosure.storage.database, disclosure.storage.audio, disclosure.storage.note]} />
          <DisclosureCell icon={Trash} title="如何删除" items={disclosure.deletion} />
          <DisclosureCell className="disclosure-cell--wide" icon={Coins} title="费用说明" items={[disclosure.billing.payer, disclosure.billing.pricing, disclosure.billing.counter]} />
        </div>
        <div className="dialog-actions">
          <button className="button button--plain" type="button" onClick={onLeave} disabled={busy}>暂不开始</button>
          <button className="button button--primary" type="button" onClick={onConfirm} disabled={busy}>{busy ? '正在保存…' : '我已了解，继续'}</button>
        </div>
      </section>
    </div>
  );
}

function DisclosureCell({ icon: Icon, title, items, className = '' }: { icon: typeof HouseLine; title: string; items: readonly string[]; className?: string }) {
  return (
    <article className={`disclosure-cell ${className}`}>
      <div className="disclosure-cell__title"><Icon size={20} weight="bold" aria-hidden="true" /><h3>{title}</h3></div>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </article>
  );
}
