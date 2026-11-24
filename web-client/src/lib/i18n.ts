import { english } from './english.js';

export type InterviewLanguage = 'zh' | 'en';
export type LanguagePreference = InterviewLanguage | 'auto';
const storageKey = 'ouba-interview-language';
const preferenceEvent = 'ouba-language-change';
let transientPreference: LanguagePreference | undefined;

export function browserLanguage(languages: readonly string[]): InterviewLanguage {
  for (const tag of languages) {
    const primary = tag.toLowerCase().split('-')[0];
    if (primary === 'en' || primary === 'zh') return primary;
  }
  return 'en';
}

export function preference(): LanguagePreference {
  if (transientPreference !== undefined) return transientPreference;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch { /* Storage can be disabled in private browsing. */ }
  return 'auto';
}

function englishPath(path: string): boolean {
  return path === '/en' || path.startsWith('/en/');
}

export function appPath(path: string): string {
  return englishPath(path) ? path.slice(3) || '/' : path;
}

export function language(): InterviewLanguage {
  if (typeof window === 'undefined') return 'zh';
  if (englishPath(window.location.pathname)) return 'en';
  const choice = preference();
  return choice === 'auto' ? browserLanguage(navigator.languages?.length ? navigator.languages : [navigator.language]) : choice;
}

export function navigationPath(path: string): string {
  return englishPath(window.location.pathname) ? '/en' + path : path;
}

export function displayedPreference(): LanguagePreference {
  return englishPath(window.location.pathname) ? 'en' : preference();
}

export function selectLanguage(choice: LanguagePreference): void {
  try {
    if (choice === 'auto') window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, choice);
    transientPreference = undefined;
  } catch { transientPreference = choice; }
  const path = appPath(window.location.pathname);
  const url = (choice === 'en' ? '/en' + path : path) + window.location.search + window.location.hash;
  window.history.replaceState(window.history.state, '', url);
  window.dispatchEvent(new Event(preferenceEvent));
}

export function subscribeLanguage(onChange: () => void): () => void {
  const events = [preferenceEvent, 'languagechange', 'popstate', 'storage'];
  for (const event of events) window.addEventListener(event, onChange);
  return () => { for (const event of events) window.removeEventListener(event, onChange); };
}

export const languageSnapshot = () => language() + '/' + displayedPreference();

/** Only use with application-owned labels. Quoted evidence and user input are rendered verbatim. */
export function t(source: string, ...values: (string | number)[]): string {
  const template = language() === 'en' ? (english[source] ?? source.replace(/\S(?:[\s\S]*\S)?/, (key) => english[key] ?? key)) : source;
  return values.length ? template.replace(/\{(\d+)\}/g, (match, index) => String(values[Number(index)] ?? match)) : template;
}
