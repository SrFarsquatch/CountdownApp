import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { PushNotifications } from '@capacitor/push-notifications';

const API_ORIGIN = 'https://questlog.mattmoonie.ca';
const CALLBACK_SCHEME = 'questlog://';
const PUSH_TOKEN_KEY = 'questlog.native.push.token';
const PUSH_PLATFORM_KEY = 'questlog.native.push.platform';

let nativePushToken = localStorage.getItem(PUSH_TOKEN_KEY) || '';
let pushListenersReady = false;
let registrationWaiter = null;

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

async function nativeApi(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Native request failed.');
  return data;
}

async function openAuthUrl(url) {
  const target = String(url || '');
  if (!target.startsWith('https://')) throw new Error('Native authentication URL must use HTTPS.');
  await Browser.open({ url: target });
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
  location.replace(route);
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
    location.replace('/?view=settings&calendar=connected&source=native');
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

async function initializeNative() {
  if (!isNative()) return;
  document.documentElement.dataset.nativeApp = '1';

  await App.addListener('appUrlOpen', event => {
    handleNativeUrl(event.url).catch(() => {});
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
  apiOrigin: API_ORIGIN,
  callbackScheme: CALLBACK_SCHEME,
  apiUrl,
  openAuthUrl,
  handleNativeUrl,
  push: {
    status: pushStatus,
    enable: enablePush,
    disable: disablePush,
    test: testPush,
    refresh: refreshPushRegistration
  }
};

initializeNative().catch(() => {};
