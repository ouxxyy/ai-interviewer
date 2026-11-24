import { displayedPreference, language, navigationPath, selectLanguage, t, type LanguagePreference } from '../lib/i18n.js';
import { ClockCounterClockwise, EnvelopeSimple, LockKey, SlidersHorizontal } from '@phosphor-icons/react';

interface BrandHeaderProps {
  onNavigate(path: string): void;
  compact?: boolean;
  showContact?: boolean;
}

export function BrandHeader({ onNavigate, compact = false, showContact = false }: BrandHeaderProps) {
  const follow = (event: React.MouseEvent<HTMLAnchorElement>, path: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onNavigate(path);
  };
  return (
    <header className={`brand-header${compact ? ' brand-header--compact' : ''}${showContact ? ' brand-header--contact' : ''}`}>
      <a className="brand-mark" href={navigationPath('/')} onClick={(event) => follow(event, '/')} aria-label={t("返回首页")}>
        <span aria-hidden="true">8</span>
        <strong>{t("欧八面试陪练")}</strong>
      </a>
      <nav className="brand-nav" aria-label={t("主导航")}>
        <a className="nav-text nav-config" href={navigationPath('/settings')} onClick={(event) => follow(event, '/settings')}>
          <SlidersHorizontal size={17} weight="bold" aria-hidden="true" />
          {t("设置")}
        </a>
        <a className="nav-ticket" href={navigationPath('/history')} onClick={(event) => follow(event, '/history')}>
          <ClockCounterClockwise size={17} weight="bold" aria-hidden="true" />
          {t("历史练习")}
        </a>
        <a className="nav-text" href={navigationPath('/privacy')} onClick={(event) => follow(event, '/privacy')}>
          <LockKey size={16} weight="bold" aria-hidden="true" />
          {t("隐私说明")}
        </a>
        {showContact && (
          <a className="nav-text nav-contact" href="https://albertou.redboook.cn/" target="_blank" rel="noopener noreferrer" aria-label={t("联系我（新标签页打开）")}>
            <EnvelopeSimple size={17} weight="bold" aria-hidden="true" />
            {t("联系我")}
          </a>
        )}
        <label className="language-menu">
          <span className="sr-only">{t('界面和新面试的语言')}</span>
          <select value={displayedPreference()} onChange={(event) => selectLanguage(event.target.value as LanguagePreference)}>
            <option value="auto">{language() === 'en' ? 'Use browser' : '跟随浏览器'}</option>
            <option value="zh" lang="zh-CN">中文</option>
            <option value="en" lang="en">English</option>
          </select>
        </label>
      </nav>
    </header>
  );
}
