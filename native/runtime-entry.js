import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { PushNotifications } from '@capacitor/push-notifications';
import { StatusBar, Style } from '@capacitor/status-bar';

const APP_VERSION = __QUESTLOG_VERSION__;
const API_ORIGIN = 'https://questlog.mattmoonie.ca';
const CALLBACK_SCHEME = 'questlog://';
const PUSH_TOKEN_KEY = 'questlog.native.push.token';
const PUSH_PLATFORM_KEY = 'questlog.native.push.platform';

let nativePushToken = localStorage.getItem(PUSH_TOKEN_KEY) || '';
let pushListenersReady = false;
let registrationWaiter = null;
let humanChallengeWaiter = null;

function isNative() {
  return Capacitor.isNativePlatform();
}

function platform() {
  return Capacitor.getPlatform();
}

function apiUrl(path) {
  const value = String(path || '');
  if (!isNative() || !value.startsWith('/api/')) return value;
  return API_ORIGIN + value;
}

function remoteUrl(path) {
  const value = String(path || '');
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return API_ORIGIN + value;
  return API_ORIGIN + '/' + value;
}

function normalizeNativeBody(body, headers = {}) {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'string') return body;
  const contentType = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
  if (String(contentType).toLowerCase().includes('application/json')) {
    try { return JSON.parse(body); } catch {}
  }
  return body;
}

function normalizeNativeData(data) {
  if (typeof data !== 'string') return data ?? {};
  try { return JSON.parse(data); } catch { return data; }
}

async function request(path, options = {}) {
  if (!isNative()) throw new Error('Native HTTP is only available inside the installed app.');
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { accept: 'application/json', ...(options.headers || {}) };
  const response = await CapacitorHttp.request({
    url: remoteUrl(path),
    method,
    headers,
    data: normalizeNativeBody(options.body, headers),
    connectTimeout: Number(options.connectTimeout || 8000),
    readTimeout: Number(options.readTimeout || 12000),
    disableRedirects: false
  });
  const data = normalizeNativeData(response.data);
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    data,
    headers: response.headers || {},
    url: response.url || remoteUrl(path)
  };
}

function localRoute(value = '/') {
  if (!isNative()) return String(value || '/');
  try {
    const url = new URL(String(value || '/'), API_ORIGIN);
    let pathname = url.pathname || '/';
    if (pathname === '/') pathname = '/index.html';
    else if (pathname === '/login') pathname = '/login.html';
    else if (pathname === '/plaid-oauth') pathname = '/plaid-oauth.html';
    return pathname + url.search + url.hash;
  } catch {
    return '/index.html';
  }
}

function navigate(value = '/', options = {}) {
  const target = localRoute(value);
  if (options.replace === false) location.assign(target);
  else location.replace(target);
}

async function diagnostics() {
  const result = {
    native: isNative(),
    platform: platform(),
    apiOrigin: API_ORIGIN,
    route: location.pathname + location.search,
    apiReachable: false,
    authenticated: false,
    runtime: '',
    lastError: ''
  };
  if (!isNative()) return result;
  try {
    const health = await request('/healthz', { method: 'GET', connectTimeout: 6000, readTimeout: 8000 });
    result.apiReachable = health.ok;
    if (health.ok && health.data && typeof health.data === 'object') result.runtime = String(health.data.runtime || '');
    if (!health.ok) result.lastError = 'Health check returned HTTP ' + health.status;
  } catch (error) {
    result.lastError = error?.message || String(error);
  }
  if (result.apiReachable) {
    try {
      const session = await request('/api/auth/session', { method: 'GET', connectTimeout: 6000, readTimeout: 8000 });
      result.authenticated = Boolean(session.ok && session.data?.authenticated);
      if (!session.ok) result.lastError = 'Session check returned HTTP ' + session.status;
    } catch (error) {
      result.lastError = error?.message || String(error);
    }
  }
  return result;
}

async function nativeApi(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  const response = await request(path, { ...options, headers });
  if (!response.ok) {
    const message = response.data && typeof response.data === 'object' ? response.data.error : '';
    throw new Error(message || ('Native request failed (' + response.status + ').'));
  }
  return response.data;
}

