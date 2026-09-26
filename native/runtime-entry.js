import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';

const API_ORIGIN = 'https://questlog.mattmoonie.ca';
const CALLBACK_SCHEME = 'questlog://';

function isNative() {
  return Capacitor.isNativePlatform();
}

function apiUrl(path) {
  const value = String(path || '');
  if (!isNative() || !value.startsWith('/api/')) return value;
  return API_ORIGIN + value;
}

async function openAuthUrl(url) {
  const target = String(url || '');
  if (!target.startsWith('https://')) throw new Error('Native authentication URL must use HTTPS.');
  await Browser.open({ url: target });
}

function parseCallback(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    if (url.protocol !== 'questlog:') return null;
    const provider = (url.hostname || url.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean);
    const resolvedProvider = provider === 'oauth' ? (parts[0] || '').toLowerCase() : provider;
    const actualProvider = url.hostname === 'oauth' ? (parts[0] || '').toLowerCase() : resolvedProvider;
    return {
      provider: actualProvider,
      status: url.searchParams.get('status') || '',
      url: url.toString()
    };
  } catch {
    return null;
  }
}

async function handleNativeUrl(rawUrl) {
  const callback = parseCallback(rawUrl);
  if (!callback) return false;

  try { await Browser.close(); } catch {}

  window.dispatchEvent(new CustomEvent('questlog:native-oauth', { detail: callback }));

  if (callback.provider === 'google' && callback.status === 'connected') {
    const target = new URL(location.href);
    target.pathname = '/';
    target.search = '?view=settings&calendar=connected&source=native';
    target.hash = '';
    location.replace(target.pathname + target.search);
  }

  return true;
}

async function initializeNativeLinks() {
  if (!isNative()) return;

  document.documentElement.dataset.nativeApp = '1';

  await App.addListener('appUrlOpen', event => {
    handleNativeUrl(event.url).catch(() => {});
  });

  try {
    const launch = await App.getLaunchUrl();
    if (launch?.url) await handleNativeUrl(launch.url);
  } catch {}
}

window.QuestLogNative = {
  get isNative() { return isNative(); },
  apiOrigin: API_ORIGIN,
  callbackScheme: CALLBACK_SCHEME,
  apiUrl,
  openAuthUrl,
  handleNativeUrl
};

initializeNativeLinks().catch(() => {});
