/* The unprefixed role archive predates the bilingual app. Keep its incoming links working. */
(() => {
  const url = new URL(location.href);
  const key = 'ouba-interview-language';
  let preference;
  try { preference = localStorage.getItem(key); } catch { /* Private browsing. */ }
  if (url.searchParams.get('lang') === 'zh') {
    try { localStorage.setItem(key, 'zh'); } catch { /* The URL still selects Chinese. */ }
    return;
  }
  const supported = (navigator.languages?.length ? navigator.languages : [navigator.language])
    .map(tag => tag.toLowerCase().split('-')[0]).find(tag => tag === 'en' || tag === 'zh');
  if ((preference || supported || 'en') === 'en') {
    url.pathname = '/en' + url.pathname;
    location.replace(url.href);
  }
})();