async function openAuthUrl(url) {
  const target = String(url || '');
  if (!target.startsWith('https://')) throw new Error('Native authentication URL must use HTTPS.');
  await Browser.open({ url: target });
}

async function openExternalUrl(url) {
  const target = String(url || '');
  if (!/^https?:\/\//i.test(target)) throw new Error('External URL must use HTTP or HTTPS.');
  await Browser.open({ url: target });
}

async function verifyHuman() {
  if (!isNative()) return '';
  if (humanChallengeWaiter) return humanChallengeWaiter.promise;

  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  humanChallengeWaiter = { promise, resolve, reject, nonce };

  try {
    await Browser.open({ url: API_ORIGIN + '/native-auth?nonce=' + encodeURIComponent(nonce) });
  } catch (error) {
    humanChallengeWaiter = null;
    reject(error);
  }

  return promise;
}

function safeLocalRoute(value) {
  try {
    const url = new URL(String(value || '/?view=today'), API_ORIGIN);
    if (url.origin !== API_ORIGIN) return '/?view=today';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/?view=today';
  }
}

function openPushRoute(value) {
  const route = safeLocalRoute(value);
  navigate(route);
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
      redirectUrl: url.searchParams.get('redirect') || '',
      loginId: url.searchParams.get('loginId') || '',
      institution: url.searchParams.get('institution') || '',
      token: url.searchParams.get('token') || '',
      url: url.toString()
    };
  } catch {
    return null;
  }
}

async function handleNativeUrl(rawUrl) {
  const value = String(rawUrl || '');

  try {
    const hosted = new URL(value);
    if (hosted.origin === API_ORIGIN && !hosted.pathname.startsWith('/api/')) {
      navigate(hosted.pathname + hosted.search + hosted.hash);
      return true;
    }
  } catch {}

  const callback = parseCallback(value);
  if (!callback) return false;

  if (callback.provider === 'auth' && callback.status === 'verified' && callback.token) {
    const waiter = humanChallengeWaiter;
    humanChallengeWaiter = null;
    waiter?.resolve?.(callback.token);
    try { await Browser.close(); } catch {}
    return true;
  }

  try { await Browser.close(); } catch {}

  window.dispatchEvent(new CustomEvent('questlog:native-oauth', { detail: callback }));

  if (callback.provider === 'google' && callback.status === 'connected') {
    navigate('/?view=settings&calendar=connected&source=native');
  }

  return true;
}

async function savePushRegistration(token) {
  const value = String(token || '').trim();
  if (!value) return;
  nativePushToken = value;
  localStorage.setItem(PUSH_TOKEN_KEY, value);
  localStorage.setItem(PUSH_PLATFORM_KEY, platform());
  await nativeApi('/api/notifications/native/register', {
    method: 'POST',
    body: JSON.stringify({ token: value, platform: platform() })
  });
}

async function ensurePushListeners() {
  if (!isNative() || pushListenersReady) return;
  pushListenersReady = true;

  await PushNotifications.addListener('registration', token => {
    savePushRegistration(token.value)
      .then(() => registrationWaiter?.resolve?.(token.value))
      .catch(error => registrationWaiter?.reject?.(error))
      .finally(() => { registrationWaiter = null; });
  });

  await PushNotifications.addListener('registrationError', error => {
    registrationWaiter?.reject?.(new Error(error?.error || 'Native push registration failed.'));
    registrationWaiter = null;
  });

  await PushNotifications.addListener('pushNotificationReceived', notification => {
    window.dispatchEvent(new CustomEvent('questlog:native-push', {
      detail: { type: 'received', notification }
    }));
  });

  await PushNotifications.addListener('pushNotificationActionPerformed', action => {
    const notification = action?.notification || {};
    const route = notification?.data?.url || notification?.link || '/?view=today';
    openPushRoute(route);
  });
}

async function createAndroidChannel() {
  if (platform() !== 'android') return;
  try {
    await PushNotifications.createChannel({
      id: 'questlog-updates',
      name: 'Quest Log',
      description: 'Tasks, events, goals, countdowns, invites, and friend activity',
      importance: 4,
      visibility: 1,
      vibration: true
    });
  } catch {}
}

