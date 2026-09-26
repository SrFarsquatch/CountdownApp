(() => {
  const API_ORIGIN = 'https://questlog.mattmoonie.ca';

  function isNative() {
    const capacitor = window.Capacitor;
    if (!capacitor) return false;
    if (typeof capacitor.isNativePlatform === 'function') return capacitor.isNativePlatform();
    if (typeof capacitor.getPlatform === 'function') return ['ios', 'android'].includes(capacitor.getPlatform());
    return false;
  }

  function apiUrl(path) {
    const value = String(path || '');
    if (!isNative() || !value.startsWith('/api/')) return value;
    return API_ORIGIN + value;
  }

  window.QuestLogNative = {
    get isNative() { return isNative(); },
    apiOrigin: API_ORIGIN,
    apiUrl
  };

  if (isNative()) document.documentElement.dataset.nativeApp = '1';
})();
