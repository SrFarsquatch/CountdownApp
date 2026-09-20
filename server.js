const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH = path.join(DATA_DIR, 'countdown-data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const APP_SECRET = process.env.APP_SECRET || '';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const TARGET_CONTAINER = process.env.TARGET_CONTAINER || 'countdownapp';
const TARGET_IMAGE = process.env.TARGET_IMAGE || 'ghcr.io/srfarsquatch/countdownapp:edge';
const UPDATE_STATUS_PATH = path.join(DATA_DIR, 'update-status.json');
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';

const COLORS = ['black', 'red', 'blue', 'green', 'yellow', 'purple'];
const PROGRESS_MODES = ['time', 'manual', 'none'];
const PROGRESS_STYLES = ['solid', 'segmented', 'thin'];
const DATE_STYLES = ['short', 'medium', 'long', 'numeric'];
const TIME_STYLES = ['days', 'compact', 'full', 'precise', 'weeks', 'date'];
const LAYOUTS = ['auto', 'landscape', 'portrait'];
const PALETTES = ['spectra6', 'mono'];
const DATE_WIDGETS = ['flipper', 'plain'];
const DISPLAY_MODES = ['dashboard', 'daily', 'countdowns'];
const TASK_STATUS = ['todo', 'progress', 'done'];
const TASK_PRIORITY = ['low', 'medium', 'high', 'urgent'];
const GOAL_TYPES = ['number', 'checklist', 'deadline'];
const GOAL_STATUS = ['active', 'complete', 'paused'];
const HEX = {
  black: '#111111', red: '#d62828', blue: '#1769aa', green: '#2f7d32',
  yellow: '#e0a800', purple: '#6d4aff'
};

fs.mkdirSync(DATA_DIR, { recursive: true });
const id = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const iso = value => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const en = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
}[char]));
const cleanText = (value, max = 500) => String(value || '').trim().slice(0, max);

function defaults() {
  return {
    countdowns: [],
    tasks: [],
    goals: [],
    google: { accounts: [], countdownWindowDays: 30 },
    display: {
      token: crypto.randomBytes(24).toString('hex'),
      title: 'Today', maxEvents: 5, maxCountdowns: 3, maxTasks: 6, maxGoals: 3,
      layout: 'auto', palette: 'spectra6', dateWidgetStyle: 'plain', mode: 'dashboard',
      refreshMinutes: 15, showAgenda: true, showTasks: true, showGoals: true, showCountdowns: true
    }
  };
}

function normalizeCountdown(x = {}) {
  const created = iso(x.created) || new Date().toISOString();
  return {
    id: String(x.id || id()), name: cleanText(x.name || 'Countdown', 100),
    end: iso(x.end) || new Date(Date.now() + 86400000).toISOString(), created,
    accentColor: en(x.accentColor, COLORS, 'black'),
    progressMode: en(x.progressMode, PROGRESS_MODES, 'time'),
    progressStyle: en(x.progressStyle, PROGRESS_STYLES, 'solid'),
    progressStart: iso(x.progressStart) || created,
    progressCurrent: num(x.progressCurrent, 0), progressTotal: Math.max(0, num(x.progressTotal, 100)),
    dateDisplayStyle: en(x.dateDisplayStyle, DATE_STYLES, 'medium'),
    timeDisplayStyle: en(x.timeDisplayStyle, TIME_STYLES, 'days'),
    showExactDate: x.showExactDate !== false, showProgressBar: x.showProgressBar !== false,
    displayEnabled: x.displayEnabled !== false, pinned: Boolean(x.pinned),
    goalId: x.goalId ? String(x.goalId) : ''
  };
}

function normalizeSubtask(x = {}) {
  return { id: String(x.id || id()), title: cleanText(x.title || 'Subtask', 140), done: Boolean(x.done) };
}

function normalizeTask(x = {}) {
  const created = iso(x.created) || new Date().toISOString();
  const status = en(x.status, TASK_STATUS, 'todo');
  return {
    id: String(x.id || id()), title: cleanText(x.title || 'Task', 160),
    description: cleanText(x.description, 2000), status,
    priority: en(x.priority, TASK_PRIORITY, 'medium'), due: iso(x.due), start: iso(x.start),
    estimatedMinutes: clamp(num(x.estimatedMinutes, 0), 0, 100000),
    project: cleanText(x.project, 80), goalId: x.goalId ? String(x.goalId) : '',
    tags: Array.isArray(x.tags) ? x.tags.map(v => cleanText(v, 40)).filter(Boolean).slice(0, 12) : [],
    subtasks: Array.isArray(x.subtasks) ? x.subtasks.map(normalizeSubtask).slice(0, 50) : [],
    created, completedAt: status === 'done' ? (iso(x.completedAt) || new Date().toISOString()) : null,
    displayEnabled: x.displayEnabled !== false
  };
}

function normalizeGoal(x = {}) {
  const created = iso(x.created) || new Date().toISOString();
  const checklist = Array.isArray(x.checklist) ? x.checklist.map(normalizeSubtask).slice(0, 100) : [];
  return {
    id: String(x.id || id()), title: cleanText(x.title || 'Goal', 160),
    description: cleanText(x.description, 2000), type: en(x.type, GOAL_TYPES, 'number'),
    current: num(x.current, 0), target: Math.max(0, num(x.target, 100)), unit: cleanText(x.unit, 30),
    deadline: iso(x.deadline), project: cleanText(x.project, 80),
    status: en(x.status, GOAL_STATUS, 'active'), accentColor: en(x.accentColor, COLORS, 'purple'),
    checklist, created, updated: iso(x.updated) || new Date().toISOString(), displayEnabled: x.displayEnabled !== false
  };
}

