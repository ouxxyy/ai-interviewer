import { ClockCounterClockwise, LockKey, SlidersHorizontal } from '@phosphor-icons/react';

interface BrandHeaderProps {
  onNavigate(path: string): void;
  compact?: boolean;
}

export function BrandHeader({ onNavigate, compact = false }: BrandHeaderProps) {
  const follow = (event: React.MouseEvent<HTMLAnchorElement>, path: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onNavigate(path);
  };
  return (
    <header className={`brand-header${compact ? ' brand-header--compact' : ''}`}>
      <a className="brand-mark" href="/" onClick={(event) => follow(event, '/')} aria-label="返回首页">
        <span aria-hidden="true">8</span>
        <strong>欧八面试陪练</strong>
      </a>
      <nav className="brand-nav" aria-label="主导航">
        <a className="nav-text nav-config" href="/settings" onClick={(event) => follow(event, '/settings')}>
          <SlidersHorizontal size={17} weight="bold" aria-hidden="true" />
          设置
        </a>
        <a className="nav-ticket" href="/history" onClick={(event) => follow(event, '/history')}>
          <ClockCounterClockwise size={17} weight="bold" aria-hidden="true" />
          历史练习
        </a>
        <a className="nav-text" href="/privacy" onClick={(event) => follow(event, '/privacy')}>
          <LockKey size={16} weight="bold" aria-hidden="true" />
          隐私说明
        </a>
      </nav>
    </header>
  );
}
