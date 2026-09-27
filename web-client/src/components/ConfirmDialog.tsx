import { useEffect, useRef } from 'react';

interface ConfirmDialogProps {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  dangerous?: boolean;
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({ title, children, confirmLabel, dangerous = false, busy = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{title}</h2>
        <div className="confirm-copy">{children}</div>
        <div className="dialog-actions">
          <button ref={cancelRef} className="button button--paper" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className={`button ${dangerous ? 'button--danger' : 'button--primary'}`} type="button" onClick={onConfirm} disabled={busy}>
            {busy ? '正在处理…' : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