function normalizeGoogleAccount(x = {}) {
  return {
    id: String(x.id || id()),
    googleId: cleanText(x.googleId, 240),
    label: cleanText(x.label || x.googleId || 'Google account', 160),
    token: typeof x.token === 'string' ? x.token : null,
    selectedCalendarIds: Array.isArray(x.selectedCalendarIds) ? x.selectedCalendarIds.map(String).slice(0, 50) : [],
    connectedAt: iso(x.connectedAt) || new Date().toISOString()
  };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    const base = defaults();
    const legacyGoogle = parsed.google || {};
    let accounts = Array.isArray(legacyGoogle.accounts) ? legacyGoogle.accounts.map(normalizeGoogleAccount) : [];
    if (!accounts.length && legacyGoogle.token) {
      accounts = [normalizeGoogleAccount({
        id: 'legacy',
        label: 'Google account',
        token: legacyGoogle.token,
        selectedCalendarIds: legacyGoogle.selectedCalendarIds || [],
        connectedAt: new Date().toISOString()
      })];
    }
    return {
      ...base, ...parsed,
      countdowns: Array.isArray(parsed.countdowns) ? parsed.countdowns.map(normalizeCountdown) : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map(normalizeTask) : [],
      goals: Array.isArray(parsed.goals) ? parsed.goals.map(normalizeGoal) : [],
      google: {
        accounts,
        countdownWindowDays: clamp(num(legacyGoogle.countdownWindowDays, 30), 1, 365)
      },
      display: { ...base.display, ...(parsed.display || {}) }
    };
  } catch {
    const data = defaults();
    save(data);
    return data;
  }
}

function save(data) {
  const temp = DB_PATH + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, DB_PATH);
}

let db = load();

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(payload));
}
function text(res, status, payload, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}
function body(req) {
  return new Promise((resolve, reject) => {
    let source = '';
    req.on('data', chunk => {
      source += chunk;
      if (source.length > 1048576) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(source ? JSON.parse(source) : {}); }
      catch { reject(new Error('Invalid JSON request.')); }
    });
    req.on('error', reject);
  });
}

function key() { return APP_SECRET ? crypto.createHash('sha256').update(APP_SECRET).digest() : null; }
function encrypt(value) {
  const k = key();
  if (!k) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(x => x.toString('base64url')).join('.');
}
function decrypt(value) {
  const k = key();
  if (!value || !k) return null;
  try {
    const [i, t, d] = value.split('.');
    const cipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(i, 'base64url'));
    cipher.setAuthTag(Buffer.from(t, 'base64url'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(d, 'base64url')), cipher.final()]).toString('utf8'));
  } catch { return null; }
}
function base(req) {
  if (APP_BASE_URL) return APP_BASE_URL;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return proto + '://' + host;
}
const googleConfigured = () => Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && APP_SECRET);
function makeOauthState() {
  const issued = Date.now().toString(36);
  const nonce = crypto.randomBytes(18).toString('base64url');
  const payload = issued + '.' + nonce;
  const signature = crypto.createHmac('sha256', APP_SECRET).update(payload).digest('base64url');
  return payload + '.' + signature;
}
function validOauthState(value) {
  try {
    const parts = String(value || '').split('.');
    if (parts.length !== 3) return false;
    const [issued, nonce, signature] = parts;
    if (!issued || !nonce || !signature) return false;
    const timestamp = parseInt(issued, 36);
    if (!Number.isFinite(timestamp) || Date.now() - timestamp < 0 || Date.now() - timestamp > 10 * 60 * 1000) return false;
    const payload = issued + '.' + nonce;
    const expected = crypto.createHmac('sha256', APP_SECRET).update(payload).digest('base64url');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function updaterConfigured() {
  try { fs.accessSync(DOCKER_SOCKET, fs.constants.R_OK | fs.constants.W_OK); return true; }
  catch { return false; }
}
function updateStatus() {
  try { return { configured: updaterConfigured(), ...JSON.parse(fs.readFileSync(UPDATE_STATUS_PATH, 'utf8')) }; }
  catch {
    return {
      configured: updaterConfigured(), phase: 'idle',
      message: updaterConfigured() ? 'Ready to update' : 'Updater unavailable: Docker socket is not mounted',
      startedAt: null, finishedAt: null, error: null
    };
  }
}
function dockerRaw(method, endpoint, payload) {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    const request = http.request({
      socketPath: DOCKER_SOCKET, path: endpoint, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}
    }, response => {
      const chunks = [];
      response.on('data', x => chunks.push(x));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve({ status: response.statusCode, raw });
        reject(new Error('Docker API ' + method + ' ' + endpoint + ' failed (' + response.statusCode + '): ' + raw.slice(0, 300)));
      });
    });
    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  });
}
async function dockerApiVersion() {
  const response = await dockerRaw('GET', '/version');
  const data = JSON.parse(response.raw);
  return data.ApiVersion ? '/v' + data.ApiVersion : '';
}
async function launchUpdater() {
  if (!updaterConfigured()) throw new Error('Docker socket is not available. Re-import the latest CasaOS compose file.');
  const version = await dockerApiVersion();
  const name = 'countdownapp-update-' + Date.now().toString(36);
  const config = {
    Image: TARGET_IMAGE, Cmd: ['node', '/app/updater.js', '--once'],
    Env: ['RUN_ONCE=1', 'TARGET_CONTAINER=' + TARGET_CONTAINER, 'TARGET_IMAGE=' + TARGET_IMAGE, 'DATA_DIR=/data', 'DOCKER_SOCKET=/var/run/docker.sock'],
    HostConfig: { AutoRemove: true, Binds: ['/var/run/docker.sock:/var/run/docker.sock', '/DATA/AppData/countdownapp/data:/data'] }
  };
  await dockerRaw('POST', version + '/containers/create?name=' + encodeURIComponent(name), config);
  await dockerRaw('POST', version + '/containers/' + encodeURIComponent(name) + '/start');
  return { name };
}