async function waitForRegistration() {
  if (registrationWaiter) return registrationWaiter.promise;
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  registrationWaiter = { promise, resolve, reject };
  await PushNotifications.register();
  return promise;
}

async function pushStatus() {
  if (!isNative()) return { supported: false, permission: 'denied', registered: false };
  await ensurePushListeners();
  const permission = await PushNotifications.checkPermissions();
  return {
    supported: true,
    permission: permission.receive,
    registered: Boolean(nativePushToken),
    token: nativePushToken,
    platform: platform()
  };
}

async function enablePush() {
  if (!isNative()) throw new Error('Native push is only available in the installed app.');
  await ensurePushListeners();
  await createAndroidChannel();

  let permission = await PushNotifications.checkPermissions();
  if (permission.receive === 'prompt' || permission.receive === 'prompt-with-rationale') {
    permission = await PushNotifications.requestPermissions();
  }
  if (permission.receive !== 'granted') throw new Error('Notification permission was not granted.');

  const token = await waitForRegistration();
  return { permission: permission.receive, registered: Boolean(token), token, platform: platform() };
}

async function refreshPushRegistration() {
  if (!isNative()) return;
  await ensurePushListeners();
  const permission = await PushNotifications.checkPermissions();
  if (permission.receive !== 'granted') return;
  await createAndroidChannel();
  try { await PushNotifications.register(); } catch {}
}

async function disablePush() {
  if (!isNative()) return;
  const token = nativePushToken || localStorage.getItem(PUSH_TOKEN_KEY) || '';
  if (token) {
    await nativeApi('/api/notifications/native/unregister', {
      method: 'POST',
      body: JSON.stringify({ token, platform: platform() })
    }).catch(() => {});
  }
  await PushNotifications.unregister().catch(() => {});
  nativePushToken = '';
  localStorage.removeItem(PUSH_TOKEN_KEY);
  localStorage.removeItem(PUSH_PLATFORM_KEY);
}

async function testPush() {
  const token = nativePushToken || localStorage.getItem(PUSH_TOKEN_KEY) || '';
  if (!token) throw new Error('Enable notifications on this device first.');
  return nativeApi('/api/notifications/native/test', {
    method: 'POST',
    body: JSON.stringify({ token, platform: platform() })
  });
}

async function syncStatusBar() {
  if (!isNative()) return;
  const dark = document.documentElement.dataset.colorMode === 'dark';
  await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {});
}

async function initializeNative() {
  if (!isNative()) return;
  document.documentElement.dataset.nativeApp = '1';
  await syncStatusBar();

  const appearanceObserver = new MutationObserver(() => { syncStatusBar().catch(() => {}); });
  appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-mode'] });

  await App.addListener('appUrlOpen', event => {
    handleNativeUrl(event.url).catch(() => {});
  });

  await Browser.addListener('browserFinished', () => {
    if (!humanChallengeWaiter) return;
    const waiter = humanChallengeWaiter;
    setTimeout(() => {
      if (humanChallengeWaiter !== waiter) return;
      humanChallengeWaiter = null;
      waiter.reject(new Error('Human verification was cancelled.'));
    }, 750);
  });

  try {
    const launch = await App.getLaunchUrl();
    if (launch?.url) await handleNativeUrl(launch.url);
  } catch {}

  await ensurePushListeners();
  refreshPushRegistration().catch(() => {});
}

window.QuestLogNative = {
  get isNative() { return isNative(); },
  get platform() { return platform(); },
  version: APP_VERSION,
  apiOrigin: API_ORIGIN,
  callbackScheme: CALLBACK_SCHEME,
  apiUrl,
  localRoute,
  navigate,
  diagnostics,
  request,
  openAuthUrl,
  openExternalUrl,
  verifyHuman,
  handleNativeUrl,
  syncStatusBar,
  push: {
    status: pushStatus,
    enable: enablePush,
    disable: disablePush,
    test: testPush,
    refresh: refreshPushRegistration
  }
};

initializeNative().catch(() => {});