async function exchange(code, req) {
  const payload = new URLSearchParams({
    code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: base(req) + '/api/google/callback', grant_type: 'authorization_code'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: payload
  });
  if (!response.ok) throw new Error('Google token exchange failed: ' + (await response.text()).slice(0, 180));
  return response.json();
}
function googleAccounts() {
  return Array.isArray(db.google.accounts) ? db.google.accounts : [];
}
function googleAccount(accountId) {
  return googleAccounts().find(account => account.id === accountId) || null;
}
function accountCanWrite(account) {
  const token = account ? decrypt(account.token) : null;
  const scopes = String(token?.scope || '').split(/\s+/).filter(Boolean);
  return scopes.includes('https://www.googleapis.com/auth/calendar.events') ||
    scopes.includes('https://www.googleapis.com/auth/calendar');
}
async function accessToken(accountOrId) {
  const account = typeof accountOrId === 'string' ? googleAccount(accountOrId) : accountOrId;
  if (!account) return null;
  const token = decrypt(account.token);
  if (!token) return null;
  if (token.access_token && token.expires_at && Date.now() < token.expires_at - 60000) return token.access_token;
  if (!token.refresh_token) return null;
  const payload = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: token.refresh_token, grant_type: 'refresh_token'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: payload
  });
  if (!response.ok) return null;
  const next = await response.json();
  const merged = { ...token, ...next, refresh_token: token.refresh_token, expires_at: Date.now() + num(next.expires_in, 3600) * 1000 };
  account.token = encrypt(merged);
  save(db);
  return merged.access_token;
}
async function googleFetchWithAccess(access, endpoint) {
  const response = await fetch('https://www.googleapis.com/calendar/v3' + endpoint, { headers: { Authorization: 'Bearer ' + access } });
  if (!response.ok) throw new Error('Google Calendar request failed: ' + (await response.text()).slice(0, 180));
  return response.json();
}
async function googleRequest(accountOrId, endpoint, method = 'GET', payload) {
  const account = typeof accountOrId === 'string' ? googleAccount(accountOrId) : accountOrId;
  const access = await accessToken(account);
  if (!account || !access) throw new Error('Google Calendar account is not connected.');
  const hasBody = payload !== undefined && payload !== null;
  const response = await fetch('https://www.googleapis.com/calendar/v3' + endpoint, {
    method,
    headers: { Authorization: 'Bearer ' + access, ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
    body: hasBody ? JSON.stringify(payload) : undefined
  });
  if (response.status === 204) return null;
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  if (!response.ok) {
    const detail = data?.error?.message || raw.slice(0, 180) || ('HTTP ' + response.status);
    throw new Error('Google Calendar request failed: ' + detail);
  }
  return data;
}
async function gfetch(accountOrId, endpoint) {
  return googleRequest(accountOrId, endpoint, 'GET');
}
function accountLabelFromCalendars(items = []) {
  const primary = items.find(calendar => calendar.primary) || items[0];
  if (!primary) return { googleId: '', label: 'Google account' };
  const googleId = cleanText(primary.id, 240);
  const summary = cleanText(primary.summary, 160);
  const label = summary && summary !== googleId ? summary + ' (' + googleId + ')' : (googleId || summary || 'Google account');
  return { googleId, label };
}
async function calendarListForAccount(account) {
  let out = [], pageToken = '';
  do {
    const query = new URLSearchParams({ maxResults: '250' });
    if (pageToken) query.set('pageToken', pageToken);
    const data = await gfetch(account, '/users/me/calendarList?' + query);
    out.push(...(data.items || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  const identity = accountLabelFromCalendars(out);
  let changed = false;
  if (identity.googleId && account.googleId !== identity.googleId) { account.googleId = identity.googleId; changed = true; }
  if (identity.label && account.label !== identity.label) { account.label = identity.label; changed = true; }
  if (changed) save(db);
  return out;
}
async function calendars(accountId) {
  const account = googleAccount(accountId);
  if (!account) throw new Error('Google account was not found.');
  const out = await calendarListForAccount(account);
  return out.map(c => ({
    id: c.id, summary: c.summary, primary: Boolean(c.primary),
    backgroundColor: c.backgroundColor || '', foregroundColor: c.foregroundColor || '',
    accessRole: c.accessRole || 'reader'
  }));
}
async function eventColors(account) {
  try {
    const data = await gfetch(account, '/colors');
    return data.event || {};
  } catch {
    return {};
  }
}
async function writableCalendar(account, calendarId) {
  const entry = await gfetch(account, '/users/me/calendarList/' + encodeURIComponent(calendarId));
  const role = entry?.accessRole || 'reader';
  if (!['writer', 'owner'].includes(role)) throw new Error('This calendar is read-only in Google Calendar.');
  return entry;
}
function dateOnly(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}
function addDateOnlyDays(value, days) {
  const d = new Date(value + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function googleEventPayload(incoming = {}, allowRecurrence = false) {
  const summary = cleanText(incoming.title || incoming.summary, 500);
  if (!summary) throw new Error('Event title is required.');
  const allDay = Boolean(incoming.allDay);
  let start, end;
  if (allDay) {
    const startDate = dateOnly(incoming.startDate);
    const inclusiveEnd = dateOnly(incoming.endDate || incoming.startDate);
    if (!startDate || !inclusiveEnd || inclusiveEnd < startDate) throw new Error('Valid all-day start and end dates are required.');
    start = { date: startDate };
    end = { date: addDateOnlyDays(inclusiveEnd, 1) };
  } else {
    const startIso = iso(incoming.start);
    const endIso = iso(incoming.end);
    if (!startIso || !endIso || new Date(endIso) <= new Date(startIso)) throw new Error('Event end time must be after its start time.');
    start = { dateTime: startIso };
    end = { dateTime: endIso };
  }
  const payload = {
    summary,
    description: cleanText(incoming.description, 8000),
    location: cleanText(incoming.location, 1000),
    start, end,
    transparency: incoming.transparency === 'transparent' ? 'transparent' : 'opaque'
  };
  if (allowRecurrence) {
    const freq = en(String(incoming.repeat || 'none').toLowerCase(), ['none', 'daily', 'weekly', 'monthly', 'yearly'], 'none');
    if (freq !== 'none') payload.recurrence = ['RRULE:FREQ=' + freq.toUpperCase()];
  }
  return payload;
}
async function identifyGoogleToken(token) {
  if (!token?.access_token) return { googleId: '', label: 'Google account' };
  const query = new URLSearchParams({ maxResults: '250' });
  const data = await googleFetchWithAccess(token.access_token, '/users/me/calendarList?' + query);
  return accountLabelFromCalendars(data.items || []);
}
async function eventsBetween(from, to) {
  const accounts = googleAccounts().filter(account => account.token && account.selectedCalendarIds.length);
  if (!accounts.length) return [];
  const min = from ? new Date(from) : new Date();
  const max = to ? new Date(to) : new Date(min.getTime() + clamp(num(db.google.countdownWindowDays, 30), 1, 365) * 86400000);
  if (Number.isNaN(min.getTime()) || Number.isNaN(max.getTime()) || max <= min) throw new Error('Invalid calendar date range.');
  if (max - min > 370 * 86400000) throw new Error('Calendar range is too large.');
  const out = [];
  const seen = new Set();
  for (const account of accounts) {
    const [calendarItems, colors] = await Promise.all([
      calendarListForAccount(account),
      eventColors(account)
    ]);
    const calendarMap = new Map(calendarItems.map(calendar => [calendar.id, calendar]));
    for (const calendarId of account.selectedCalendarIds) {
      const calendar = calendarMap.get(calendarId) || {};
      const query = new URLSearchParams({ timeMin: min.toISOString(), timeMax: max.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
      const data = await gfetch(account, '/calendars/' + encodeURIComponent(calendarId) + '/events?' + query);
      for (const event of data.items || []) {
        if (event.status === 'cancelled') continue;
        const start = event.start?.dateTime || event.start?.date;
        if (!start) continue;
        const dedupeKey = calendarId + '|' + event.id + '|' + start;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const specificColor = event.colorId ? colors[event.colorId] : null;
        out.push({
          id: event.id, calendarId, accountId: account.id, accountLabel: account.label,
          calendarName: calendar.summary || 'Calendar',
          accessRole: calendar.accessRole || 'reader',
          calendarColor: calendar.backgroundColor || '#6c5ce7',
          calendarForeground: calendar.foregroundColor || '#ffffff',
          eventColor: specificColor?.background || '',
          eventForeground: specificColor?.foreground || '',
          colorId: event.colorId || '',
          title: event.summary || 'Busy', description: event.description || '', start,
          end: event.end?.dateTime || event.end?.date || start, allDay: Boolean(event.start?.date),
          transparency: event.transparency || 'opaque',
          recurringEventId: event.recurringEventId || '', recurrence: event.recurrence || [],
          location: event.location || '', htmlLink: event.htmlLink || ''
        });
      }
    }
  }
  out.sort((a, b) => new Date(a.start) - new Date(b.start));
  return out;
}
async function events() { return eventsBetween(); }

function sortedCountdowns() {
  return [...db.countdowns].sort((a, b) => a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : new Date(a.end) - new Date(b.end));
}
function sortedTasks() {
  const priority = { urgent: 0, high: 1, medium: 2, low: 3 };
  return [...db.tasks].sort((a, b) => {
    if ((a.status === 'done') !== (b.status === 'done')) return a.status === 'done' ? 1 : -1;
    const ad = a.due ? new Date(a.due).getTime() : Number.MAX_SAFE_INTEGER;
    const bd = b.due ? new Date(b.due).getTime() : Number.MAX_SAFE_INTEGER;
    if (ad !== bd) return ad - bd;
    return priority[a.priority] - priority[b.priority];
  });
}
function goalProgress(goal) {
  if (goal.type === 'checklist') {
    if (!goal.checklist.length) return 0;
    return clamp(goal.checklist.filter(x => x.done).length / goal.checklist.length * 100, 0, 100);
  }
  if (goal.type === 'deadline') {
    const start = new Date(goal.created).getTime();
    const end = goal.deadline ? new Date(goal.deadline).getTime() : start;
    if (!Number.isFinite(end) || end <= start) return goal.status === 'complete' ? 100 : 0;
    return clamp((Date.now() - start) / (end - start) * 100, 0, 100);
  }
  return clamp(goal.target > 0 ? goal.current / goal.target * 100 : 0, 0, 100);
}
function countdownProgress(c, now = Date.now()) {
  if (!c.showProgressBar || c.progressMode === 'none') return null;
  if (c.progressMode === 'manual') return clamp(c.progressTotal > 0 ? c.progressCurrent / c.progressTotal * 100 : 0, 0, 100);
  const start = new Date(c.progressStart || c.created).getTime();
  const end = new Date(c.end).getTime();
  if (!Number.isFinite(start) || end <= start) return 0;
  return clamp((now - start) / (end - start) * 100, 0, 100);
}
function countdownView(c, now = Date.now()) {
  const ms = new Date(c.end).getTime() - now;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return {
    ...c, expired: ms <= 0, secondsRemaining: seconds,
    daysRemaining: Math.max(0, Math.ceil(ms / 86400000)),
    remaining: { days, hours, minutes, seconds: seconds % 60 }, progress: countdownProgress(c, now)
  };
}
function dueForDisplay(task) {
  if (task.status === 'done' || task.displayEnabled === false) return false;
  if (!task.due) return true;
  return new Date(task.due).getTime() < Date.now() + 14 * 86400000;
}
async function feed() {
  let ev = [], calendarError = null;
  if (googleAccounts().some(account => account.token && account.selectedCalendarIds.length)) {
    try { ev = await events(); }
    catch (error) { calendarError = error.message; }
  }
  const now = Date.now();
  const countdowns = sortedCountdowns()
    .filter(c => c.displayEnabled && new Date(c.end).getTime() > now)
    .slice(0, clamp(num(db.display.maxCountdowns, 3), 1, 20)).map(c => countdownView(c, now));
  const tasks = sortedTasks().filter(dueForDisplay).slice(0, clamp(num(db.display.maxTasks, 6), 1, 20));
  const goals = db.goals.filter(g => g.status === 'active' && g.displayEnabled !== false)
    .sort((a, b) => (a.deadline ? new Date(a.deadline).getTime() : Number.MAX_SAFE_INTEGER) - (b.deadline ? new Date(b.deadline).getTime() : Number.MAX_SAFE_INTEGER))
    .slice(0, clamp(num(db.display.maxGoals, 3), 1, 20)).map(g => ({ ...g, progress: goalProgress(g) }));
  return {
    generatedAt: new Date().toISOString(), title: db.display.title || 'Today', calendarError,
    nextEvent: ev[0] || null,
    events: db.display.showAgenda === false ? [] : ev.slice(0, clamp(num(db.display.maxEvents, 5), 1, 20)),
    tasks: db.display.showTasks === false ? [] : tasks,
    goals: db.display.showGoals === false ? [] : goals,
    countdowns: db.display.showCountdowns === false ? [] : countdowns,
    display: {
      layout: en(db.display.layout, LAYOUTS, 'auto'), palette: en(db.display.palette, PALETTES, 'spectra6'),
      dateWidgetStyle: en(db.display.dateWidgetStyle, DATE_WIDGETS, 'plain'), mode: en(db.display.mode, DISPLAY_MODES, 'dashboard'),
      refreshMinutes: clamp(num(db.display.refreshMinutes, 15), 1, 1440),
      showAgenda: db.display.showAgenda !== false, showTasks: db.display.showTasks !== false,
      showGoals: db.display.showGoals !== false, showCountdowns: db.display.showCountdowns !== false
    }
  };
}

function color(name, palette) { return palette === 'mono' ? '#111111' : (HEX[name] || HEX.black); }
function formatDateServer(value, style) {
  const d = new Date(value);
  if (style === 'numeric') return d.toLocaleDateString('en-CA');
  if (style === 'short') return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  if (style === 'long') return d.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}
function timeLabel(c) {
  const r = c.remaining;
  if (c.timeDisplayStyle === 'date') return formatDateServer(c.end, c.dateDisplayStyle);
  if (c.timeDisplayStyle === 'weeks') {
    const weeks = Math.floor(r.days / 7), days = r.days % 7;
    return weeks + 'w ' + days + 'd';
  }
  if (c.timeDisplayStyle === 'compact') return r.days + 'd ' + String(r.hours).padStart(2, '0') + 'h';
  if (c.timeDisplayStyle === 'full') return r.days + 'd ' + String(r.hours).padStart(2, '0') + 'h ' + String(r.minutes).padStart(2, '0') + 'm';
  if (c.timeDisplayStyle === 'precise') return r.days + 'd ' + String(r.hours).padStart(2, '0') + 'h ' + String(r.minutes).padStart(2, '0') + 'm ' + String(r.seconds || 0).padStart(2, '0') + 's';
  return c.daysRemaining + ' ' + (c.daysRemaining === 1 ? 'day' : 'days');
}
function svgBar(percent, x, y, width, height, fill) {
  const p = clamp(num(percent, 0), 0, 100);
  return '<rect x="' + x + '" y="' + y + '" width="' + width + '" height="' + height + '" rx="' + height / 2 + '" fill="#deded8"/>' +
    '<rect x="' + x + '" y="' + y + '" width="' + (width * p / 100).toFixed(1) + '" height="' + height + '" rx="' + height / 2 + '" fill="' + fill + '"/>';
}
function sectionTitle(label, x, y) {
  return '<text x="' + x + '" y="' + y + '" class="k">' + esc(label) + '</text>';
}
function renderSvg(data, w, h) {
  const palette = data.display.palette;
  const portrait = data.display.layout === 'portrait' || (data.display.layout === 'auto' && h > w);
  const pad = Math.max(18, Math.round(Math.min(w, h) * 0.045));
  const black = '#111111', muted = '#666660', rule = '#c9c9c2';
  const now = new Date();
  const dateText = now.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"><rect width="100%" height="100%" fill="#ffffff"/><style>text{font-family:Arial,Helvetica,sans-serif}.k{font-size:11px;font-weight:700;letter-spacing:1.5px}.muted{fill:' + muted + '}.line{stroke:' + rule + ';stroke-width:1}</style>';

  svg += '<text x="' + pad + '" y="' + (pad + 18) + '" font-size="18" font-weight="800">' + esc(dateText) + '</text>';
  svg += '<text x="' + (w - pad) + '" y="' + (pad + 18) + '" text-anchor="end" font-size="' + (portrait ? 22 : 26) + '" font-weight="800">' + esc(data.title) + '</text>';
  svg += '<line x1="' + pad + '" y1="' + (pad + 34) + '" x2="' + (w - pad) + '" y2="' + (pad + 34) + '" class="line"/>';

  const sections = [];
  if (data.display.mode === 'countdowns') {
    sections.push('countdowns');
  } else {
    if (data.events.length) sections.push('agenda');
    if (data.tasks.length) sections.push('tasks');
    if (data.goals.length) sections.push('goals');
    if (data.countdowns.length) sections.push('countdowns');
  }
  if (!sections.length) sections.push('empty');

  function drawSection(kind, x, y, width, maxHeight) {
    let cursor = y;
    if (kind === 'empty') {
      svg += '<text x="' + x + '" y="' + (cursor + 28) + '" font-size="18" class="muted">Nothing scheduled.</text>';
      return maxHeight;
    }
    const label = { agenda: 'AGENDA', tasks: 'TASKS', goals: 'GOALS', countdowns: 'COUNTDOWNS' }[kind];
    svg += sectionTitle(label, x, cursor + 11);
    cursor += 22;
    if (kind === 'agenda') {
      for (const event of data.events) {
        if (cursor + 34 > y + maxHeight) break;
        const d = new Date(event.start);
        const when = event.allDay ? d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
        svg += '<line x1="' + x + '" y1="' + cursor + '" x2="' + (x + width) + '" y2="' + cursor + '" class="line"/>';
        svg += '<text x="' + x + '" y="' + (cursor + 20) + '" font-size="14" font-weight="700">' + esc(event.title) + '</text>';
        svg += '<text x="' + (x + width) + '" y="' + (cursor + 20) + '" text-anchor="end" font-size="12" class="muted">' + esc(when) + '</text>';
        cursor += 32;
      }
    }
    if (kind === 'tasks') {
      for (const task of data.tasks) {
        if (cursor + 29 > y + maxHeight) break;
        const due = task.due ? new Date(task.due).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '';
        svg += '<line x1="' + x + '" y1="' + cursor + '" x2="' + (x + width) + '" y2="' + cursor + '" class="line"/>';
        svg += '<rect x="' + x + '" y="' + (cursor + 9) + '" width="10" height="10" rx="2" fill="#fff" stroke="' + black + '"/>';
        svg += '<text x="' + (x + 18) + '" y="' + (cursor + 19) + '" font-size="13" font-weight="700">' + esc(task.title) + '</text>';
        if (due) svg += '<text x="' + (x + width) + '" y="' + (cursor + 19) + '" text-anchor="end" font-size="11" class="muted">' + esc(due) + '</text>';
        cursor += 28;
      }
    }
    if (kind === 'goals') {
      for (const goal of data.goals) {
        if (cursor + 47 > y + maxHeight) break;
        const accent = color(goal.accentColor, palette);
        svg += '<text x="' + x + '" y="' + (cursor + 15) + '" font-size="13" font-weight="700">' + esc(goal.title) + '</text>';
        svg += '<text x="' + (x + width) + '" y="' + (cursor + 15) + '" text-anchor="end" font-size="12" font-weight="700">' + Math.round(goal.progress) + '%</text>';
        svg += svgBar(goal.progress, x, cursor + 24, width, 7, accent);
        cursor += 44;
      }
    }
    if (kind === 'countdowns') {
      for (const countdown of data.countdowns) {
        if (cursor + 39 > y + maxHeight) break;
        const accent = color(countdown.accentColor, palette);
        svg += '<rect x="' + x + '" y="' + (cursor + 4) + '" width="4" height="26" rx="2" fill="' + accent + '"/>';
        svg += '<text x="' + (x + 12) + '" y="' + (cursor + 16) + '" font-size="13" font-weight="700">' + esc(countdown.name) + '</text>';
        svg += '<text x="' + (x + width) + '" y="' + (cursor + 16) + '" text-anchor="end" font-size="14" font-weight="800" fill="' + accent + '">' + esc(timeLabel(countdown)) + '</text>';
        if (countdown.showExactDate) svg += '<text x="' + (x + 12) + '" y="' + (cursor + 31) + '" font-size="10" class="muted">' + esc(formatDateServer(countdown.end, countdown.dateDisplayStyle)) + '</text>';
        cursor += 38;
      }
    }
    return cursor - y;
  }

  const top = pad + 50;
  const available = h - top - 24;
  if (portrait) {
    let y = top;
    const per = Math.max(80, Math.floor(available / sections.length));
    for (const kind of sections) {
      drawSection(kind, pad, y, w - pad * 2, per - 8);
      y += per;
      if (y > h - 28) break;
    }
  } else {
    const gap = 28;
    const columnWidth = (w - pad * 2 - gap) / 2;
    const left = sections.filter((_, i) => i % 2 === 0);
    const right = sections.filter((_, i) => i % 2 === 1);
    let y = top;
    for (const kind of left) {
      const slot = Math.max(90, available / Math.max(1, left.length));
      drawSection(kind, pad, y, columnWidth, slot - 8);
      y += slot;
    }
    y = top;
    for (const kind of right) {
      const slot = Math.max(90, available / Math.max(1, right.length));
      drawSection(kind, pad + columnWidth + gap, y, columnWidth, slot - 8);
      y += slot;
    }
  }
  svg += '<text x="' + pad + '" y="' + (h - 9) + '" font-size="9" class="muted">Updated ' + esc(new Date(data.generatedAt).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })) + '</text></svg>';
  return svg;
}

function serve(res, requestPath) {
  let file = requestPath === '/' ? '/index.html' : requestPath;
  file = path.normalize(file).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return text(res, 403, 'Forbidden');
  fs.readFile(full, (error, data) => {
    if (error) return text(res, 404, 'Not found');
    const type = {
      '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
      '.webmanifest': 'application/manifest+json; charset=utf-8'
    }[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}
const authorized = url => Boolean(url.searchParams.get('token') && url.searchParams.get('token') === db.display.token);
function state() {
  return {
    countdowns: sortedCountdowns(), tasks: sortedTasks(), goals: db.goals.map(g => ({ ...g, progress: goalProgress(g) })),
    updater: { configured: updaterConfigured() },
    options: { colors: COLORS, progressModes: PROGRESS_MODES, progressStyles: PROGRESS_STYLES, dateStyles: DATE_STYLES, timeStyles: TIME_STYLES, taskStatus: TASK_STATUS, taskPriority: TASK_PRIORITY, goalTypes: GOAL_TYPES },
    google: {
      configured: googleConfigured(),
      connected: googleAccounts().some(account => Boolean(decrypt(account.token))),
      accounts: googleAccounts().map(account => ({
        id: account.id, googleId: account.googleId, label: account.label,
        selectedCalendarIds: account.selectedCalendarIds || [], connectedAt: account.connectedAt,
        canWrite: accountCanWrite(account)
      })),
      countdownWindowDays: db.google.countdownWindowDays || 30
    },
    display: { ...db.display, feedPath: '/api/frameos/feed?token=' + db.display.token, svgPath: '/api/frameos/svg?token=' + db.display.token, viewPath: '/frame?token=' + db.display.token }
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  try {
    if (p === '/healthz') return text(res, 200, 'ok');
    if (p === '/api/state' && req.method === 'GET') return json(res, 200, state());

    if (p === '/api/countdowns' && req.method === 'POST') {
      const incoming = await body(req);
      if (!cleanText(incoming.name, 100) || !iso(incoming.end)) return json(res, 400, { error: 'Name and a valid end date are required.' });
      const item = normalizeCountdown({ ...incoming, id: id(), created: new Date().toISOString() });
      db.countdowns.push(item); save(db); return json(res, 201, item);
    }
    if (p.startsWith('/api/countdowns/') && req.method === 'PUT') {
      const itemId = decodeURIComponent(p.split('/').pop());
      const index = db.countdowns.findIndex(x => x.id === itemId);
      if (index < 0) return json(res, 404, { error: 'Not found' });
      const incoming = await body(req);
      if (!cleanText(incoming.name, 100) || !iso(incoming.end)) return json(res, 400, { error: 'Name and a valid end date are required.' });
      db.countdowns[index] = normalizeCountdown({ ...db.countdowns[index], ...incoming, id: itemId, created: db.countdowns[index].created });
      save(db); return json(res, 200, db.countdowns[index]);
    }
    if (p.startsWith('/api/countdowns/') && req.method === 'DELETE') {
      const itemId = decodeURIComponent(p.split('/').pop());
      const count = db.countdowns.length;
      db.countdowns = db.countdowns.filter(x => x.id !== itemId);
      if (count === db.countdowns.length) return json(res, 404, { error: 'Not found' });
      save(db); return json(res, 200, { ok: true });
    }

    if (p === '/api/tasks' && req.method === 'POST') {
      const incoming = await body(req);
      if (!cleanText(incoming.title, 160)) return json(res, 400, { error: 'Task title is required.' });
      const item = normalizeTask({ ...incoming, id: id(), created: new Date().toISOString() });
      db.tasks.push(item); save(db); return json(res, 201, item);
    }
    if (p.startsWith('/api/tasks/') && req.method === 'PUT') {
      const itemId = decodeURIComponent(p.split('/').pop());
      const index = db.tasks.findIndex(x => x.id === itemId);
      if (index < 0) return json(res, 404, { error: 'Not found' });
      const incoming = await body(req);
      if (incoming.title !== undefined && !cleanText(incoming.title, 160)) return json(res, 400, { error: 'Task title is required.' });
      const merged = { ...db.tasks[index], ...incoming, id: itemId, created: db.tasks[index].created };
      if (incoming.status && incoming.status !== 'done') merged.completedAt = null;
      if (incoming.status === 'done' && !merged.completedAt) merged.completedAt = new Date().toISOString();
      db.tasks[index] = normalizeTask(merged); save(db); return json(res, 200, db.tasks[index]);
    }
    if (p.startsWith('/api/tasks/') && req.method === 'DELETE') {
      const itemId = decodeURIComponent(p.split('/').pop());
      const count = db.tasks.length;
      db.tasks = db.tasks.filter(x => x.id !== itemId);
      if (count === db.tasks.length) return json(res, 404, { error: 'Not found' });
      save(db); return json(res, 200, { ok: true });
    }

    if (p === '/api/goals' && req.method === 'POST') {
      const incoming = await body(req);
      if (!cleanText(incoming.title, 160)) return json(res, 400, { error: 'Goal title is required.' });
      const item = normalizeGoal({ ...incoming, id: id(), created: new Date().toISOString(), updated: new Date().toISOString() });
      db.goals.push(item); save(db); return json(res, 201, { ...item, progress: goalProgress(item) });
    }
    if (p.startsWith('/api/goals/') && req.method === 'PUT') {
      const itemId = decodeURIComponent(p.split('/').pop());
      const index = db.goals.findIndex(x => x.id === itemId);
      if (index < 0) return json(res, 404, { error: 'Not found' });
      const incoming = await body(req);
      if (incoming.title !== undefined && !cleanText(incoming.title, 160)) return json(res, 400, { error: 'Goal title is required.' });
      db.goals[index] = normalizeGoal({ ...db.goals[index], ...incoming, id: itemId, created: db.goals[index].created, updated: new Date().toISOString() });
      save(db); return json(res, 200, { ...db.goals[index], progress: goalProgress(db.goals[index]) });
    }
    if (p.startsWith('/api/goals/') && req.method === 'DELETE') {
      const itemId = decodeURIComponent(p.split('/').pop());
      const count = db.goals.length;
      db.goals = db.goals.filter(x => x.id !== itemId);
      db.tasks = db.tasks.map(t => t.goalId === itemId ? { ...t, goalId: '' } : t);
      db.countdowns = db.countdowns.map(c => c.goalId === itemId ? { ...c, goalId: '' } : c);
      if (count === db.goals.length) return json(res, 404, { error: 'Not found' });
      save(db); return json(res, 200, { ok: true });
    }

    if (p === '/api/google/auth') {
      if (!googleConfigured()) return json(res, 400, { error: 'Google OAuth is not configured on the server.' });
      const oauthState = makeOauthState();
      const query = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID, redirect_uri: base(req) + '/api/google/callback', response_type: 'code',
        scope: SCOPES, access_type: 'offline', prompt: 'select_account consent', include_granted_scopes: 'true', state: oauthState
      });
      res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + query });
      return res.end();
    }
    if (p === '/api/google/callback') {
      if (!validOauthState(url.searchParams.get('state'))) return text(res, 400, 'Invalid or expired OAuth state. Start the Google connection again.');
      if (url.searchParams.get('error')) return text(res, 400, 'Google authorization was cancelled.');
      const token = await exchange(url.searchParams.get('code'), req);
      token.expires_at = Date.now() + num(token.expires_in, 3600) * 1000;
      const identity = await identifyGoogleToken(token);
      let account = identity.googleId ? googleAccounts().find(x => x.googleId === identity.googleId) : null;
      if (account) {
        const previous = decrypt(account.token) || {};
        if (!token.refresh_token && previous.refresh_token) token.refresh_token = previous.refresh_token;
        account.token = encrypt(token);
        account.label = identity.label || account.label;
        account.connectedAt = new Date().toISOString();
      } else {
        account = normalizeGoogleAccount({
          id: id(), googleId: identity.googleId, label: identity.label,
          token: encrypt(token), selectedCalendarIds: [], connectedAt: new Date().toISOString()
        });
        db.google.accounts.push(account);
      }
      save(db);
      res.writeHead(302, { Location: '/?view=settings&calendar=connected' });
      return res.end();
    }
    if (p === '/api/google/disconnect' && req.method === 'POST') {
      db.google.accounts = []; save(db); return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/google/accounts/') && p.endsWith('/disconnect') && req.method === 'POST') {
      const parts = p.split('/');
      const accountId = decodeURIComponent(parts[4] || '');
      const before = db.google.accounts.length;
      db.google.accounts = db.google.accounts.filter(account => account.id !== accountId);
      if (before === db.google.accounts.length) return json(res, 404, { error: 'Google account was not found.' });
      save(db); return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/google/accounts/') && p.endsWith('/calendars') && req.method === 'PUT') {
      const parts = p.split('/');
      const accountId = decodeURIComponent(parts[4] || '');
      const account = googleAccount(accountId);
      if (!account) return json(res, 404, { error: 'Google account was not found.' });
      const incoming = await body(req);
      if (!Array.isArray(incoming.calendarIds)) return json(res, 400, { error: 'calendarIds must be an array.' });
      account.selectedCalendarIds = incoming.calendarIds.map(String).slice(0, 50);
      save(db); return json(res, 200, { ok: true });
    }
    if (p === '/api/google/calendars') {
      const accountId = url.searchParams.get('accountId');
      if (!accountId) return json(res, 400, { error: 'accountId is required.' });
      return json(res, 200, { calendars: await calendars(accountId) });
    }
    const googleEventMatch = p.match(/^\/api\/google\/accounts\/([^/]+)\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (googleEventMatch) {
      const accountId = decodeURIComponent(googleEventMatch[1]);
      const calendarId = decodeURIComponent(googleEventMatch[2]);
      const eventId = googleEventMatch[3] ? decodeURIComponent(googleEventMatch[3]) : '';
      const account = googleAccount(accountId);
      if (!account) return json(res, 404, { error: 'Google account was not found.' });
      if (!accountCanWrite(account)) return json(res, 403, { error: 'Reconnect this Google account in Planner to grant event editing access.' });
      await writableCalendar(account, calendarId);

      if (req.method === 'POST' && !eventId) {
        const incoming = await body(req);
        const payload = googleEventPayload(incoming, true);
        const created = await googleRequest(account, '/calendars/' + encodeURIComponent(calendarId) + '/events?sendUpdates=all', 'POST', payload);
        return json(res, 201, { ok: true, event: created });
      }
      if ((req.method === 'PATCH' || req.method === 'PUT') && eventId) {
        const incoming = await body(req);
        const payload = googleEventPayload(incoming, false);
        const updated = await googleRequest(account, '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId) + '?sendUpdates=all', 'PATCH', payload);
        return json(res, 200, { ok: true, event: updated });
      }
      if (req.method === 'DELETE' && eventId) {
        await googleRequest(account, '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId) + '?sendUpdates=all', 'DELETE');
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'Unsupported event operation.' });
    }

    if (p === '/api/google/events') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      return json(res, 200, { events: await eventsBetween(from, to) });
    }

    if (p === '/api/settings' && req.method === 'PUT') {
      const incoming = await body(req);
      if (Array.isArray(incoming.selectedCalendarIds) && googleAccounts().length === 1) googleAccounts()[0].selectedCalendarIds = incoming.selectedCalendarIds.map(String).slice(0, 50);
      if (incoming.countdownWindowDays !== undefined) db.google.countdownWindowDays = clamp(num(incoming.countdownWindowDays, 30), 1, 365);
      if (incoming.displayTitle !== undefined) db.display.title = cleanText(incoming.displayTitle || 'Today', 80);
      if (incoming.maxEvents !== undefined) db.display.maxEvents = clamp(num(incoming.maxEvents, 5), 1, 20);
      if (incoming.maxCountdowns !== undefined) db.display.maxCountdowns = clamp(num(incoming.maxCountdowns, 3), 1, 20);
      if (incoming.maxTasks !== undefined) db.display.maxTasks = clamp(num(incoming.maxTasks, 6), 1, 20);
      if (incoming.maxGoals !== undefined) db.display.maxGoals = clamp(num(incoming.maxGoals, 3), 1, 20);
      if (incoming.layout !== undefined) db.display.layout = en(incoming.layout, LAYOUTS, 'auto');
      if (incoming.palette !== undefined) db.display.palette = en(incoming.palette, PALETTES, 'spectra6');
      if (incoming.dateWidgetStyle !== undefined) db.display.dateWidgetStyle = en(incoming.dateWidgetStyle, DATE_WIDGETS, 'plain');
      if (incoming.mode !== undefined) db.display.mode = en(incoming.mode, DISPLAY_MODES, 'dashboard');
      if (incoming.refreshMinutes !== undefined) db.display.refreshMinutes = clamp(num(incoming.refreshMinutes, 15), 1, 1440);
      if (incoming.showAgenda !== undefined) db.display.showAgenda = Boolean(incoming.showAgenda);
      if (incoming.showTasks !== undefined) db.display.showTasks = Boolean(incoming.showTasks);
      if (incoming.showGoals !== undefined) db.display.showGoals = Boolean(incoming.showGoals);
      if (incoming.showCountdowns !== undefined) db.display.showCountdowns = Boolean(incoming.showCountdowns);
      save(db); return json(res, 200, { ok: true });
    }

    if (p === '/api/update/status' && req.method === 'GET') return json(res, 200, updateStatus());
    if (p === '/api/update/start' && req.method === 'POST') {
      if (req.headers['x-countdown-action'] !== 'update') return json(res, 403, { error: 'Invalid update request' });
      const status = updateStatus();
      if (['pulling', 'preparing', 'restarting'].includes(status.phase)) return json(res, 409, { error: 'An update is already running' });
      const launched = await launchUpdater();
      return json(res, 202, { ok: true, message: 'Update started', helper: launched.name });
    }

    if (p === '/api/display/rotate-token' && req.method === 'POST') {
      db.display.token = crypto.randomBytes(24).toString('hex'); save(db);
      return json(res, 200, {
        feedPath: '/api/frameos/feed?token=' + db.display.token,
        svgPath: '/api/frameos/svg?token=' + db.display.token,
        viewPath: '/frame?token=' + db.display.token
      });
    }
    if (p === '/api/frameos/feed') {
      if (!authorized(url)) return json(res, 401, { error: 'Invalid display token' });
      return json(res, 200, await feed());
    }
    if (p === '/api/frameos/svg') {
      if (!authorized(url)) return text(res, 401, 'Invalid display token');
      const w = clamp(num(url.searchParams.get('w'), 800), 300, 2000);
      const h = clamp(num(url.searchParams.get('h'), 480), 300, 2000);
      const data = await feed();
      return text(res, 200, renderSvg(data, w, h), 'image/svg+xml; charset=utf-8', { 'X-FrameOS-Refresh-Minutes': String(data.display.refreshMinutes) });
    }
    if (p === '/frame') {
      if (!authorized(url)) return text(res, 401, 'Invalid display token');
      return serve(res, '/frame.html');
    }
    return serve(res, p);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error.message || 'Unexpected error' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log('CountdownApp Planner listening on :' + PORT));
