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
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY || '';
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const APP_SECRET = process.env.APP_SECRET || '';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const TARGET_CONTAINER = process.env.TARGET_CONTAINER || 'countdownapp';
const TARGET_IMAGE = process.env.TARGET_IMAGE || 'ghcr.io/srfarsquatch/countdownapp:edge';
const UPDATE_STATUS_PATH = path.join(DATA_DIR, 'update-status.json');
const CASAOS_RUNTIME_DIR = process.env.CASAOS_RUNTIME_DIR || '/var/run/casaos';
const CASAOS_APP_ID = process.env.CASAOS_APP_ID || 'countdownapp';
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/tasks';

const COLORS = ['black', 'red', 'blue', 'green', 'yellow', 'purple'];
const PROGRESS_MODES = ['time', 'manual', 'none'];
const PROGRESS_STYLES = ['solid', 'segmented', 'thin'];
const DATE_STYLES = ['short', 'medium', 'long', 'numeric'];
const TIME_STYLES = ['days', 'compact', 'full', 'precise', 'weeks', 'date'];
const LAYOUTS = ['auto', 'landscape', 'portrait'];
const PALETTES = ['spectra6', 'mono'];
const DATE_WIDGETS = ['flipper', 'plain'];
const DISPLAY_MODES = ['dashboard', 'daily', 'weekly', 'monthly', 'countdowns'];
const WEATHER_UNITS = ['metric', 'imperial'];
const WEATHER_STYLES = ['compact', 'current', 'forecast'];
const AGENDA_STYLES = ['list', 'timeline', 'week', 'calendar'];
const AGENDA_SCOPES = ['today', 'week', 'month', 'upcoming'];
const TASK_STYLES = ['checklist', 'compact'];
const GOAL_STYLES = ['bars', 'compact'];
const COUNTDOWN_STYLES = ['detailed', 'compact'];
const MARKET_STYLES = ['summary', 'compact', 'ticker'];
const DISPLAY_SECTION_LAYOUT_MODES = ['auto', 'custom'];
const DISPLAY_SECTION_KEYS = ['agenda', 'weather', 'tasks', 'goals', 'countdowns', 'markets'];
const DISPLAY_GRID_COLS = 24;
const DISPLAY_GRID_ROWS = 16;
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

function defaultSectionLayout(mode = 'dashboard') {
  if (mode === 'daily' || mode === 'weekly') return {
    agenda: { x: 0, y: 0, w: 16, h: 16 },
    weather: { x: 16, y: 0, w: 8, h: 4 },
    tasks: { x: 16, y: 4, w: 8, h: 4 },
    goals: { x: 16, y: 8, w: 8, h: 4 },
    countdowns: { x: 16, y: 12, w: 8, h: 4 },
    markets: { x: 16, y: 12, w: 8, h: 4 }
  };
  if (mode === 'monthly') return {
    agenda: { x: 0, y: 0, w: 18, h: 16 },
    weather: { x: 18, y: 0, w: 6, h: 4 },
    tasks: { x: 18, y: 4, w: 6, h: 4 },
    goals: { x: 18, y: 8, w: 6, h: 4 },
    countdowns: { x: 18, y: 12, w: 6, h: 4 },
    markets: { x: 18, y: 12, w: 6, h: 4 }
  };
  if (mode === 'countdowns') return {
    agenda: { x: 0, y: 0, w: 12, h: 8 },
    weather: { x: 12, y: 0, w: 12, h: 4 },
    tasks: { x: 12, y: 4, w: 12, h: 4 },
    goals: { x: 0, y: 8, w: 12, h: 8 },
    countdowns: { x: 0, y: 0, w: 24, h: 16 },
    markets: { x: 12, y: 8, w: 12, h: 8 }
  };
  return {
    agenda: { x: 0, y: 0, w: 14, h: 8 },
    weather: { x: 14, y: 0, w: 10, h: 4 },
    tasks: { x: 14, y: 4, w: 10, h: 4 },
    goals: { x: 0, y: 8, w: 8, h: 8 },
    countdowns: { x: 8, y: 8, w: 8, h: 8 },
    markets: { x: 16, y: 8, w: 8, h: 8 }
  };
}
function normalizeSectionLayout(input, mode = 'dashboard') {
  const base = defaultSectionLayout(mode);
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const key of DISPLAY_SECTION_KEYS) {
    const raw = source[key] && typeof source[key] === 'object' ? source[key] : base[key];
    const w = clamp(Math.round(num(raw.w, base[key].w)), 2, DISPLAY_GRID_COLS);
    const h = clamp(Math.round(num(raw.h, base[key].h)), 1, DISPLAY_GRID_ROWS);
    const x = clamp(Math.round(num(raw.x, base[key].x)), 0, DISPLAY_GRID_COLS - w);
    const y = clamp(Math.round(num(raw.y, base[key].y)), 0, DISPLAY_GRID_ROWS - h);
    out[key] = { x, y, w, h };
  }
  return out;
}
function migrateLegacy12x8Layout(input, mode = 'dashboard') {
  if (!input || typeof input !== 'object') return defaultSectionLayout(mode);
  const base = defaultSectionLayout(mode);
  const out = {};
  for (const key of DISPLAY_SECTION_KEYS) {
    const raw = input[key];
    if (!raw || typeof raw !== 'object') { out[key] = base[key]; continue; }
    out[key] = {
      x: clamp(Math.round(num(raw.x, 0) * 2), 0, DISPLAY_GRID_COLS - 2),
      y: clamp(Math.round(num(raw.y, 0) * 2), 0, DISPLAY_GRID_ROWS - 1),
      w: clamp(Math.round(num(raw.w, base[key].w / 2) * 2), 2, DISPLAY_GRID_COLS),
      h: clamp(Math.round(num(raw.h, base[key].h / 2) * 2), 1, DISPLAY_GRID_ROWS)
    };
    out[key].x = clamp(out[key].x, 0, DISPLAY_GRID_COLS - out[key].w);
    out[key].y = clamp(out[key].y, 0, DISPLAY_GRID_ROWS - out[key].h);
  }
  return out;
}

function defaultSectionSettings(mode = 'dashboard') {
  const countdownOnly = mode === 'countdowns';
  const agendaStyle = mode === 'daily' ? 'timeline' : mode === 'weekly' ? 'week' : mode === 'monthly' ? 'calendar' : 'list';
  const agendaScope = mode === 'daily' ? 'today' : mode === 'weekly' ? 'week' : mode === 'monthly' ? 'month' : 'upcoming';
  return {
    agenda: { enabled: !countdownOnly, style: agendaStyle, scope: agendaScope, limit: mode === 'weekly' ? 14 : mode === 'monthly' ? 20 : 12 },
    weather: { enabled: !countdownOnly, style: 'forecast', limit: 5 },
    tasks: { enabled: !countdownOnly, style: 'checklist', limit: 4 },
    goals: { enabled: !countdownOnly, style: 'bars', limit: 2 },
    countdowns: { enabled: true, style: 'detailed', limit: countdownOnly ? 8 : 3 },
    markets: { enabled: mode === 'dashboard', style: 'summary', limit: 4 }
  };
}
function normalizeSectionSettings(input, mode = 'dashboard') {
  const base = defaultSectionSettings(mode);
  const source = input && typeof input === 'object' ? input : {};
  const styles = {
    agenda: AGENDA_STYLES,
    weather: WEATHER_STYLES,
    tasks: TASK_STYLES,
    goals: GOAL_STYLES,
    countdowns: COUNTDOWN_STYLES,
    markets: MARKET_STYLES
  };
  const out = {};
  for (const key of DISPLAY_SECTION_KEYS) {
    const raw = source[key] && typeof source[key] === 'object' ? source[key] : {};
    out[key] = {
      enabled: raw.enabled === undefined ? base[key].enabled : Boolean(raw.enabled),
      style: en(raw.style, styles[key], base[key].style),
      limit: clamp(Math.round(num(raw.limit, base[key].limit)), 1, 20)
    };
    if (key === 'agenda') out[key].scope = en(raw.scope, AGENDA_SCOPES, base.agenda.scope);
  }
  return out;
}
function defaultModeLayouts() {
  return Object.fromEntries(DISPLAY_MODES.map(mode => [mode, defaultSectionLayout(mode)]));
}
function defaultModeSections() {
  return Object.fromEntries(DISPLAY_MODES.map(mode => [mode, defaultSectionSettings(mode)]));
}
function normalizeModeLayouts(input, legacyLayout) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const mode of DISPLAY_MODES) {
    const fallback = mode === 'dashboard' && legacyLayout ? legacyLayout : defaultSectionLayout(mode);
    out[mode] = normalizeSectionLayout(source[mode] || fallback, mode);
  }
  return out;
}
function normalizeModeSections(input, legacyDisplay = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const mode of DISPLAY_MODES) {
    const base = defaultSectionSettings(mode);
    const legacy = {
      agenda: { ...base.agenda, enabled: legacyDisplay.showAgenda !== false, limit: clamp(num(legacyDisplay.maxEvents, base.agenda.limit), 1, 20) },
      weather: { ...base.weather, enabled: legacyDisplay.showWeather !== false, style: en(legacyDisplay.weatherStyle, WEATHER_STYLES, base.weather.style) },
      tasks: { ...base.tasks, enabled: legacyDisplay.showTasks !== false, limit: clamp(num(legacyDisplay.maxTasks, base.tasks.limit), 1, 20) },
      goals: { ...base.goals, enabled: legacyDisplay.showGoals !== false, limit: clamp(num(legacyDisplay.maxGoals, base.goals.limit), 1, 20) },
      countdowns: { ...base.countdowns, enabled: legacyDisplay.showCountdowns !== false, limit: clamp(num(legacyDisplay.maxCountdowns, base.countdowns.limit), 1, 20) },
      markets: { ...base.markets }
    };
    if (mode === 'countdowns' && !source[mode]) {
      legacy.agenda.enabled = false; legacy.weather.enabled = false; legacy.tasks.enabled = false; legacy.goals.enabled = false; legacy.markets.enabled = false; legacy.countdowns.enabled = true;
    }
    out[mode] = normalizeSectionSettings(source[mode] || legacy, mode);
  }
  return out;
}
function normalizeSectionOrder(input) {
  const source = Array.isArray(input) ? input.map(String) : [];
  const seen = new Set();
  const out = [];
  for (const key of source) {
    if (DISPLAY_SECTION_KEYS.includes(key) && !seen.has(key)) {
      seen.add(key); out.push(key);
    }
  }
  for (const key of DISPLAY_SECTION_KEYS) if (!seen.has(key)) out.push(key);
  return out;
}
function truncateForWidth(value, width, fontSize = 13, reserve = 0) {
  const text = String(value || '');
  const usable = Math.max(20, width - reserve);
  const max = Math.max(4, Math.floor(usable / Math.max(5, fontSize * 0.55)));
  return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

function defaults() {
  return {
    countdowns: [],
    tasks: [],
    goals: [],
    google: { accounts: [], countdownWindowDays: 30 },
    weather: { latitude: null, longitude: null, locationLabel: '', units: 'metric' },
    markets: { watchlist: defaultMarketWatchlist(), refreshMinutes: 1440 },
    marketCache: null,
    display: {
      token: crypto.randomBytes(24).toString('hex'),
      title: 'Today', maxEvents: 5, maxCountdowns: 3, maxTasks: 6, maxGoals: 3,
      layout: 'auto', palette: 'spectra6', dateWidgetStyle: 'plain', mode: 'daily', plannerLayoutVersion: 5,
      sectionLayoutMode: 'custom', sectionLayout: defaultSectionLayout('dashboard'), sectionOrder: DISPLAY_SECTION_KEYS.slice(), weatherStyle: 'forecast',
      modeLayouts: defaultModeLayouts(), modeSections: defaultModeSections(),
      refreshMinutes: 15, showAgenda: true, showTasks: true, showGoals: true, showCountdowns: true, showWeather: true
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
    created, updated: iso(x.updated) || created,
    completedAt: status === 'done' ? (iso(x.completedAt) || new Date().toISOString()) : null,
    displayEnabled: x.displayEnabled !== false,
    googleAccountId: x.googleAccountId ? String(x.googleAccountId) : '',
    googleTaskListId: x.googleTaskListId ? String(x.googleTaskListId) : '',
    googleTaskListTitle: cleanText(x.googleTaskListTitle, 160),
    googleTaskId: x.googleTaskId ? String(x.googleTaskId) : '',
    googleParentId: x.googleParentId ? String(x.googleParentId) : '',
    googleUpdated: iso(x.googleUpdated),
    googleEtag: cleanText(x.googleEtag, 500)
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
  const selectedTaskListIds = Array.isArray(x.selectedTaskListIds) ? x.selectedTaskListIds.map(String).slice(0, 50) : [];
  return {
    id: String(x.id || id()),
    googleId: cleanText(x.googleId, 240),
    label: cleanText(x.label || x.googleId || 'Google account', 160),
    token: typeof x.token === 'string' ? x.token : null,
    selectedCalendarIds: Array.isArray(x.selectedCalendarIds) ? x.selectedCalendarIds.map(String).slice(0, 50) : [],
    selectedTaskListIds,
    defaultTaskListId: x.defaultTaskListId && selectedTaskListIds.includes(String(x.defaultTaskListId)) ? String(x.defaultTaskListId) : (selectedTaskListIds[0] || ''),
    connectedAt: iso(x.connectedAt) || new Date().toISOString()
  };
}

function normalizeWeather(x = {}) {
  const rawLat = x.latitude === '' || x.latitude === null || x.latitude === undefined ? null : Number(x.latitude);
  const rawLon = x.longitude === '' || x.longitude === null || x.longitude === undefined ? null : Number(x.longitude);
  return {
    latitude: Number.isFinite(rawLat) && rawLat >= -90 && rawLat <= 90 ? rawLat : null,
    longitude: Number.isFinite(rawLon) && rawLon >= -180 && rawLon <= 180 ? rawLon : null,
    locationLabel: cleanText(x.locationLabel, 100),
    units: en(x.units, WEATHER_UNITS, 'metric')
  };
}

function alphaProviderSymbol(source = {}) {
  const raw = cleanText(source.providerSymbol || source.alphaSymbol || source.symbol, 32).toUpperCase();
  if (!raw) return '';
  if (raw.includes('.') || raw.includes('/')) return raw;
  const exchange = cleanText(source.exchange, 80).toUpperCase();
  const region = cleanText(source.region || source.country, 80).toUpperCase();
  if (/TSXV|VENTURE/.test(exchange) || /VENTURE/.test(region)) return raw + '.TRV';
  if (/TSX|TORONTO/.test(exchange) || /TORONTO/.test(region)) return raw + '.TRT';
  return raw;
}
function alphaDisplaySymbol(providerSymbol = '') {
  return cleanText(providerSymbol, 32).toUpperCase().replace(/\.(TRT|TRV)$/i, '');
}
function normalizeMarketInstrument(value = {}) {
  const source = typeof value === 'string' ? { symbol: value } : (value && typeof value === 'object' ? value : {});
  const providerSymbol = alphaProviderSymbol(source);
  const displaySymbol = cleanText(source.displaySymbol || source.symbol || alphaDisplaySymbol(providerSymbol), 32).toUpperCase();
  return {
    symbol: displaySymbol || alphaDisplaySymbol(providerSymbol),
    providerSymbol,
    name: cleanText(source.name || source.instrumentName, 120),
    exchange: cleanText(source.exchange || source.region, 80),
    region: cleanText(source.region || source.country, 80),
    type: cleanText(source.type || source.instrumentType, 60),
    currency: cleanText(source.currency, 12).toUpperCase(),
    marketOpen: cleanText(source.marketOpen, 20),
    marketClose: cleanText(source.marketClose, 20),
    timezone: cleanText(source.timezone, 60),
    matchScore: cleanText(source.matchScore, 20)
  };
}
function defaultMarketWatchlist() {
  return [
    normalizeMarketInstrument({ symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', currency: 'USD' }),
    normalizeMarketInstrument({ symbol: 'QQQ', name: 'Invesco QQQ Trust', currency: 'USD' }),
    normalizeMarketInstrument({ symbol: 'RY', providerSymbol: 'RY.TRT', name: 'Royal Bank of Canada', exchange: 'Toronto', region: 'Canada', currency: 'CAD' }),
    normalizeMarketInstrument({ symbol: 'XEQT', providerSymbol: 'XEQT.TRT', name: 'iShares Core Equity ETF Portfolio', exchange: 'Toronto', region: 'Canada', currency: 'CAD' })
  ];
}
function normalizeMarkets(x = {}) {
  const raw = Array.isArray(x.watchlist) ? x.watchlist : (Array.isArray(x.symbols) ? x.symbols : defaultMarketWatchlist());
  const seen = new Set();
  const watchlist = [];
  for (const value of raw) {
    const item = normalizeMarketInstrument(value);
    if (!item.providerSymbol) continue;
    const key = item.providerSymbol;
    if (seen.has(key)) continue;
    seen.add(key); watchlist.push(item);
    if (watchlist.length >= 8) break;
  }
  const normalized = watchlist.length ? watchlist : defaultMarketWatchlist();
  return {
    watchlist: normalized,
    symbols: normalized.map(item => item.symbol),
    refreshMinutes: (() => { const requested = Math.round(num(x.refreshMinutes, 1440)); return requested < 720 ? 1440 : clamp(requested, 720, 1440); })()
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
      weather: normalizeWeather(parsed.weather || base.weather),
      markets: normalizeMarkets(parsed.markets || base.markets),
      display: (() => {
        const legacyDisplay = parsed.display || {};
        const legacyVersion = num(legacyDisplay.plannerLayoutVersion, 0);
        let migratedModeLayouts = legacyDisplay.modeLayouts;
        let migratedSectionLayout = legacyDisplay.sectionLayout;
        if (legacyVersion < 5) {
          const sourceModes = legacyDisplay.modeLayouts && typeof legacyDisplay.modeLayouts === 'object' ? legacyDisplay.modeLayouts : {};
          migratedModeLayouts = {};
          for (const mode of DISPLAY_MODES) {
            const source = sourceModes[mode] || (mode === 'dashboard' ? legacyDisplay.sectionLayout : null);
            migratedModeLayouts[mode] = source ? migrateLegacy12x8Layout(source, mode) : defaultSectionLayout(mode);
          }
          migratedSectionLayout = migratedModeLayouts.dashboard;
        }
        const display = {
          ...base.display,
          ...legacyDisplay,
          sectionLayout: normalizeSectionLayout(migratedSectionLayout, 'dashboard'),
          sectionOrder: normalizeSectionOrder(legacyDisplay.sectionOrder),
          modeLayouts: normalizeModeLayouts(migratedModeLayouts, migratedSectionLayout),
          modeSections: normalizeModeSections(legacyDisplay.modeSections, legacyDisplay)
        };
        if (legacyVersion < 2 && (!legacyDisplay.mode || legacyDisplay.mode === 'dashboard')) display.mode = 'daily';
        display.sectionLayoutMode = 'custom';
        display.plannerLayoutVersion = 5;
        return display;
      })()
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
function defaultUpdateState() {
  return {
    phase: 'idle', step: 'idle', progress: 0,
    message: updaterConfigured() ? 'Ready to check for updates' : 'Updater unavailable: Docker socket is not mounted',
    startedAt: null, finishedAt: null, error: null,
    checking: false, available: null, lastCheckedAt: null, checkError: null,
    currentImageId: '', latestImageId: '', currentRevision: '', latestRevision: '',
    currentVersion: '', latestVersion: '', latestCreatedAt: '',
    containerRef: '', installMode: 'casaos'
  };
}
function readUpdateState() {
  try { return { ...defaultUpdateState(), ...JSON.parse(fs.readFileSync(UPDATE_STATUS_PATH, 'utf8')) }; }
  catch { return defaultUpdateState(); }
}
function writeUpdateState(patch) {
  const next = { ...readUpdateState(), ...patch };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temp = UPDATE_STATUS_PATH + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(next, null, 2));
    fs.renameSync(temp, UPDATE_STATUS_PATH);
  } catch (error) {
    console.warn('Could not persist update status:', error.message);
  }
  return next;
}
function updateStatus() {
  return { configured: updaterConfigured(), ...readUpdateState() };
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
async function dockerJson(version, method, endpoint, payload) {
  const response = await dockerRaw(method, version + endpoint, payload);
  return response.raw ? JSON.parse(response.raw) : {};
}
async function tryInspectContainer(version, ref) {
  if (!ref) return null;
  try { return await dockerJson(version, 'GET', '/containers/' + encodeURIComponent(ref) + '/json'); }
  catch (error) {
    if (/failed \(404\)/.test(String(error.message || ''))) return null;
    throw error;
  }
}
async function resolveCurrentContainer(version) {
  const hostname = cleanText(process.env.HOSTNAME, 128);
  const candidates = [...new Set([hostname, TARGET_CONTAINER].filter(Boolean))];
  for (const candidate of candidates) {
    const found = await tryInspectContainer(version, candidate);
    if (found) return found;
  }

  const containers = await dockerJson(version, 'GET', '/containers/json?all=1');
  const running = (Array.isArray(containers) ? containers : []).filter(item => item?.State === 'running');
  const byHostname = hostname ? running.find(item => String(item.Id || '').startsWith(hostname)) : null;
  const byName = running.find(item => (item.Names || []).some(name => name.replace(/^\//, '') === TARGET_CONTAINER));
  const byImage = running.find(item => item.Image === TARGET_IMAGE || String(item.Image || '').startsWith(TARGET_IMAGE.split(':')[0] + ':'));
  const match = byHostname || byName || byImage;
  if (match?.Id) {
    const found = await tryInspectContainer(version, match.Id);
    if (found) return found;
  }
  throw new Error('Could not identify the running Quest Log container. CasaOS may have a stale container record; apply the app compose again in CasaOS.');
}
function splitImageReference(ref) {
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > slash) return { image: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { image: ref, tag: 'latest' };
}
function compactImageId(value) {
  const text = String(value || '').replace(/^sha256:/, '');
  return text ? text.slice(0, 12) : '';
}
function dockerImageMetadata(info) {
  const labels = info?.Config?.Labels || {};
  const revision = String(labels['org.opencontainers.image.revision'] || '');
  const version = String(labels['org.opencontainers.image.version'] || '');
  return {
    imageId: info?.Id || '',
    revision,
    version,
    createdAt: info?.Created || '',
    display: revision ? revision.slice(0, 8) : (version || compactImageId(info?.Id))
  };
}
async function pullTargetImage(version) {
  const ref = splitImageReference(TARGET_IMAGE);
  const response = await dockerRaw('POST', version + '/images/create?fromImage=' + encodeURIComponent(ref.image) + '&tag=' + encodeURIComponent(ref.tag));
  for (const line of response.raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.errorDetail?.message) throw new Error(event.errorDetail.message);
      if (event.error) throw new Error(event.error);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
}
let updateCheckPromise = null;
async function checkForUpdate() {
  if (!updaterConfigured()) throw new Error('Docker socket is not available. Re-import the latest CasaOS compose file.');
  const currentStatus = readUpdateState();
  if (currentStatus.phase === 'pulling') throw new Error('An update image is already being prepared.');
  if (updateCheckPromise) return updateCheckPromise;
  updateCheckPromise = (async () => {
    writeUpdateState({ phase: 'idle', step: 'idle', progress: 0, checking: true, checkError: null, error: null, message: 'Checking for updates…' });
    try {
      const version = await dockerApiVersion();
      const container = await resolveCurrentContainer(version);
      const currentImage = await dockerJson(version, 'GET', '/images/' + encodeURIComponent(container.Image) + '/json');
      await pullTargetImage(version);
      const latestImage = await dockerJson(version, 'GET', '/images/' + encodeURIComponent(TARGET_IMAGE) + '/json');
      const currentMeta = dockerImageMetadata(currentImage);
      const latestMeta = dockerImageMetadata(latestImage);
      const available = container.Image !== latestImage.Id;
      return writeUpdateState({
        phase: available ? 'ready' : 'idle', step: available ? 'casaos' : 'idle',
        progress: available ? 100 : 0, checking: false, available,
        lastCheckedAt: new Date().toISOString(), checkError: null, error: null,
        message: available ? 'Update image ready — apply it from CasaOS' : 'Quest Log is up to date',
        currentImageId: currentMeta.imageId, latestImageId: latestMeta.imageId,
        currentRevision: currentMeta.revision, latestRevision: latestMeta.revision,
        currentVersion: currentMeta.version, latestVersion: latestMeta.version,
        latestCreatedAt: latestMeta.createdAt,
        containerRef: String(container.Name || '').replace(/^\//, '') || container.Id || '',
        installMode: 'casaos'
      });
    } catch (error) {
      writeUpdateState({
        phase: 'error', step: 'error', progress: 0, checking: false, checkError: error.message, error: null,
        lastCheckedAt: new Date().toISOString(), message: 'Could not check for updates'
      });
      throw error;
    } finally {
      updateCheckPromise = null;
    }
  })();
  return updateCheckPromise;
}

let updateInstallPromise = null;
async function launchCasaOSManagedUpdater(version, currentContainer) {
  const name = 'countdownapp-casaos-update-' + Date.now().toString(36);
  const config = {
    Image: TARGET_IMAGE,
    Cmd: ['node', '/app/casaos-update.js'],
    Env: [
      'TARGET_CONTAINER=' + TARGET_CONTAINER,
      'TARGET_IMAGE=' + TARGET_IMAGE,
      'DATA_DIR=/data',
      'DOCKER_SOCKET=/var/run/docker.sock',
      'CASAOS_RUNTIME_DIR=/var/run/casaos',
      'CASAOS_APP_ID=' + CASAOS_APP_ID,
      'OLD_IMAGE_ID=' + String(currentContainer.Image || '')
    ],
    HostConfig: {
      AutoRemove: true,
      NetworkMode: 'host',
      Binds: [
        '/var/run/docker.sock:/var/run/docker.sock',
        '/var/run/casaos:/var/run/casaos:ro',
        '/DATA/AppData/countdownapp/data:/data'
      ]
    }
  };
  await dockerRaw('POST', version + '/containers/create?name=' + encodeURIComponent(name), config);
  await dockerRaw('POST', version + '/containers/' + encodeURIComponent(name) + '/start');
  return name;
}

async function installUpdateWithCasaOS() {
  if (!updaterConfigured()) throw new Error('Docker socket is not available. Re-import the latest CasaOS compose file.');
  if (updateInstallPromise) return updateInstallPromise;
  updateInstallPromise = (async () => {
    try {
      const version = await dockerApiVersion();
      const container = await resolveCurrentContainer(version);
      const currentImage = await dockerJson(version, 'GET', '/images/' + encodeURIComponent(container.Image) + '/json');

      writeUpdateState({
        phase: 'pulling', step: 'download', progress: 10,
        message: 'Downloading update…',
        startedAt: new Date().toISOString(), finishedAt: null,
        checking: false, checkError: null, error: null,
        installMode: 'casaos-managed'
      });

      await pullTargetImage(version);
      const latestImage = await dockerJson(version, 'GET', '/images/' + encodeURIComponent(TARGET_IMAGE) + '/json');
      const currentMeta = dockerImageMetadata(currentImage);
      const latestMeta = dockerImageMetadata(latestImage);

      if (container.Image === latestImage.Id) {
        return writeUpdateState({
          phase: 'complete', step: 'complete', progress: 100, available: false,
          message: 'Quest Log is already up to date',
          currentImageId: latestMeta.imageId, latestImageId: latestMeta.imageId,
          currentRevision: latestMeta.revision, latestRevision: latestMeta.revision,
          currentVersion: latestMeta.version, latestVersion: latestMeta.version,
          latestCreatedAt: latestMeta.createdAt,
          lastCheckedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          error: null, checkError: null, installMode: 'casaos-managed'
        });
      }

      writeUpdateState({
        phase: 'preparing', step: 'casaos', progress: 45,
        message: 'Starting CasaOS-managed update…',
        currentImageId: currentMeta.imageId, latestImageId: latestMeta.imageId,
        currentRevision: currentMeta.revision, latestRevision: latestMeta.revision,
        currentVersion: currentMeta.version, latestVersion: latestMeta.version,
        latestCreatedAt: latestMeta.createdAt,
        available: true,
        installMode: 'casaos-managed'
      });

      const helper = await launchCasaOSManagedUpdater(version, container);
      return { ok: true, helper, message: 'CasaOS-managed update started' };
    } catch (error) {
      writeUpdateState({
        phase: 'error', step: 'error', progress: 0,
        message: 'Could not start CasaOS-managed update',
        error: error.message, finishedAt: new Date().toISOString(),
        installMode: 'casaos-managed'
      });
      throw error;
    } finally {
      updateInstallPromise = null;
    }
  })();
  return updateInstallPromise;
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
function accountCanTasks(account) {
  const token = account ? decrypt(account.token) : null;
  const scopes = String(token?.scope || '').split(/\s+/).filter(Boolean);
  return scopes.includes('https://www.googleapis.com/auth/tasks');
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
async function googleTasksRequest(accountOrId, endpoint, method = 'GET', payload) {
  const account = typeof accountOrId === 'string' ? googleAccount(accountOrId) : accountOrId;
  const access = await accessToken(account);
  if (!account || !access) throw new Error('Google account is not connected.');
  if (!accountCanTasks(account)) throw new Error('Reconnect this Google account to grant Google Tasks access.');
  const hasBody = payload !== undefined && payload !== null;
  const response = await fetch('https://tasks.googleapis.com/tasks/v1' + endpoint, {
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
    const error = new Error('Google Tasks request failed: ' + detail);
    error.status = response.status;
    throw error;
  }
  return data;
}
async function taskLists(accountId) {
  const account = typeof accountId === 'string' ? googleAccount(accountId) : accountId;
  if (!account) throw new Error('Google account was not found.');
  let out = [], pageToken = '';
  do {
    const query = new URLSearchParams({ maxResults: '100' });
    if (pageToken) query.set('pageToken', pageToken);
    const data = await googleTasksRequest(account, '/users/@me/lists?' + query);
    out.push(...(data.items || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out.map(list => ({ id: list.id, title: list.title || 'Tasks', updated: list.updated || null }));
}
async function googleTasksForList(account, taskListId) {
  let out = [], pageToken = '';
  do {
    const query = new URLSearchParams({
      maxResults: '100', showCompleted: 'true', showDeleted: 'true', showHidden: 'true'
    });
    if (pageToken) query.set('pageToken', pageToken);
    const data = await googleTasksRequest(account, '/lists/' + encodeURIComponent(taskListId) + '/tasks?' + query);
    out.push(...(data.items || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}
function localDateKey(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
function googleTaskDue(value) {
  const key = localDateKey(value);
  return key ? key + 'T00:00:00.000Z' : null;
}
function googleDueToLocalIso(value, existingDue) {
  const key = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [year, month, day] = key.split('-').map(Number);
  const existing = existingDue ? new Date(existingDue) : null;
  const hour = existing && !Number.isNaN(existing.getTime()) ? existing.getHours() : 12;
  const minute = existing && !Number.isNaN(existing.getTime()) ? existing.getMinutes() : 0;
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
}
function googleTaskPayload(task) {
  return {
    title: cleanText(task.title || 'Task', 1024),
    notes: cleanText(task.description, 8192),
    status: task.status === 'done' ? 'completed' : 'needsAction',
    completed: task.status === 'done' ? (iso(task.completedAt) || new Date().toISOString()) : null,
    due: googleTaskDue(task.due)
  };
}
function applyGoogleTask(localTask, remote, account, list) {
  const done = remote.status === 'completed';
  const base = localTask || {};
  return normalizeTask({
    ...base,
    id: base.id || id(),
    title: cleanText(remote.title || base.title || 'Task', 160),
    description: cleanText(remote.notes || '', 2000),
    status: done ? 'done' : (base.status === 'progress' ? 'progress' : 'todo'),
    due: remote.due ? googleDueToLocalIso(remote.due, base.due) : null,
    project: base.project || cleanText(list?.title, 80),
    created: base.created || iso(remote.updated) || new Date().toISOString(),
    updated: iso(remote.updated) || new Date().toISOString(),
    completedAt: done ? (iso(remote.completed) || iso(remote.updated) || new Date().toISOString()) : null,
    googleAccountId: account.id,
    googleTaskListId: list.id,
    googleTaskListTitle: list.title || 'Tasks',
    googleTaskId: remote.id,
    googleParentId: remote.parent || '',
    googleUpdated: iso(remote.updated),
    googleEtag: remote.etag || ''
  });
}
async function createGoogleTaskLink(task, accountId, taskListId) {
  const account = googleAccount(accountId);
  if (!account) throw new Error('Google account was not found.');
  if (!accountCanTasks(account)) throw new Error('Reconnect this Google account to grant Google Tasks access.');
  const lists = await taskLists(account);
  const list = lists.find(x => x.id === taskListId);
  if (!list) throw new Error('Google task list was not found.');
  const remote = await googleTasksRequest(account, '/lists/' + encodeURIComponent(taskListId) + '/tasks', 'POST', googleTaskPayload(task));
  return applyGoogleTask(task, remote, account, list);
}
async function updateLinkedGoogleTask(task) {
  if (!task.googleAccountId || !task.googleTaskListId || !task.googleTaskId) return task;
  const account = googleAccount(task.googleAccountId);
  if (!account) throw new Error('The Google account linked to this task is disconnected.');
  const remote = await googleTasksRequest(
    account,
    '/lists/' + encodeURIComponent(task.googleTaskListId) + '/tasks/' + encodeURIComponent(task.googleTaskId),
    'PATCH',
    googleTaskPayload(task)
  );
  const list = { id: task.googleTaskListId, title: task.googleTaskListTitle || task.project || 'Tasks' };
  return applyGoogleTask(task, remote, account, list);
}
async function deleteLinkedGoogleTask(task) {
  if (!task.googleAccountId || !task.googleTaskListId || !task.googleTaskId) return;
  const account = googleAccount(task.googleAccountId);
  if (!account || !accountCanTasks(account)) return;
  try {
    await googleTasksRequest(account, '/lists/' + encodeURIComponent(task.googleTaskListId) + '/tasks/' + encodeURIComponent(task.googleTaskId), 'DELETE');
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}
let googleTaskSyncPromise = null;
async function syncGoogleTasks() {
  if (googleTaskSyncPromise) return googleTaskSyncPromise;
  googleTaskSyncPromise = (async () => {
    const result = { imported: 0, pulled: 0, pushed: 0, deleted: 0, errors: [] };
    let changed = false;
    for (const account of googleAccounts()) {
      if (!account.token || !accountCanTasks(account) || !account.selectedTaskListIds.length) continue;
      let lists = [];
      try { lists = await taskLists(account); }
      catch (error) { result.errors.push(account.label + ': ' + error.message); continue; }
      const listMap = new Map(lists.map(list => [list.id, list]));
      for (const taskListId of account.selectedTaskListIds) {
        const list = listMap.get(taskListId) || { id: taskListId, title: 'Google Tasks' };
        let remoteItems = [];
        try { remoteItems = await googleTasksForList(account, taskListId); }
        catch (error) { result.errors.push(account.label + ' / ' + list.title + ': ' + error.message); continue; }
        const remoteMap = new Map(remoteItems.filter(remote => remote.id).map(remote => [remote.id, remote]));
        const linked = db.tasks.filter(task => task.googleAccountId === account.id && task.googleTaskListId === taskListId);

        for (const remote of remoteItems) {
          const local = linked.find(task => task.googleTaskId === remote.id);
          if (remote.deleted) {
            if (local) {
              db.tasks = db.tasks.filter(task => task.id !== local.id);
              result.deleted++; changed = true;
            }
            continue;
          }
          if (!local) {
            db.tasks.push(applyGoogleTask(null, remote, account, list));
            result.imported++; changed = true;
            continue;
          }
          const baseline = local.googleUpdated ? new Date(local.googleUpdated).getTime() : 0;
          const localUpdated = local.updated ? new Date(local.updated).getTime() : 0;
          const remoteUpdated = remote.updated ? new Date(remote.updated).getTime() : 0;
          const localChanged = localUpdated > baseline + 500;
          const remoteChanged = remoteUpdated > baseline + 500;
          if (localChanged && (!remoteChanged || localUpdated > remoteUpdated)) {
            try {
              const next = await updateLinkedGoogleTask(local);
              const index = db.tasks.findIndex(task => task.id === local.id);
              if (index >= 0) db.tasks[index] = next;
              result.pushed++; changed = true;
            } catch (error) {
              result.errors.push(account.label + ' / ' + local.title + ': ' + error.message);
            }
          } else if (remoteChanged) {
            const index = db.tasks.findIndex(task => task.id === local.id);
            if (index >= 0) db.tasks[index] = applyGoogleTask(local, remote, account, list);
            result.pulled++; changed = true;
          }
        }

        for (const local of linked) {
          if (!local.googleTaskId || remoteMap.has(local.googleTaskId)) continue;
          db.tasks = db.tasks.filter(task => task.id !== local.id);
          result.deleted++; changed = true;
        }
      }
    }
    if (changed) save(db);
    return result;
  })();
  try { return await googleTaskSyncPromise; }
  finally { googleTaskSyncPromise = null; }
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
let weatherCache = { key: '', expiresAt: 0, data: null };
function weatherLocationReady() {
  return Number.isFinite(db.weather?.latitude) && Number.isFinite(db.weather?.longitude);
}
function weatherCodeInfo(code) {
  const value = Number(code);
  if (value === 0) return { condition: 'CLEAR', description: 'Clear sky' };
  if (value === 1) return { condition: 'PARTLY_CLOUDY', description: 'Mainly clear' };
  if (value === 2) return { condition: 'PARTLY_CLOUDY', description: 'Partly cloudy' };
  if (value === 3) return { condition: 'CLOUDY', description: 'Overcast' };
  if (value === 45 || value === 48) return { condition: 'FOG', description: value === 48 ? 'Rime fog' : 'Fog' };
  if ([51, 53, 55, 56, 57].includes(value)) return { condition: 'DRIZZLE', description: 'Drizzle' };
  if ([61, 63, 65, 66, 67].includes(value)) return { condition: 'RAIN', description: value >= 65 ? 'Heavy rain' : 'Rain' };
  if ([71, 73, 75, 77].includes(value)) return { condition: 'SNOW', description: value === 75 ? 'Heavy snow' : 'Snow' };
  if ([80, 81, 82].includes(value)) return { condition: 'SHOWERS', description: value === 82 ? 'Heavy showers' : 'Rain showers' };
  if ([85, 86].includes(value)) return { condition: 'SNOW_SHOWERS', description: value === 86 ? 'Heavy snow showers' : 'Snow showers' };
  if ([95, 96, 99].includes(value)) return { condition: 'THUNDERSTORM', description: value === 95 ? 'Thunderstorm' : 'Thunderstorm with hail' };
  return { condition: 'CLOUDY', description: 'Weather' };
}
async function weatherData() {
  if (!weatherLocationReady()) throw new Error('Choose a weather location in Settings.');
  const units = en(db.weather.units, WEATHER_UNITS, 'metric');
  const key = [db.weather.latitude, db.weather.longitude, units, db.weather.locationLabel || ''].join('|');
  if (weatherCache.data && weatherCache.key === key && weatherCache.expiresAt > Date.now()) return weatherCache.data;

  const params = new URLSearchParams({
    latitude: String(db.weather.latitude),
    longitude: String(db.weather.longitude),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,precipitation,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '10'
  });
  if (units === 'imperial') { params.set('temperature_unit', 'fahrenheit'); params.set('wind_speed_unit', 'mph'); }

  const response = await fetch('https://api.open-meteo.com/v1/forecast?' + params);
  if (!response.ok) throw new Error('Open-Meteo request failed (' + response.status + ').');
  const raw = await response.json();
  if (raw.error) throw new Error(cleanText(raw.reason || 'Open-Meteo request failed.', 180));

  const currentInfo = weatherCodeInfo(raw.current?.weather_code);
  const times = Array.isArray(raw.daily?.time) ? raw.daily.time : [];
  const maxTemps = Array.isArray(raw.daily?.temperature_2m_max) ? raw.daily.temperature_2m_max : [];
  const minTemps = Array.isArray(raw.daily?.temperature_2m_min) ? raw.daily.temperature_2m_min : [];
  const precip = Array.isArray(raw.daily?.precipitation_probability_max) ? raw.daily.precipitation_probability_max : [];
  const codes = Array.isArray(raw.daily?.weather_code) ? raw.daily.weather_code : [];

  const data = {
    provider: 'Open-Meteo',
    attribution: 'Weather data by Open-Meteo',
    locationLabel: db.weather.locationLabel || '',
    units,
    unitSymbol: units === 'imperial' ? '°F' : '°C',
    timeZone: cleanText(raw.timezone || '', 100),
    current: {
      temperature: Number.isFinite(Number(raw.current?.temperature_2m)) ? Math.round(Number(raw.current.temperature_2m)) : null,
      feelsLike: Number.isFinite(Number(raw.current?.apparent_temperature)) ? Math.round(Number(raw.current.apparent_temperature)) : null,
      humidity: clamp(num(raw.current?.relative_humidity_2m, 0), 0, 100),
      isDaytime: Number(raw.current?.is_day) !== 0,
      precipitation: Math.max(0, num(raw.current?.precipitation, 0)),
      windSpeed: Math.max(0, num(raw.current?.wind_speed_10m, 0)),
      ...currentInfo
    },
    days: times.map((date, index) => {
      const info = weatherCodeInfo(codes[index]);
      return {
        date: String(date || ''),
        high: Number.isFinite(Number(maxTemps[index])) ? Math.round(Number(maxTemps[index])) : null,
        low: Number.isFinite(Number(minTemps[index])) ? Math.round(Number(minTemps[index])) : null,
        daytime: {
          condition: info.condition,
          description: info.description,
          precipitation: clamp(num(precip[index], 0), 0, 100)
        },
        nighttime: {
          condition: info.condition,
          description: info.description,
          precipitation: clamp(num(precip[index], 0), 0, 100)
        }
      };
    }).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day.date))
  };

  weatherCache = { key, expiresAt: Date.now() + 15 * 60 * 1000, data };
  return data;
}

async function weatherLocationSearch(query) {
  const q = cleanText(query, 120).trim();
  if (q.length < 2) return [];
  const params = new URLSearchParams({ name: q, count: '8', language: 'en', format: 'json' });
  const response = await fetch('https://geocoding-api.open-meteo.com/v1/search?' + params);
  if (!response.ok) throw new Error('Open-Meteo location search failed (' + response.status + ').');
  const raw = await response.json();
  if (raw.error) throw new Error(cleanText(raw.reason || 'Location search failed.', 180));
  return (raw.results || []).map(item => {
    const name = cleanText(item.name, 100);
    const admin1 = cleanText(item.admin1, 100);
    const country = cleanText(item.country, 100);
    const parts = [name, admin1, country].filter((value, index, arr) => value && arr.indexOf(value) === index);
    return {
      id: String(item.id || ''),
      name,
      admin1,
      country,
      countryCode: cleanText(item.country_code, 8),
      latitude: num(item.latitude, 0),
      longitude: num(item.longitude, 0),
      timezone: cleanText(item.timezone, 100),
      label: parts.join(', ')
    };
  }).filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
}

function loadPersistedMarketCache() {
  const cached = db.marketCache;
  if (!cached || typeof cached !== 'object' || !cached.data || typeof cached.data !== 'object') {
    return { key: '', expiresAt: 0, data: null };
  }
  const expiresAt = Number(cached.expiresAt);
  return {
    key: cleanText(cached.key, 500),
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    data: cached.data
  };
}
let marketCache = loadPersistedMarketCache();
function persistMarketCache() {
  db.marketCache = marketCache.data ? {
    key: marketCache.key,
    expiresAt: marketCache.expiresAt,
    data: marketCache.data
  } : null;
  save(db);
}
function marketConfigured() { return Boolean(ALPHA_VANTAGE_API_KEY); }
function marketNumber(value) {
  const n = Number(String(value ?? '').replace('%','')); return Number.isFinite(n) ? n : null;
}
function alphaEffectiveRefreshMinutes(config) {
  const count = Math.max(1, config.watchlist.length);
  const quotaSafe = Math.ceil((count * 1440) / 20);
  return Math.max(config.refreshMinutes, quotaSafe);
}
function normalizeMarketQuote(raw = {}, fallback = {}) {
  const requested = normalizeMarketInstrument(fallback);
  const close = marketNumber(raw['05. price']);
  return {
    ...requested,
    providerSymbol: cleanText(raw['01. symbol'] || requested.providerSymbol, 32).toUpperCase(),
    close,
    open: marketNumber(raw['02. open']),
    high: marketNumber(raw['03. high']),
    low: marketNumber(raw['04. low']),
    volume: marketNumber(raw['06. volume']),
    datetime: cleanText(raw['07. latest trading day'] || '', 50),
    previousClose: marketNumber(raw['08. previous close']),
    change: marketNumber(raw['09. change']),
    percentChange: marketNumber(raw['10. change percent']),
    marketOpen: null,
    available: close !== null,
    error: ''
  };
}
function unavailableMarketQuote(item, message = 'No quote returned for this watchlist symbol.') {
  const requested = normalizeMarketInstrument(item);
  return {
    ...requested,
    close: null, open: null, high: null, low: null, previousClose: null,
    change: null, percentChange: null, volume: null, marketOpen: null,
    datetime: '', available: false, error: cleanText(message, 220)
  };
}
let alphaRequestChain = Promise.resolve();
let alphaLastRequestAt = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function alphaProviderError(raw = {}, status = 0) {
  const message = cleanText(raw['Error Message'] || raw.Note || raw.Information || '', 260);
  if (/1 request per second|spread.*sparsely|call frequency/i.test(message)) {
    return { kind: 'burst', message: 'Alpha Vantage rate limit hit. Quest Log will retry automatically.' };
  }
  if (/25 requests per day|daily.*limit|standard api call frequency/i.test(message)) {
    return { kind: 'daily', message: 'Alpha Vantage daily free API limit reached. Cached market data will be used until the allowance resets.' };
  }
  return { kind: 'api', message: message || 'Alpha Vantage request failed (' + status + ').' };
}

async function alphaVantageRequest(params = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = Math.max(0, 1150 - (Date.now() - alphaLastRequestAt));
    if (wait) await sleep(wait);
    alphaLastRequestAt = Date.now();

    const query = new URLSearchParams({ ...params, apikey: ALPHA_VANTAGE_API_KEY });
    const response = await fetch('https://www.alphavantage.co/query?' + query);
    const raw = await response.json().catch(() => ({}));
    const providerError = alphaProviderError(raw, response.status);

    if (response.ok && !raw['Error Message'] && !raw.Note && !raw.Information) return raw;

    if (providerError.kind === 'burst' && attempt === 0) {
      await sleep(1250);
      continue;
    }
    const error = new Error(providerError.message);
    error.kind = providerError.kind;
    throw error;
  }
  const error = new Error('Alpha Vantage rate limit hit. Try again shortly.');
  error.kind = 'burst';
  throw error;
}

function alphaVantageFetch(params = {}) {
  if (!marketConfigured()) return Promise.reject(new Error('Add ALPHA_VANTAGE_API_KEY in CasaOS to enable Markets.'));
  const run = alphaRequestChain.then(() => alphaVantageRequest(params));
  alphaRequestChain = run.catch(() => {});
  return run;
}

async function marketData() {
  const config = normalizeMarkets(db.markets);
  const effectiveRefreshMinutes = alphaEffectiveRefreshMinutes(config);
  const key = config.watchlist.map(item => item.providerSymbol).join(',');
  if (marketCache.data && marketCache.key === key && marketCache.expiresAt > Date.now()) return marketCache.data;

  const quotes = [];
  for (const item of config.watchlist) {
    if (item.providerSymbol.includes('/')) {
      quotes.push(unavailableMarketQuote(item, 'Crypto pairs are not included in the Alpha Vantage stock quote watchlist. Remove and re-add this item as a supported equity or ETF.'));
      continue;
    }
    try {
      const raw = await alphaVantageFetch({ function: 'GLOBAL_QUOTE', symbol: item.providerSymbol });
      const quote = raw['Global Quote'] || {};
      quotes.push(Object.keys(quote).length ? normalizeMarketQuote(quote, item) : unavailableMarketQuote(item, 'Alpha Vantage returned no quote for this symbol.'));
    } catch (error) {
      const stale = marketCache.data?.quotes?.find(q => q.providerSymbol === item.providerSymbol || q.symbol === item.symbol);
      if (stale?.close != null) {
        quotes.push({ ...stale, stale: true, error: error.message || 'Using cached quote.' });
      } else {
        quotes.push(unavailableMarketQuote(item, error.message || 'Quote unavailable.'));
      }
      if (error.kind === 'daily') break;
    }
  }
  while (quotes.length < config.watchlist.length) {
    const item = config.watchlist[quotes.length];
    const stale = marketCache.data?.quotes?.find(q => q.providerSymbol === item.providerSymbol || q.symbol === item.symbol);
    quotes.push(stale?.close != null
      ? { ...stale, stale: true, error: 'Using cached quote because the Alpha Vantage daily free API limit was reached.' }
      : unavailableMarketQuote(item, 'Skipped because the Alpha Vantage daily free API limit was reached.'));
  }

  const data = {
    provider: 'Alpha Vantage',
    quotes,
    watchlist: config.watchlist,
    symbols: config.symbols,
    updatedAt: new Date().toISOString(),
    refreshMinutes: config.refreshMinutes,
    effectiveRefreshMinutes,
    freeDailyRequestLimit: 25
  };
  marketCache = { key, expiresAt: Date.now() + effectiveRefreshMinutes * 60000, data };
  persistMarketCache();
  return data;
}
async function marketSearch(query) {
  const q = cleanText(query, 80).trim();
  if (!q) return [];
  const raw = await alphaVantageFetch({ function: 'SYMBOL_SEARCH', keywords: q });
  return (raw.bestMatches || []).slice(0, 10).map(item => {
    const providerSymbol = cleanText(item['1. symbol'], 32).toUpperCase();
    return normalizeMarketInstrument({
      symbol: alphaDisplaySymbol(providerSymbol),
      providerSymbol,
      name: item['2. name'],
      type: item['3. type'],
      region: item['4. region'],
      exchange: item['4. region'],
      marketOpen: item['5. marketOpen'],
      marketClose: item['6. marketClose'],
      timezone: item['7. timezone'],
      currency: item['8. currency'],
      matchScore: item['9. matchScore']
    });
  }).filter(item => item.providerSymbol);
}

function agendaRange(scope, now = new Date()) {
  const startOfDay = value => { const d = new Date(value); d.setHours(0, 0, 0, 0); return d; };
  if (scope === 'today') {
    const start = startOfDay(now), end = new Date(start); end.setDate(end.getDate() + 1);
    return { start, end };
  }
  if (scope === 'week') {
    const start = startOfDay(now); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(start); end.setDate(end.getDate() + 7);
    return { start, end };
  }
  if (scope === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { start, end };
  }
  return { start: new Date(now), end: new Date(now.getTime() + clamp(num(db.google.countdownWindowDays, 30), 1, 365) * 86400000) };
}

function agendaTasksForRange(scope, range, now = new Date()) {
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  return sortedTasks().filter(task => {
    if (task.status === 'done' || task.displayEnabled === false) return false;
    if (!task.due) return scope === 'today' || scope === 'upcoming';
    const due = new Date(task.due);
    if (Number.isNaN(due.getTime())) return false;
    if (due < todayStart) return true;
    return due >= range.start && due < range.end;
  });
}

async function feed() {
  let ev = [], calendarError = null, weather = null, weatherError = null, markets = null, marketError = null;
  const mode = en(db.display.mode, DISPLAY_MODES, 'daily');
  const modeSections = normalizeSectionSettings(db.display.modeSections?.[mode], mode);
  const modeLayout = normalizeSectionLayout(db.display.modeLayouts?.[mode], mode);
  const nowDate = new Date();
  const now = nowDate.getTime();
  const agendaWindow = modeSections.agenda.enabled ? agendaRange(modeSections.agenda.scope, nowDate) : null;
  const agendaTasks = agendaWindow ? agendaTasksForRange(modeSections.agenda.scope, agendaWindow, nowDate) : [];
  if (agendaWindow && googleAccounts().some(account => account.token && account.selectedCalendarIds.length)) {
    try { ev = await eventsBetween(agendaWindow.start.toISOString(), agendaWindow.end.toISOString()); }
    catch (error) { calendarError = error.message; }
  }
  if (modeSections.weather.enabled) {
    if (weatherLocationReady()) {
      try { weather = await weatherData(); }
      catch (error) { weatherError = error.message; }
    } else weatherError = 'Choose a weather location in Settings.';
  }
  if (modeSections.markets.enabled) {
    if (marketConfigured()) {
      try { markets = await marketData(); }
      catch (error) { marketError = error.message; }
    } else marketError = 'Add ALPHA_VANTAGE_API_KEY in CasaOS to enable Markets.';
  }
  const countdowns = sortedCountdowns()
    .filter(c => c.displayEnabled && new Date(c.end).getTime() > now)
    .slice(0, clamp(num(db.display.maxCountdowns, 3), 1, 20)).map(c => countdownView(c, now));
  const tasks = sortedTasks().filter(dueForDisplay).slice(0, clamp(num(db.display.maxTasks, 6), 1, 20));
  const goals = db.goals.filter(g => g.status === 'active' && g.displayEnabled !== false)
    .sort((a, b) => (a.deadline ? new Date(a.deadline).getTime() : Number.MAX_SAFE_INTEGER) - (b.deadline ? new Date(b.deadline).getTime() : Number.MAX_SAFE_INTEGER))
    .slice(0, clamp(num(db.display.maxGoals, 3), 1, 20)).map(g => ({ ...g, progress: goalProgress(g) }));
  return {
    generatedAt: new Date().toISOString(), title: db.display.title || 'Today', calendarError, weatherError, weather, marketError, markets,
    nextEvent: ev.find(event => new Date(event.end || event.start).getTime() >= now) || null,
    events: modeSections.agenda.enabled ? ev.slice(0, modeSections.agenda.limit) : [],
    calendarEvents: modeSections.agenda.enabled ? ev.slice(0, 250) : [],
    agendaTasks: modeSections.agenda.enabled ? agendaTasks.slice(0, 250) : [],
    tasks: modeSections.tasks.enabled ? sortedTasks().filter(dueForDisplay).slice(0, modeSections.tasks.limit) : [],
    plannerTasks: (modeSections.agenda.enabled || modeSections.tasks.enabled)
      ? sortedTasks().filter(task => task.status !== 'done' && task.displayEnabled !== false).slice(0, 250)
      : [],
    goals: modeSections.goals.enabled ? db.goals.filter(g => g.status === 'active' && g.displayEnabled !== false)
      .sort((a, b) => (a.deadline ? new Date(a.deadline).getTime() : Number.MAX_SAFE_INTEGER) - (b.deadline ? new Date(b.deadline).getTime() : Number.MAX_SAFE_INTEGER))
      .slice(0, modeSections.goals.limit).map(g => ({ ...g, progress: goalProgress(g) })) : [],
    countdowns: modeSections.countdowns.enabled ? sortedCountdowns()
      .filter(c => c.displayEnabled && new Date(c.end).getTime() > now)
      .slice(0, modeSections.countdowns.limit).map(c => countdownView(c, now)) : [],
    display: {
      layout: en(db.display.layout, LAYOUTS, 'auto'), palette: en(db.display.palette, PALETTES, 'spectra6'),
      dateWidgetStyle: en(db.display.dateWidgetStyle, DATE_WIDGETS, 'plain'), mode: en(db.display.mode, DISPLAY_MODES, 'dashboard'),
      sectionLayoutMode: en(db.display.sectionLayoutMode, DISPLAY_SECTION_LAYOUT_MODES, 'auto'),
      sectionLayout: normalizeSectionLayout(db.display.sectionLayout), sectionOrder: normalizeSectionOrder(db.display.sectionOrder),
      gridCols: DISPLAY_GRID_COLS, gridRows: DISPLAY_GRID_ROWS,
      refreshMinutes: clamp(num(db.display.refreshMinutes, 15), 1, 1440),
      showAgenda: db.display.showAgenda !== false, showTasks: db.display.showTasks !== false,
      showGoals: db.display.showGoals !== false, showCountdowns: db.display.showCountdowns !== false,
      showWeather: modeSections.weather.enabled, weatherStyle: modeSections.weather.style,
      modeLayout, modeSections,
      modeLayouts: normalizeModeLayouts(db.display.modeLayouts, db.display.sectionLayout),
      modeSectionsAll: normalizeModeSections(db.display.modeSections, db.display)
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
function plannerDateKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
function plannerStartOfDay(value) {
  const d = new Date(value); d.setHours(0, 0, 0, 0); return d;
}
function plannerEventsForDay(data, day) {
  const start = plannerStartOfDay(day), end = new Date(start); end.setDate(end.getDate() + 1);
  return (data.calendarEvents || data.events || []).filter(event => {
    const a = new Date(event.start), b = new Date(event.end || event.start);
    return a < end && b > start;
  });
}
function plannerTasksForDay(data, day) {
  const key = plannerDateKey(day);
  return (data.plannerTasks || data.tasks || []).filter(task => task.due && plannerDateKey(task.due) === key && task.status !== 'done');
}

function plannerAgendaTasksForDay(data, day) {
  const key = plannerDateKey(day);
  const todayKey = plannerDateKey(new Date());
  const todayStart = plannerStartOfDay(new Date());
  return (data.agendaTasks || data.plannerTasks || data.tasks || []).filter(task => {
    if (task.status === 'done' || task.displayEnabled === false) return false;
    if (!task.due) return key === todayKey;
    const due = new Date(task.due);
    if (Number.isNaN(due.getTime())) return false;
    if (plannerDateKey(due) === key) return true;
    return key === todayKey && due < todayStart;
  });
}
function plannerAgendaEntries(data) {
  const todayStart = plannerStartOfDay(new Date()).getTime();
  return [
    ...(data.calendarEvents || data.events || []).map(event => ({ kind:'event', when:new Date(event.start).getTime(), event })),
    ...(data.agendaTasks || []).map(task => ({ kind:'task', when:task.due ? new Date(task.due).getTime() : Number.MAX_SAFE_INTEGER, task }))
  ].sort((a,b) => {
    const ao = a.kind === 'task' && Number.isFinite(a.when) && a.when < todayStart;
    const bo = b.kind === 'task' && Number.isFinite(b.when) && b.when < todayStart;
    if (ao !== bo) return ao ? -1 : 1;
    return a.when - b.when;
  });
}
function plannerWeatherForDay(data, day) {
  const key = plannerDateKey(day);
  return data.weather?.days?.find(item => item.date === key) || null;
}
function parseHex(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value || ''));
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
}
function einkAccent(value, palette, fallback = 'blue') {
  if (palette === 'mono') return HEX.black;
  if (HEX[value]) return HEX[value];
  const rgb = parseHex(value);
  if (!rgb) return HEX[fallback] || HEX.blue;
  let best = HEX[fallback] || HEX.blue, bestDistance = Infinity;
  for (const candidate of Object.values(HEX)) {
    const c = parseHex(candidate);
    const distance = Math.pow(rgb.r - c.r, 2) + Math.pow(rgb.g - c.g, 2) + Math.pow(rgb.b - c.b, 2);
    if (distance < bestDistance) { bestDistance = distance; best = candidate; }
  }
  return best;
}
function plannerEventAccent(event, palette) {
  return einkAccent(event.eventColor || event.calendarColor, palette, 'blue');
}
function plannerWeatherAccent(type, palette) {
  if (palette === 'mono') return HEX.black;
  const t = String(type || '').toUpperCase();
  if (/THUNDER|STORM/.test(t)) return HEX.purple;
  if (/RAIN|DRIZZLE|SHOWERS/.test(t)) return HEX.blue;
  if (/SNOW|ICE|SLEET/.test(t)) return HEX.blue;
  if (/CLEAR|SUN/.test(t)) return HEX.yellow;
  if (/CLOUD|FOG|HAZE/.test(t)) return HEX.black;
  return HEX.green;
}
function svgWeatherIcon(type, x, y, size, palette) {
  const t = String(type || '').toUpperCase();
  const accent = plannerWeatherAccent(t, palette), black = '#111111';
  const sun = '<circle cx="' + (x + size * .42) + '" cy="' + (y + size * .42) + '" r="' + (size * .18) + '" fill="' + accent + '"/>' +
    '<path d="M' + (x + size * .42) + ' ' + y + 'v' + (size * .14) + 'M' + (x + size * .42) + ' ' + (y + size * .70) + 'v' + (size * .14) +
    'M' + x + ' ' + (y + size * .42) + 'h' + (size * .14) + 'M' + (x + size * .70) + ' ' + (y + size * .42) + 'h' + (size * .14) + '" stroke="' + accent + '" stroke-width="' + Math.max(1.5, size * .055) + '" stroke-linecap="round"/>';
  const cloud = '<path d="M' + (x + size * .18) + ' ' + (y + size * .57) + 'c0-' + (size * .12) + ' ' + (size * .10) + '-' + (size * .22) + ' ' + (size * .23) + '-' + (size * .22) +
    ' ' + (size * .05) + '-' + (size * .13) + ' ' + (size * .17) + '-' + (size * .21) + ' ' + (size * .31) + '-' + (size * .21) + ' ' + (size * .20) +
    ' 0 ' + (size * .36) + ' ' + (size * .16) + ' ' + (size * .36) + ' ' + (size * .35) + ' 0 ' + (size * .13) + '-' + (size * .10) + ' ' + (size * .24) +
    '-' + (size * .23) + ' ' + (size * .24) + 'H' + (x + size * .38) + 'c-' + (size * .11) + ' 0-' + (size * .20) + '-' + (size * .09) + '-' + (size * .20) + '-' + (size * .20) + 'z" fill="' + (palette === 'mono' ? black : '#777777') + '"/>';
  if (/CLEAR|SUN/.test(t) && !/CLOUD/.test(t)) return sun;
  if (/RAIN|DRIZZLE|SHOWERS/.test(t)) return cloud + '<path d="M' + (x + size*.34) + ' ' + (y+size*.78) + 'l-' + (size*.06) + ' ' + (size*.13) + 'M' + (x+size*.54) + ' ' + (y+size*.78) + 'l-' + (size*.06) + ' ' + (size*.13) + 'M' + (x+size*.74) + ' ' + (y+size*.78) + 'l-' + (size*.06) + ' ' + (size*.13) + '" stroke="' + accent + '" stroke-width="' + Math.max(1.5,size*.055) + '" stroke-linecap="round"/>';
  if (/SNOW|ICE|SLEET/.test(t)) return cloud + '<g fill="' + accent + '"><circle cx="' + (x+size*.34) + '" cy="' + (y+size*.86) + '" r="' + (size*.045) + '"/><circle cx="' + (x+size*.55) + '" cy="' + (y+size*.86) + '" r="' + (size*.045) + '"/><circle cx="' + (x+size*.76) + '" cy="' + (y+size*.86) + '" r="' + (size*.045) + '"/></g>';
  if (/THUNDER|STORM/.test(t)) return cloud + '<path d="M' + (x+size*.52) + ' ' + (y+size*.73) + 'h' + (size*.13) + 'l-' + (size*.12) + ' ' + (size*.20) + 'h' + (size*.12) + 'l-' + (size*.22) + ' ' + (size*.25) + ' ' + (size*.07) + '-' + (size*.22) + 'h-' + (size*.12) + 'z" fill="' + accent + '"/>';
  if (/PARTLY/.test(t)) return sun + cloud;
  return cloud;
}
function plannerFooter(svg, data, w, h, pad, scale, label) {
  const muted = '#666660';
  svg += '<text x="' + pad + '" y="' + (h - 10 * scale) + '" font-size="' + (9 * scale) + '" fill="' + muted + '">' + esc(label) + '</text>';
  svg += '<text x="' + (w - pad) + '" y="' + (h - 10 * scale) + '" text-anchor="end" font-size="' + (9 * scale) + '" fill="' + muted + '">Updated ' + esc(new Date(data.generatedAt).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })) + '</text>';
  return svg;
}
function renderPlannerSvg(data, w, h, mode) {
  const palette = data.display.palette, landscape = w >= h;
  const scale = Math.max(.62, Math.min(1.45, Math.min(w / 800, h / 480)));
  const pad = Math.max(12, Math.round(22 * scale)), black = '#111111', muted = '#666660', rule = '#d1d1ca', paper = '#ffffff';
  const now = new Date();
  const currentWeather = data.display.showWeather !== false ? data.weather?.current : null;
  const todayWeather = data.display.showWeather !== false ? plannerWeatherForDay(data, now) : null;
  const unit = data.weather?.unitSymbol || '';
  const location = data.weather?.locationLabel || '';
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"><rect width="100%" height="100%" fill="' + paper + '"/><style>text{font-family:Arial,Helvetica,sans-serif}.muted{fill:' + muted + '}.rule{stroke:' + rule + ';stroke-width:1}</style>';
  const headerY = 54 * scale;
  const timeText = now.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
  if (mode === 'daily') {
    svg += '<text x="' + pad + '" y="' + (18*scale) + '" font-size="' + (9*scale) + '" font-weight="800" letter-spacing="' + (1.4*scale) + '">' + esc(now.toLocaleDateString('en-CA', { weekday:'long', year:'numeric' }).toUpperCase()) + '</text>';
    svg += '<text x="' + pad + '" y="' + (43*scale) + '" font-size="' + (26*scale) + '" font-weight="800">' + esc(now.toLocaleDateString('en-CA', { month:'long', day:'numeric' })) + '</text>';
  } else if (mode === 'weekly') {
    const monday = plannerStartOfDay(now); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
    svg += '<text x="' + pad + '" y="' + (18*scale) + '" font-size="' + (9*scale) + '" font-weight="800" letter-spacing="' + (1.4*scale) + '">WEEK · ' + esc(String(now.getFullYear())) + '</text>';
    svg += '<text x="' + pad + '" y="' + (43*scale) + '" font-size="' + (25*scale) + '" font-weight="800">' + esc(monday.toLocaleDateString('en-CA',{month:'short',day:'numeric'}) + ' — ' + sunday.toLocaleDateString('en-CA',{month:'short',day:'numeric'})) + '</text>';
  } else {
    svg += '<text x="' + pad + '" y="' + (18*scale) + '" font-size="' + (9*scale) + '" font-weight="800" letter-spacing="' + (1.4*scale) + '">' + now.getFullYear() + '</text>';
    svg += '<text x="' + pad + '" y="' + (43*scale) + '" font-size="' + (26*scale) + '" font-weight="800">' + esc(now.toLocaleDateString('en-CA',{month:'long'})) + '</text>';
  }
  const viewLabel = mode === 'daily' ? 'DAY VIEW' : (mode === 'weekly' ? 'WEEK VIEW' : 'MONTH VIEW');
  svg += '<text x="' + (w-pad) + '" y="' + (15*scale) + '" text-anchor="end" font-size="' + (8*scale) + '" font-weight="800" letter-spacing="' + (1.1*scale) + '" class="muted">' + viewLabel + '</text>';
  svg += '<text x="' + (w - pad) + '" y="' + (39*scale) + '" text-anchor="end" font-size="' + (17*scale) + '" font-weight="800">' + esc(timeText) + '</text>';
  svg += '<line x1="' + pad + '" y1="' + headerY + '" x2="' + (w-pad) + '" y2="' + headerY + '" class="rule"/>';

  if (mode === 'daily') {
    const weatherStyle = en(data.display.weatherStyle, WEATHER_STYLES, 'forecast');
    const weatherH = currentWeather && landscape ? (weatherStyle === 'compact' ? 42*scale : 62*scale) : 0;
    const bottom = h - 24*scale - weatherH;
    const leftW = landscape ? (w - pad*2) * .55 : (w - pad*2);
    const rightX = pad + leftW + (landscape ? 18*scale : 0);
    const rightW = landscape ? w - pad - rightX : leftW;
    const dayStart = plannerStartOfDay(now), events = plannerEventsForDay(data, dayStart).slice(0, 7);
    svg += '<text x="' + pad + '" y="' + (headerY+22*scale) + '" font-size="' + (10*scale) + '" font-weight="800" letter-spacing="' + (1.5*scale) + '">TODAY</text>';
    svg += '<text x="' + (pad+leftW-12*scale) + '" y="' + (headerY+22*scale) + '" text-anchor="end" font-size="' + (9*scale) + '" class="muted">' + events.length + ' EVENT' + (events.length===1?'':'S') + '</text>';
    if (landscape) svg += '<line x1="' + (rightX-9*scale) + '" y1="' + (headerY+10*scale) + '" x2="' + (rightX-9*scale) + '" y2="' + bottom + '" class="rule"/>';
    let y = headerY + 42*scale, rowH = Math.max(38*scale, (bottom-y)/Math.max(4, events.length || 1));
    if (!events.length) svg += '<text x="' + pad + '" y="' + (y+18*scale) + '" font-size="' + (13*scale) + '" class="muted">Nothing scheduled.</text>';
    for (const event of events) {
      if (y + rowH > bottom) break;
      const d = new Date(event.start), when = event.allDay ? 'All day' : d.toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit'});
      const accent = plannerEventAccent(event, palette);
      svg += '<line x1="' + pad + '" y1="' + y + '" x2="' + (pad+leftW-12*scale) + '" y2="' + y + '" class="rule"/>';
      svg += '<text x="' + pad + '" y="' + (y+22*scale) + '" font-size="' + (11*scale) + '" class="muted">' + esc(when) + '</text>';
      svg += '<circle cx="' + (pad+78*scale) + '" cy="' + (y+18*scale) + '" r="' + (4.5*scale) + '" fill="' + accent + '"/>';
      svg += '<text x="' + (pad+91*scale) + '" y="' + (y+20*scale) + '" font-size="' + (13.5*scale) + '" font-weight="700">' + esc(truncateForWidth(event.title, leftW-95*scale, 13.5*scale)) + '</text>';
      if (event.calendarName) svg += '<text x="' + (pad+91*scale) + '" y="' + (y+34*scale) + '" font-size="' + (9.5*scale) + '" class="muted">' + esc(truncateForWidth(event.calendarName, leftW-95*scale, 9.5*scale)) + '</text>';
      y += rowH;
    }
    if (landscape) {
      let ry = headerY + 22*scale;
      if (data.display.showTasks !== false) {
        svg += '<text x="' + rightX + '" y="' + ry + '" font-size="' + (10*scale) + '" font-weight="800" letter-spacing="' + (1.5*scale) + '">TASKS</text>'; ry += 18*scale;
        for (const task of (data.tasks||[]).slice(0,3)) {
          svg += '<rect x="' + rightX + '" y="' + (ry-9*scale) + '" width="' + (10*scale) + '" height="' + (10*scale) + '" rx="' + (1.5*scale) + '" fill="#fff" stroke="' + black + '"/>';
          svg += '<text x="' + (rightX+18*scale) + '" y="' + ry + '" font-size="' + (11.5*scale) + '">' + esc(truncateForWidth(task.title,rightW-20*scale,11.5*scale)) + '</text>'; ry += 24*scale;
        }
      }
      if (data.display.showGoals !== false && (data.goals||[]).length) {
        ry += 7*scale; svg += '<line x1="' + rightX + '" y1="' + ry + '" x2="' + (w-pad) + '" y2="' + ry + '" class="rule"/>'; ry += 22*scale;
        svg += '<text x="' + rightX + '" y="' + ry + '" font-size="' + (10*scale) + '" font-weight="800" letter-spacing="' + (1.5*scale) + '">GOALS</text>'; ry += 17*scale;
        for (const goal of (data.goals||[]).slice(0,2)) {
          svg += '<text x="' + rightX + '" y="' + ry + '" font-size="' + (11.5*scale) + '" font-weight="700">' + esc(truncateForWidth(goal.title,rightW,11.5*scale,38*scale)) + '</text>';
          svg += '<text x="' + (w-pad) + '" y="' + ry + '" text-anchor="end" font-size="' + (10*scale) + '" font-weight="700">' + Math.round(goal.progress) + '%</text>';
          svg += svgBar(goal.progress,rightX,ry+7*scale,rightW,6*scale,color(goal.accentColor,palette)); ry += 31*scale;
        }
      }
      if (data.display.showCountdowns !== false && (data.countdowns||[]).length) {
        ry += 3*scale; svg += '<line x1="' + rightX + '" y1="' + ry + '" x2="' + (w-pad) + '" y2="' + ry + '" class="rule"/>'; ry += 22*scale;
        svg += '<text x="' + rightX + '" y="' + ry + '" font-size="' + (10*scale) + '" font-weight="800" letter-spacing="' + (1.5*scale) + '">COUNTDOWNS</text>'; ry += 18*scale;
        for (const c of (data.countdowns||[]).slice(0,2)) {
          svg += '<circle cx="' + (rightX+4*scale) + '" cy="' + (ry-4*scale) + '" r="' + (4*scale) + '" fill="' + color(c.accentColor,palette) + '"/>';
          svg += '<text x="' + (rightX+15*scale) + '" y="' + ry + '" font-size="' + (11*scale) + '" font-weight="700">' + esc(truncateForWidth(c.name,rightW*.6,11*scale)) + '</text>';
          svg += '<text x="' + (w-pad) + '" y="' + ry + '" text-anchor="end" font-size="' + (11*scale) + '" font-weight="800" fill="' + color(c.accentColor,palette) + '">' + esc(timeLabel(c)) + '</text>'; ry += 24*scale;
        }
      }
      const nextLater = (data.calendarEvents||[]).find(event => new Date(event.start) > new Date(dayStart.getTime()+86400000));
      if (nextLater && ry < bottom-20*scale) {
        ry += 5*scale; svg += '<line x1="' + rightX + '" y1="' + ry + '" x2="' + (w-pad) + '" y2="' + ry + '" class="rule"/>'; ry += 18*scale;
        svg += '<text x="' + rightX + '" y="' + ry + '" font-size="' + (8.5*scale) + '" class="muted">NEXT · ' + esc(new Date(nextLater.start).toLocaleDateString('en-CA',{month:'short',day:'numeric'})) + ' · ' + esc(truncateForWidth(nextLater.title,rightW-70*scale,8.5*scale)) + '</text>';
      }
    }
    if (currentWeather && landscape) {
      const wy = h - (weatherStyle === 'compact' ? 60*scale : 82*scale);
      const wh = weatherStyle === 'compact' ? 36*scale : 58*scale;
      svg += '<rect x="' + pad + '" y="' + wy + '" width="' + (w-pad*2) + '" height="' + wh + '" rx="' + (6*scale) + '" fill="#f1f1ed"/>';
      if (weatherStyle === 'forecast') {
        const days = (data.weather?.days || []).slice(0,5);
        const left = pad + 10*scale;
        svg += svgWeatherIcon(currentWeather.condition,left,wy+10*scale,30*scale,palette);
        svg += '<text x="' + (left+39*scale) + '" y="' + (wy+24*scale) + '" font-size="' + (14*scale) + '" font-weight="800">' + esc((currentWeather.temperature ?? '—') + unit) + '</text>';
        let fx = pad + 170*scale;
        const fw = Math.max(60*scale,(w-pad-fx)/Math.max(1,days.length));
        days.forEach((day,index)=>{
          const dx=fx+index*fw;
          svg += '<text x="' + dx + '" y="' + (wy+16*scale) + '" font-size="' + (8*scale) + '" font-weight="800" class="muted">' + esc(index===0?'TODAY':new Date(day.date+'T12:00:00').toLocaleDateString('en-CA',{weekday:'short'}).toUpperCase()) + '</text>';
          svg += svgWeatherIcon(day.daytime?.condition,dx,wy+22*scale,20*scale,palette);
          svg += '<text x="' + (dx+25*scale) + '" y="' + (wy+37*scale) + '" font-size="' + (9*scale) + '" font-weight="800">' + esc((day.high??'—')+'°/'+(day.low??'—')+'°') + '</text>';
        });
      } else {
        svg += svgWeatherIcon(currentWeather.condition,pad+10*scale,wy+(weatherStyle==='compact'?5:11)*scale,(weatherStyle==='compact'?26:34)*scale,palette);
        svg += '<text x="' + (pad+48*scale) + '" y="' + (wy+(weatherStyle==='compact'?23:25)*scale) + '" font-size="' + (weatherStyle==='compact'?13:15)*scale + '" font-weight="800">' + esc((currentWeather.temperature ?? '—') + unit) + '</text>';
        svg += '<text x="' + (pad+95*scale) + '" y="' + (wy+(weatherStyle==='compact'?23:25)*scale) + '" font-size="' + (10*scale) + '" class="muted">' + esc(currentWeather.description || '') + (location?' · '+esc(location):'') + '</text>';
        if (weatherStyle === 'current' && todayWeather) {
          svg += '<text x="' + (w-pad-8*scale) + '" y="' + (wy+24*scale) + '" text-anchor="end" font-size="' + (11*scale) + '" font-weight="800">H ' + esc((todayWeather.high ?? '—')+unit) + '  L ' + esc((todayWeather.low ?? '—')+unit) + ' · ' + Math.round(todayWeather.daytime?.precipitation||0) + '%</text>';
        }
      }
    }
    return plannerFooter(svg,data,w,h,pad,scale,'DAILY' + (data.weather ? ' · Weather: Open-Meteo' : '')) + '</svg>';
  }

  if (mode === 'weekly') {
    const monday = plannerStartOfDay(now); monday.setDate(monday.getDate() - ((monday.getDay()+6)%7));
    const top = headerY + 8*scale, bottom = h - 28*scale, rowH = (bottom-top)/7;
    for (let i=0;i<7;i++) {
      const day = new Date(monday); day.setDate(day.getDate()+i);
      const isToday = plannerDateKey(day) === plannerDateKey(now);
      const y = top + i*rowH, weather = data.display.showWeather !== false ? plannerWeatherForDay(data,day) : null;
      if (isToday) svg += '<rect x="' + pad + '" y="' + y + '" width="' + (w-pad*2) + '" height="' + rowH + '" rx="' + (5*scale) + '" fill="#f0f0ec"/>';
      svg += '<line x1="' + pad + '" y1="' + (y+rowH) + '" x2="' + (w-pad) + '" y2="' + (y+rowH) + '" class="rule"/>';
      svg += '<text x="' + (pad+4*scale) + '" y="' + (y+17*scale) + '" font-size="' + (8.5*scale) + '" font-weight="800">' + esc(day.toLocaleDateString('en-CA',{weekday:'short'}).toUpperCase()) + '</text>';
      svg += '<text x="' + (pad+4*scale) + '" y="' + (y+38*scale) + '" font-size="' + (18*scale) + '" font-weight="800">' + day.getDate() + '</text>';
      let eventX = pad + 162*scale;
      if (weather) {
        svg += svgWeatherIcon(weather.daytime?.condition,eventX-82*scale,y+8*scale,28*scale,palette);
        svg += '<text x="' + (eventX-48*scale) + '" y="' + (y+24*scale) + '" font-size="' + (10.5*scale) + '" font-weight="800">' + esc((weather.high??'—') + '°/' + (weather.low??'—') + '°') + '</text>';
      }
      const events = plannerEventsForDay(data,day).slice(0,2), tasks = plannerTasksForDay(data,day).slice(0,1);
      let ey = y + 19*scale;
      for (const event of events) {
        svg += '<circle cx="' + eventX + '" cy="' + (ey-4*scale) + '" r="' + (4*scale) + '" fill="' + plannerEventAccent(event,palette) + '"/>';
        svg += '<text x="' + (eventX+12*scale) + '" y="' + ey + '" font-size="' + (11.5*scale) + '" font-weight="700">' + esc(truncateForWidth(event.title,w-eventX-pad-80*scale,11.5*scale)) + '</text>';
        if (!event.allDay) svg += '<text x="' + (w-pad) + '" y="' + ey + '" text-anchor="end" font-size="' + (10*scale) + '" class="muted">' + esc(new Date(event.start).toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit'})) + '</text>';
        ey += 20*scale;
      }
      for (const task of tasks) {
        svg += '<rect x="' + eventX + '" y="' + (ey-11*scale) + '" width="' + (8*scale) + '" height="' + (8*scale) + '" fill="#fff" stroke="' + black + '"/>';
        svg += '<text x="' + (eventX+12*scale) + '" y="' + (ey-3*scale) + '" font-size="' + (10.5*scale) + '" class="muted">' + esc(truncateForWidth(task.title,w-eventX-pad,10.5*scale)) + '</text>';
      }
    }
    const weekEnd = new Date(monday); weekEnd.setDate(weekEnd.getDate()+7);
    const weekEvents = (data.calendarEvents || []).filter(event => new Date(event.start) < weekEnd && new Date(event.end || event.start) > monday).length;
    const weekTasks = (data.plannerTasks || []).filter(task => task.due && new Date(task.due) >= monday && new Date(task.due) < weekEnd && task.status !== 'done').length;
    return plannerFooter(svg,data,w,h,pad,scale,weekEvents + ' EVENTS · ' + weekTasks + ' TASKS' + (location?' · '+location:'') + (data.weather ? ' · Open-Meteo' : '')) + '</svg>';
  }

  const monthStart = new Date(now.getFullYear(),now.getMonth(),1);
  const firstOffset = (monthStart.getDay()+6)%7;
  const gridStart = new Date(monthStart); gridStart.setDate(gridStart.getDate()-firstOffset);
  const sideW = landscape ? Math.max(185*scale,(w-pad*2)*.28) : 0;
  const gridW = landscape ? w-pad*2-sideW-14*scale : w-pad*2;
  const gridX = pad, gridTop = headerY + 24*scale, dayHeadH = 19*scale, gridBottom = h-30*scale, cellH=(gridBottom-gridTop-dayHeadH)/6, cellW=gridW/7;
  ['MON','TUE','WED','THU','FRI','SAT','SUN'].forEach((label,i)=>svg += '<text x="' + (gridX+i*cellW+cellW/2) + '" y="' + (gridTop+12*scale) + '" text-anchor="middle" font-size="' + (7.5*scale) + '" font-weight="800">' + label + '</text>');
  for(let i=0;i<42;i++){
    const day=new Date(gridStart);day.setDate(day.getDate()+i);
    const row=Math.floor(i/7),col=i%7,x=gridX+col*cellW,y=gridTop+dayHeadH+row*cellH,isMonth=day.getMonth()===now.getMonth(),isToday=plannerDateKey(day)===plannerDateKey(now);
    svg += '<rect x="' + x + '" y="' + y + '" width="' + cellW + '" height="' + cellH + '" fill="' + (isToday?black:'#fff') + '" stroke="' + rule + '" stroke-width="1"/>';
    svg += '<text x="' + (x+6*scale) + '" y="' + (y+14*scale) + '" font-size="' + (9.5*scale) + '" font-weight="' + (isToday?'800':'600') + '" fill="' + (isToday?'#ffffff':(isMonth?black:'#999999')) + '">' + day.getDate() + '</text>';
    const weather=data.display.showWeather!==false?plannerWeatherForDay(data,day):null;
    if(weather&&isMonth&&!isToday)svg += svgWeatherIcon(weather.daytime?.condition,x+cellW-24*scale,y+4*scale,18*scale,palette);
    const dots=plannerEventsForDay(data,day).slice(0,3);
    dots.forEach((event,j)=>svg += '<circle cx="' + (x+9*scale+j*10*scale) + '" cy="' + (y+cellH-8*scale) + '" r="' + (3*scale) + '" fill="' + plannerEventAccent(event,palette) + '"/>');
  }
  if(landscape){
    const sx=gridX+gridW+14*scale,sw=w-pad-sx;
    svg += '<line x1="' + (sx-7*scale) + '" y1="' + gridTop + '" x2="' + (sx-7*scale) + '" y2="' + gridBottom + '" class="rule"/>';
    let sy=gridTop+13*scale;
    const todays=plannerEventsForDay(data,now).slice(0,4);
    svg += '<line x1="' + sx + '" y1="' + sy + '" x2="' + (w-pad) + '" y2="' + sy + '" class="rule"/>';sy+=19*scale;
    svg += '<text x="' + sx + '" y="' + sy + '" font-size="' + (9*scale) + '" font-weight="800" letter-spacing="' + (1.2*scale) + '">AGENDA</text>';sy+=19*scale;
    for(const event of todays){
      svg += '<circle cx="' + (sx+3*scale) + '" cy="' + (sy-4*scale) + '" r="' + (3.5*scale) + '" fill="' + plannerEventAccent(event,palette) + '"/>';
      svg += '<text x="' + (sx+12*scale) + '" y="' + sy + '" font-size="' + (10.5*scale) + '" font-weight="700">' + esc(truncateForWidth(event.title,sw-12*scale,10.5*scale,50*scale)) + '</text>';
      svg += '<text x="' + (w-pad) + '" y="' + sy + '" text-anchor="end" font-size="' + (8.5*scale) + '" class="muted">' + esc(event.allDay?'All day':new Date(event.start).toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit'})) + '</text>';sy+=22*scale;
    }
    const next=(data.countdowns||[])[0];
    if(next&&sy<gridBottom-45*scale){
      sy+=5*scale;svg += '<line x1="' + sx + '" y1="' + sy + '" x2="' + (w-pad) + '" y2="' + sy + '" class="rule"/>';sy+=20*scale;
      svg += '<text x="' + sx + '" y="' + sy + '" font-size="' + (9*scale) + '" font-weight="800" letter-spacing="' + (1.2*scale) + '">COMING UP</text>';sy+=22*scale;
      svg += '<text x="' + sx + '" y="' + sy + '" font-size="' + (11*scale) + '" font-weight="700">' + esc(truncateForWidth(next.name,sw,11*scale,70*scale)) + '</text><text x="' + (w-pad) + '" y="' + sy + '" text-anchor="end" font-size="' + (11*scale) + '" font-weight="800" fill="' + color(next.accentColor,palette) + '">' + esc(timeLabel(next)) + '</text>';
    }
  }
  return plannerFooter(svg,data,w,h,pad,scale,(location?location+' · ':'')+'MONTHLY · 10-day forecast' + (data.weather ? ' · Open-Meteo' : '')) + '</svg>';
}

function renderSvg(data, w, h) {
  const palette = data.display.palette;
  const portrait = data.display.layout === 'portrait' || (data.display.layout === 'auto' && h > w);
  const pad = Math.max(12, Math.round(Math.min(w, h) * 0.026));
  const black = '#111111', muted = '#666660', rule = '#c9c9c2';
  const now = new Date();
  const dateText = now.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
  const modeLabel = ({ dashboard:'DASHBOARD', daily:'DAY', weekly:'WEEK', monthly:'MONTH', countdowns:'COUNTDOWNS' })[data.display.mode] || 'PLANNER';
  const timeText = now.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"><rect width="100%" height="100%" fill="#ffffff"/><style>text{font-family:Arial,Helvetica,sans-serif}.k{font-size:11px;font-weight:700;letter-spacing:1.5px}.muted{fill:' + muted + '}.line{stroke:' + rule + ';stroke-width:1}.section-box{fill:#fff;stroke:' + rule + ';stroke-width:1}</style>';

  const headerY = pad + 15;
  svg += '<text x="' + pad + '" y="' + headerY + '" font-size="' + (portrait ? 11 : 12) + '" font-weight="800" letter-spacing="1">' + esc(dateText) + '</text>';
  svg += '<text x="' + (w - pad) + '" y="' + headerY + '" text-anchor="end" font-size="' + (portrait ? 10 : 11) + '" font-weight="800" letter-spacing="1">' + esc(modeLabel + ' · ' + timeText) + '</text>';
  svg += '<line x1="' + pad + '" y1="' + (pad + 23) + '" x2="' + (w - pad) + '" y2="' + (pad + 23) + '" class="line"/>';

  const activeSections = normalizeSectionSettings(data.display.modeSections, data.display.mode);
  const availableKinds = DISPLAY_SECTION_KEYS.filter(kind => activeSections[kind]?.enabled);

  const sectionData = {
    agenda: plannerAgendaEntries(data),
    weather: data.weather ? [data.weather] : [],
    tasks: data.tasks || [],
    goals: data.goals || [],
    countdowns: data.countdowns || [],
    markets: data.markets?.quotes || []
  };

  function drawEmptySection(kind, x, y, width) {
    const label = { agenda: 'AGENDA', weather: 'WEATHER', tasks: 'TASKS', goals: 'GOALS', countdowns: 'COUNTDOWNS', markets: 'MARKETS' }[kind];
    svg += sectionTitle(label, x, y + 11);
    svg += '<text x="' + x + '" y="' + (y + 37) + '" font-size="12" class="muted">Nothing to show.</text>';
  }

  function drawSection(kind, x, y, width, maxHeight, options = {}) {
    const clipId = options.clipId || '';
    if (clipId) svg += '<g clip-path="url(#' + clipId + ')">';
    let cursor = y;
    const label = { agenda: 'AGENDA', weather: 'WEATHER', tasks: 'TASKS', goals: 'GOALS', countdowns: 'COUNTDOWNS', markets: 'MARKETS' }[kind];
    const items = sectionData[kind] || [];
    svg += sectionTitle(label, x, cursor + 11);
    cursor += 22;

    if (!items.length) {
      svg += '<text x="' + x + '" y="' + (cursor + 15) + '" font-size="12" class="muted">Nothing to show.</text>';
      if (clipId) svg += '</g>';
      return Math.min(maxHeight, cursor - y + 18);
    }

    if (kind === 'agenda') {
      const agendaStyle = activeSections.agenda.style;
      if (agendaStyle === 'week') {
        const monday = plannerStartOfDay(new Date()); monday.setDate(monday.getDate() - ((monday.getDay()+6)%7));
        const rowH = Math.max(22, Math.min(42, (maxHeight-24)/7));
        for (let i=0;i<7 && cursor+rowH<=y+maxHeight;i++) {
          const day=new Date(monday);day.setDate(day.getDate()+i);
          const dayEntries=[
            ...plannerEventsForDay(data,day).map(event=>({kind:'event',event})),
            ...plannerAgendaTasksForDay(data,day).map(task=>({kind:'task',task}))
          ].slice(0,2);
          svg += '<line x1="' + x + '" y1="' + cursor + '" x2="' + (x+width) + '" y2="' + cursor + '" class="line"/>';
          svg += '<text x="' + x + '" y="' + (cursor+15) + '" font-size="9" font-weight="800">' + esc(day.toLocaleDateString('en-CA',{weekday:'short'}).toUpperCase()+' '+day.getDate()) + '</text>';
          let tx=x+58;
          for (const entry of dayEntries) {
            if(entry.kind==='task'){
              svg += '<rect x="' + (tx-3) + '" y="' + (cursor+7) + '" width="7" height="7" rx="1" fill="#fff" stroke="' + black + '"/>';
              svg += '<text x="' + (tx+8) + '" y="' + (cursor+15) + '" font-size="9.5">' + esc(truncateForWidth(entry.task.title,Math.max(50,width-(tx-x)-8),9.5)) + '</text>';
            }else{
              const accent=plannerEventAccent(entry.event,palette);
              svg += '<circle cx="' + tx + '" cy="' + (cursor+11) + '" r="3" fill="' + accent + '"/>';
              svg += '<text x="' + (tx+7) + '" y="' + (cursor+15) + '" font-size="9.5">' + esc(truncateForWidth(entry.event.title,Math.max(50,width-(tx-x)-8),9.5)) + '</text>';
            }
            tx += Math.max(90,width*.4);
          }
          cursor += rowH;
        }
      } else if (agendaStyle === 'calendar') {
        const now=new Date(), first=new Date(now.getFullYear(),now.getMonth(),1), offset=(first.getDay()+6)%7, start=new Date(first);start.setDate(start.getDate()-offset);
        const cellW=width/7, cellH=Math.max(26,Math.min(50,(maxHeight-24)/6));
        ['M','T','W','T','F','S','S'].forEach((d,i)=>svg += '<text x="' + (x+i*cellW+cellW/2) + '" y="' + (cursor+9) + '" text-anchor="middle" font-size="7.5" font-weight="800" class="muted">' + d + '</text>');
        cursor += 13;
        for(let i=0;i<42 && cursor+cellH<=y+maxHeight;i++){
          const day=new Date(start);day.setDate(start.getDate()+i);const col=i%7,row=Math.floor(i/7),cx=x+col*cellW,cy=cursor+row*cellH;
          svg += '<rect x="' + cx + '" y="' + cy + '" width="' + cellW + '" height="' + cellH + '" fill="none" stroke="' + rule + '"/>';
          svg += '<text x="' + (cx+4) + '" y="' + (cy+11) + '" font-size="8">' + day.getDate() + '</text>';
          const dayEvents=plannerEventsForDay(data,day).slice(0,2);
          const dayTasks=plannerAgendaTasksForDay(data,day).slice(0,Math.max(0,3-dayEvents.length));
          dayEvents.forEach((event,j)=>svg += '<circle cx="' + (cx+6+j*8) + '" cy="' + (cy+cellH-6) + '" r="2.5" fill="' + plannerEventAccent(event,palette) + '"/>');
          dayTasks.forEach((task,j)=>{const px=cx+6+(dayEvents.length+j)*8;svg += '<rect x="' + (px-2.5) + '" y="' + (cy+cellH-8.5) + '" width="5" height="5" fill="#fff" stroke="' + black + '"/>';});
        }
        cursor += cellH*6;
      } else {
        const timeline = agendaStyle === 'timeline';
        for (const entry of items.slice(0,activeSections.agenda.limit)) {
          if (cursor + 34 > y + maxHeight) break;
          svg += '<line x1="' + x + '" y1="' + cursor + '" x2="' + (x + width) + '" y2="' + cursor + '" class="line"/>';
          if (entry.kind === 'task') {
            const task = entry.task;
            const due = task.due ? new Date(task.due) : null;
            const overdue = due && due < plannerStartOfDay(new Date());
            const when = overdue ? 'Overdue' : (due ? due.toLocaleDateString('en-CA',{month:'short',day:'numeric'}) : 'Anytime');
            if (timeline) {
              svg += '<text x="' + x + '" y="' + (cursor+20) + '" font-size="9" font-weight="800">TASK</text>';
              svg += '<rect x="' + (x+57) + '" y="' + (cursor+11) + '" width="10" height="10" rx="2" fill="#fff" stroke="' + black + '"/>';
              svg += '<text x="' + (x+75) + '" y="' + (cursor+20) + '" font-size="13" font-weight="700">' + esc(truncateForWidth(task.title,width-75,13,72)) + '</text>';
              svg += '<text x="' + (x+width) + '" y="' + (cursor+20) + '" text-anchor="end" font-size="9.5" class="muted">' + esc(when) + '</text>';
            } else {
              svg += '<rect x="' + x + '" y="' + (cursor+11) + '" width="10" height="10" rx="2" fill="#fff" stroke="' + black + '"/>';
              svg += '<text x="' + (x+18) + '" y="' + (cursor+20) + '" font-size="13" font-weight="700">' + esc(truncateForWidth(task.title,width-18,13,72)) + '</text>';
              svg += '<text x="' + (x+width) + '" y="' + (cursor+20) + '" text-anchor="end" font-size="10" class="muted">' + esc(when) + '</text>';
            }
          } else {
            const event = entry.event;
            const d = new Date(event.start);
            const when = event.allDay ? 'All day' : d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
            const accent = plannerEventAccent(event, palette);
            if (timeline) {
              svg += '<text x="' + x + '" y="' + (cursor+20) + '" font-size="10" class="muted">' + esc(when) + '</text>';
              svg += '<circle cx="' + (x+61) + '" cy="' + (cursor+16) + '" r="4" fill="' + accent + '"/>';
              svg += '<text x="' + (x+72) + '" y="' + (cursor+20) + '" font-size="13" font-weight="700">' + esc(truncateForWidth(event.title,width-72,13)) + '</text>';
            } else {
              svg += '<circle cx="' + (x+4) + '" cy="' + (cursor+16) + '" r="4" fill="' + accent + '"/>';
              svg += '<text x="' + (x+14) + '" y="' + (cursor+20) + '" font-size="13" font-weight="700">' + esc(truncateForWidth(event.title,width-14,13,80)) + '</text>';
              svg += '<text x="' + (x+width) + '" y="' + (cursor+20) + '" text-anchor="end" font-size="10" class="muted">' + esc(when) + '</text>';
            }
          }
          cursor += 32;
        }
      }
    }
    if (kind === 'weather') {
      const weather = data.weather;
      const style = activeSections.weather.style;
      if (weather?.current) {
        const current = weather.current, today = (weather.days||[])[0], unitSymbol = weather.unitSymbol || '';
        if (style === 'compact') {
          svg += svgWeatherIcon(current.condition,x,cursor+2,28,palette);
          svg += '<text x="' + (x+38) + '" y="' + (cursor+20) + '" font-size="17" font-weight="800">' + esc((current.temperature??'—')+unitSymbol) + '</text>';
          svg += '<text x="' + (x+86) + '" y="' + (cursor+20) + '" font-size="11" class="muted">' + esc(truncateForWidth(current.description||'',width-90,11,76)) + '</text>';
          if(today) svg += '<text x="' + (x+width) + '" y="' + (cursor+20) + '" text-anchor="end" font-size="10" font-weight="700">H ' + esc((today.high??'—')+unitSymbol) + ' · L ' + esc((today.low??'—')+unitSymbol) + '</text>';
          cursor += 34;
        } else if (style === 'current') {
          svg += svgWeatherIcon(current.condition,x,cursor+3,40,palette);
          svg += '<text x="' + (x+52) + '" y="' + (cursor+24) + '" font-size="22" font-weight="800">' + esc((current.temperature??'—')+unitSymbol) + '</text>';
          svg += '<text x="' + (x+52) + '" y="' + (cursor+41) + '" font-size="10" class="muted">' + esc(truncateForWidth(current.description||'',width-54,10)) + '</text>';
          svg += '<text x="' + x + '" y="' + (cursor+61) + '" font-size="9.5" class="muted">Feels ' + esc((current.feelsLike??'—')+unitSymbol) + ' · ' + Math.round(current.humidity||0) + '% humidity · ' + Math.round(current.windSpeed||0) + (weather.units==='imperial'?' mph':' km/h') + '</text>';
          cursor += 72;
        } else {
          svg += svgWeatherIcon(current.condition,x,cursor+1,30,palette);
          svg += '<text x="' + (x+40) + '" y="' + (cursor+20) + '" font-size="17" font-weight="800">' + esc((current.temperature??'—')+unitSymbol) + '</text>';
          const days=(weather.days||[]).slice(0,activeSections.weather.limit);
          const startY=cursor+36, cellW=Math.max(46,(width-2)/Math.max(1,days.length));
          days.forEach((day,index)=>{
            const dx=x+index*cellW;
            svg += '<text x="' + dx + '" y="' + startY + '" font-size="8.5" font-weight="800" class="muted">' + esc(index===0?'TODAY':new Date(day.date+'T12:00:00').toLocaleDateString('en-CA',{weekday:'short'}).toUpperCase()) + '</text>';
            svg += svgWeatherIcon(day.daytime?.condition,dx,startY+5,20,palette);
            svg += '<text x="' + (dx+24) + '" y="' + (startY+20) + '" font-size="9" font-weight="800">' + esc((day.high??'—')+'°/'+(day.low??'—')+'°') + '</text>';
          });
          cursor += 68;
        }
        if (weather.locationLabel && cursor + 12 <= y + maxHeight) {
          svg += '<text x="' + x + '" y="' + Math.min(y+maxHeight-2,cursor+2) + '" font-size="8.5" class="muted">' + esc(truncateForWidth(weather.locationLabel,width,8.5)) + '</text>';
        }
      }
    }
    if (kind === 'tasks') {
      const taskStyle=activeSections.tasks.style;
      for (const task of items.slice(0,activeSections.tasks.limit)) {
        if (cursor + 29 > y + maxHeight) break;
        const due = task.due ? new Date(task.due).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '';
        const title = truncateForWidth(task.title, width - 18, 13, due ? Math.min(74, width * 0.24) : 0);
        svg += '<line x1="' + x + '" y1="' + cursor + '" x2="' + (x + width) + '" y2="' + cursor + '" class="line"/>';
        if(taskStyle==='checklist') svg += '<rect x="' + x + '" y="' + (cursor + 9) + '" width="10" height="10" rx="2" fill="#fff" stroke="' + black + '"/>';
        svg += '<text x="' + (x + (taskStyle==='checklist'?18:0)) + '" y="' + (cursor + 19) + '" font-size="' + (taskStyle==='compact'?11:13) + '" font-weight="700">' + esc(title) + '</text>';
        if (due) svg += '<text x="' + (x + width) + '" y="' + (cursor + 19) + '" text-anchor="end" font-size="11" class="muted">' + esc(due) + '</text>';
        cursor += 28;
      }
    }
    if (kind === 'goals') {
      for (const goal of items.slice(0,activeSections.goals.limit)) {
        if (cursor + 47 > y + maxHeight) break;
        const accent = color(goal.accentColor, palette);
        const title = truncateForWidth(goal.title, width, 13, 48);
        svg += '<text x="' + x + '" y="' + (cursor + 15) + '" font-size="13" font-weight="700">' + esc(title) + '</text>';
        svg += '<text x="' + (x + width) + '" y="' + (cursor + 15) + '" text-anchor="end" font-size="12" font-weight="700">' + Math.round(goal.progress) + '%</text>';
        if(activeSections.goals.style==='bars') svg += svgBar(goal.progress, x, cursor + 24, width, 7, accent);
        cursor += activeSections.goals.style==='bars'?44:26;
      }
    }
    if (kind === 'countdowns') {
      for (const countdown of items.slice(0,activeSections.countdowns.limit)) {
        if (cursor + 39 > y + maxHeight) break;
        const accent = color(countdown.accentColor, palette);
        const labelText = timeLabel(countdown);
        const title = truncateForWidth(countdown.name, width - 12, 13, Math.min(100, width * 0.34));
        svg += '<rect x="' + x + '" y="' + (cursor + 4) + '" width="4" height="26" rx="2" fill="' + accent + '"/>';
        svg += '<text x="' + (x + 12) + '" y="' + (cursor + 16) + '" font-size="13" font-weight="700">' + esc(title) + '</text>';
        svg += '<text x="' + (x + width) + '" y="' + (cursor + 16) + '" text-anchor="end" font-size="14" font-weight="800" fill="' + accent + '">' + esc(labelText) + '</text>';
        if (activeSections.countdowns.style==='detailed' && countdown.showExactDate) svg += '<text x="' + (x + 12) + '" y="' + (cursor + 31) + '" font-size="10" class="muted">' + esc(formatDateServer(countdown.end, countdown.dateDisplayStyle)) + '</text>';
        cursor += activeSections.countdowns.style==='detailed'?38:25;
      }
    }
    if (kind === 'markets') {
      const style = activeSections.markets.style;
      const visible = items.slice(0, activeSections.markets.limit);
      for (const quote of visible) {
        const compact = style === 'compact';
        const rowH = compact ? 22 : 31;
        if (cursor + rowH > y + maxHeight) break;
        const pct = Number(quote.percentChange);
        const available = quote.available !== false && quote.close != null;
        const change = available && Number.isFinite(pct) ? pct : null;
        const accent = palette === 'mono' ? black : (change > 0 ? HEX.green : change < 0 ? HEX.red : black);
        const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '•';
        svg += '<line x1="' + x + '" y1="' + cursor + '" x2="' + (x + width) + '" y2="' + cursor + '" class="line"/>';
        svg += '<text x="' + x + '" y="' + (cursor + (compact?15:18)) + '" font-size="' + (compact?10.5:12.5) + '" font-weight="800">' + esc(quote.symbol) + '</text>';
        if (style === 'ticker' && quote.name) svg += '<text x="' + (x+58) + '" y="' + (cursor+18) + '" font-size="9" class="muted">' + esc(truncateForWidth(quote.name,Math.max(50,width-150),9)) + '</text>';
        svg += '<text x="' + (x + width - 58) + '" y="' + (cursor + (compact?15:18)) + '" text-anchor="end" font-size="' + (compact?10.5:12) + '" font-weight="700">' + esc(available?Number(quote.close).toFixed(2):'N/A') + '</text>';
        svg += '<text x="' + (x + width) + '" y="' + (cursor + (compact?15:18)) + '" text-anchor="end" font-size="' + (compact?9.5:11) + '" font-weight="800" fill="' + accent + '">' + (available ? arrow + ' ' + esc(Math.abs(change||0).toFixed(2)) + '%' : 'Unavailable') + '</text>';
        cursor += rowH;
      }
    }
    if (clipId) svg += '</g>';
    return cursor - y;
  }

  const top = pad + 31;
  const available = h - top - 18;
  const custom = true;

  if (custom) {
    const contentWidth = w - pad * 2;
    const layout = normalizeSectionLayout(data.display.modeLayout, data.display.mode);
    const order = normalizeSectionOrder(data.display.sectionOrder);
    let defs = '';
    const drawQueue = [];
    for (const kind of order) {
      if (!availableKinds.includes(kind)) continue;
      const r = layout[kind];
      const x = pad + contentWidth * r.x / DISPLAY_GRID_COLS;
      const y = top + available * r.y / DISPLAY_GRID_ROWS;
      const width = contentWidth * r.w / DISPLAY_GRID_COLS;
      const height = available * r.h / DISPLAY_GRID_ROWS;
      const inset = Math.max(5, Math.min(9, Math.round(Math.min(width, height) * 0.035)));
      const clipId = 'clip-' + kind;
      defs += '<clipPath id="' + clipId + '"><rect x="' + (x + inset) + '" y="' + (y + inset) + '" width="' + Math.max(1, width - inset * 2) + '" height="' + Math.max(1, height - inset * 2) + '" rx="4"/></clipPath>';
      drawQueue.push({ kind, x, y, width, height, inset, clipId });
    }
    if (defs) svg += '<defs>' + defs + '</defs>';
    for (const item of drawQueue) {
      svg += '<rect x="' + item.x + '" y="' + item.y + '" width="' + item.width + '" height="' + item.height + '" rx="7" class="section-box"/>';
      drawSection(
        item.kind,
        item.x + item.inset,
        item.y + item.inset,
        Math.max(20, item.width - item.inset * 2),
        Math.max(20, item.height - item.inset * 2),
        { clipId: item.clipId }
      );
    }
  } else {
    const sections = [];
    for (const kind of availableKinds) {
      if ((sectionData[kind] || []).length) sections.push(kind);
    }
    if (!sections.length) {
      svg += '<text x="' + pad + '" y="' + (top + 28) + '" font-size="18" class="muted">Nothing scheduled.</text>';
    } else if (portrait) {
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
    weather: { ...normalizeWeather(db.weather), configured: true, provider: 'Open-Meteo' },
    markets: (() => { const config = normalizeMarkets(db.markets); return { ...config, configured: marketConfigured(), provider: 'Alpha Vantage', effectiveRefreshMinutes: alphaEffectiveRefreshMinutes(config), freeDailyRequestLimit: 25 }; })(),
    options: { colors: COLORS, progressModes: PROGRESS_MODES, progressStyles: PROGRESS_STYLES, dateStyles: DATE_STYLES, timeStyles: TIME_STYLES, taskStatus: TASK_STATUS, taskPriority: TASK_PRIORITY, goalTypes: GOAL_TYPES },
    google: {
      configured: googleConfigured(),
      connected: googleAccounts().some(account => Boolean(decrypt(account.token))),
      accounts: googleAccounts().map(account => ({
        id: account.id, googleId: account.googleId, label: account.label,
        selectedCalendarIds: account.selectedCalendarIds || [],
        selectedTaskListIds: account.selectedTaskListIds || [],
        defaultTaskListId: account.defaultTaskListId || '',
        connectedAt: account.connectedAt,
        canWrite: accountCanWrite(account),
        canTasks: accountCanTasks(account)
      })),
      countdownWindowDays: db.google.countdownWindowDays || 30
    },
    display: { ...db.display, sectionLayout: normalizeSectionLayout(db.display.sectionLayout, 'dashboard'), modeLayouts: normalizeModeLayouts(db.display.modeLayouts, db.display.sectionLayout), modeSections: normalizeModeSections(db.display.modeSections, db.display), sectionOrder: normalizeSectionOrder(db.display.sectionOrder), sectionLayoutMode: 'custom', gridCols: DISPLAY_GRID_COLS, gridRows: DISPLAY_GRID_ROWS, feedPath: '/api/frameos/feed?token=' + db.display.token, svgPath: '/api/frameos/svg?token=' + db.display.token, viewPath: '/frame?token=' + db.display.token }
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
      const now = new Date().toISOString();
      let item = normalizeTask({ ...incoming, id: id(), created: now, updated: now });
      if (incoming.googleAccountId && incoming.googleTaskListId) {
        item = await createGoogleTaskLink(item, String(incoming.googleAccountId), String(incoming.googleTaskListId));
      }
      db.tasks.push(item); save(db); return json(res, 201, item);
    }
    if (p.startsWith('/api/tasks/') && req.method === 'PUT') {
      const itemId = decodeURIComponent(p.split('/').pop());
      const index = db.tasks.findIndex(x => x.id === itemId);
      if (index < 0) return json(res, 404, { error: 'Not found' });
      const incoming = await body(req);
      if (incoming.title !== undefined && !cleanText(incoming.title, 160)) return json(res, 400, { error: 'Task title is required.' });
      const existing = db.tasks[index];
      const merged = { ...existing, ...incoming, id: itemId, created: existing.created, updated: new Date().toISOString() };
      if (incoming.status && incoming.status !== 'done') merged.completedAt = null;
      if (incoming.status === 'done' && !merged.completedAt) merged.completedAt = new Date().toISOString();
      let next = normalizeTask(merged);
      if (existing.googleTaskId) {
        next.googleAccountId = existing.googleAccountId;
        next.googleTaskListId = existing.googleTaskListId;
        next.googleTaskListTitle = existing.googleTaskListTitle;
        next.googleTaskId = existing.googleTaskId;
        next.googleParentId = existing.googleParentId;
        next.googleUpdated = existing.googleUpdated;
        next.googleEtag = existing.googleEtag;
        next = await updateLinkedGoogleTask(next);
      } else if (incoming.googleAccountId && incoming.googleTaskListId) {
        next = await createGoogleTaskLink(next, String(incoming.googleAccountId), String(incoming.googleTaskListId));
      }
      db.tasks[index] = next; save(db); return json(res, 200, db.tasks[index]);
    }
    if (p.startsWith('/api/tasks/') && req.method === 'DELETE') {
      const itemId = decodeURIComponent(p.split('/').pop());
      const item = db.tasks.find(x => x.id === itemId);
      if (!item) return json(res, 404, { error: 'Not found' });
      await deleteLinkedGoogleTask(item);
      db.tasks = db.tasks.filter(x => x.id !== itemId);
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
      if (accountCanTasks(account) && !account.selectedTaskListIds.length) {
        try {
          const lists = await taskLists(account);
          if (lists.length) {
            account.selectedTaskListIds = [lists[0].id];
            account.defaultTaskListId = lists[0].id;
            save(db);
          }
        } catch (error) {
          console.warn('Google Tasks initial list setup failed:', error.message);
        }
      }
      res.writeHead(302, { Location: '/?view=settings&calendar=connected' });
      return res.end();
    }
    if (p === '/api/google/disconnect' && req.method === 'POST') {
      db.google.accounts = []; db.tasks = db.tasks.map(task => normalizeTask({ ...task, googleAccountId: '', googleTaskListId: '', googleTaskListTitle: '', googleTaskId: '', googleParentId: '', googleUpdated: null, googleEtag: '' })); save(db); return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/google/accounts/') && p.endsWith('/disconnect') && req.method === 'POST') {
      const parts = p.split('/');
      const accountId = decodeURIComponent(parts[4] || '');
      const before = db.google.accounts.length;
      db.google.accounts = db.google.accounts.filter(account => account.id !== accountId);
      if (before === db.google.accounts.length) return json(res, 404, { error: 'Google account was not found.' });
      db.tasks = db.tasks.map(task => task.googleAccountId === accountId ? normalizeTask({
        ...task,
        googleAccountId: '', googleTaskListId: '', googleTaskListTitle: '',
        googleTaskId: '', googleParentId: '', googleUpdated: null, googleEtag: ''
      }) : task);
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
    if (p === '/api/google/tasklists') {
      const accountId = url.searchParams.get('accountId');
      if (!accountId) return json(res, 400, { error: 'accountId is required.' });
      const account = googleAccount(accountId);
      if (!account) return json(res, 404, { error: 'Google account was not found.' });
      return json(res, 200, { taskLists: await taskLists(account) });
    }
    if (p.startsWith('/api/google/accounts/') && p.endsWith('/tasklists') && req.method === 'PUT') {
      const parts = p.split('/');
      const accountId = decodeURIComponent(parts[4] || '');
      const account = googleAccount(accountId);
      if (!account) return json(res, 404, { error: 'Google account was not found.' });
      const incoming = await body(req);
      if (!Array.isArray(incoming.taskListIds)) return json(res, 400, { error: 'taskListIds must be an array.' });
      const previousTaskLists = new Set(account.selectedTaskListIds || []);
      account.selectedTaskListIds = incoming.taskListIds.map(String).slice(0, 50);
      const selectedTaskLists = new Set(account.selectedTaskListIds);
      const removedTaskLists = [...previousTaskLists].filter(taskListId => !selectedTaskLists.has(taskListId));
      if (removedTaskLists.length) {
        db.tasks = db.tasks.map(task => task.googleAccountId === accountId && removedTaskLists.includes(task.googleTaskListId) ? normalizeTask({
          ...task,
          googleAccountId: '', googleTaskListId: '', googleTaskListTitle: '',
          googleTaskId: '', googleParentId: '', googleUpdated: null, googleEtag: ''
        }) : task);
      }
      const requestedDefault = incoming.defaultTaskListId ? String(incoming.defaultTaskListId) : '';
      account.defaultTaskListId = account.selectedTaskListIds.includes(requestedDefault) ? requestedDefault : (account.selectedTaskListIds[0] || '');
      save(db);
      const sync = await syncGoogleTasks();
      return json(res, 200, { ok: true, sync });
    }
    if (p === '/api/google/tasks/sync' && req.method === 'POST') {
      return json(res, 200, { ok: true, sync: await syncGoogleTasks() });
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
      if (!accountCanWrite(account)) return json(res, 403, { error: 'Reconnect this Google account in Quest Log to grant event editing access.' });
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

    if (p === '/api/weather' && req.method === 'GET') {
      if (!weatherLocationReady()) return json(res, 200, { weather: null, error: 'Choose a weather location in Displays.' });
      try { return json(res, 200, { weather: await weatherData(), error: null }); }
      catch (error) { return json(res, 200, { weather: weatherCache.data || null, error: error.message || 'Weather is unavailable.' }); }
    }

    if (p === '/api/weather/search' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      if (cleanText(q, 120).trim().length < 2) return json(res, 200, { results: [] });
      return json(res, 200, { results: await weatherLocationSearch(q) });
    }

    if (p === '/api/markets' && req.method === 'GET') {
      if (!marketConfigured()) return json(res, 200, { markets: null, error: 'Add ALPHA_VANTAGE_API_KEY in CasaOS to enable Markets.' });
      try { return json(res, 200, { markets: await marketData(), error: null }); }
      catch (error) { return json(res, 200, { markets: marketCache.data || null, error: error.message || 'Market data is unavailable.' }); }
    }
    if (p === '/api/markets/search' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      if (!marketConfigured()) return json(res, 400, { error: 'ALPHA_VANTAGE_API_KEY is not configured.' });
      if (!cleanText(q, 80).trim()) return json(res, 200, { results: [] });
      return json(res, 200, { results: await marketSearch(q) });
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
      if (incoming.mode !== undefined) db.display.mode = en(incoming.mode, DISPLAY_MODES, 'daily');
      db.display.plannerLayoutVersion = 5;
      if (incoming.sectionLayoutMode !== undefined) db.display.sectionLayoutMode = en(incoming.sectionLayoutMode, DISPLAY_SECTION_LAYOUT_MODES, 'auto');
      if (incoming.sectionLayout !== undefined) db.display.sectionLayout = normalizeSectionLayout(incoming.sectionLayout);
      if (incoming.sectionOrder !== undefined) db.display.sectionOrder = normalizeSectionOrder(incoming.sectionOrder);
      if (incoming.modeLayouts !== undefined) db.display.modeLayouts = normalizeModeLayouts(incoming.modeLayouts, db.display.sectionLayout);
      if (incoming.modeSections !== undefined) db.display.modeSections = normalizeModeSections(incoming.modeSections, db.display);
      if (incoming.refreshMinutes !== undefined) db.display.refreshMinutes = clamp(num(incoming.refreshMinutes, 15), 1, 1440);
      if (incoming.showAgenda !== undefined) db.display.showAgenda = Boolean(incoming.showAgenda);
      if (incoming.showTasks !== undefined) db.display.showTasks = Boolean(incoming.showTasks);
      if (incoming.showGoals !== undefined) db.display.showGoals = Boolean(incoming.showGoals);
      if (incoming.showCountdowns !== undefined) db.display.showCountdowns = Boolean(incoming.showCountdowns);
      if (incoming.showWeather !== undefined) db.display.showWeather = Boolean(incoming.showWeather);
      if (incoming.weatherStyle !== undefined) db.display.weatherStyle = en(incoming.weatherStyle, WEATHER_STYLES, 'forecast');
      if (incoming.marketWatchlist !== undefined || incoming.marketSymbols !== undefined || incoming.marketRefreshMinutes !== undefined) {
        db.markets = normalizeMarkets({
          ...db.markets,
          watchlist: incoming.marketWatchlist !== undefined ? incoming.marketWatchlist : (incoming.marketSymbols !== undefined ? incoming.marketSymbols : db.markets.watchlist),
          refreshMinutes: incoming.marketRefreshMinutes !== undefined ? incoming.marketRefreshMinutes : db.markets.refreshMinutes
        });
        marketCache = { key: '', expiresAt: 0, data: null };
        db.marketCache = null;
      }
      if (incoming.weatherLatitude !== undefined || incoming.weatherLongitude !== undefined || incoming.weatherLocationLabel !== undefined || incoming.weatherUnits !== undefined) {
        db.weather = normalizeWeather({
          ...db.weather,
          latitude: incoming.weatherLatitude !== undefined ? incoming.weatherLatitude : db.weather.latitude,
          longitude: incoming.weatherLongitude !== undefined ? incoming.weatherLongitude : db.weather.longitude,
          locationLabel: incoming.weatherLocationLabel !== undefined ? incoming.weatherLocationLabel : db.weather.locationLabel,
          units: incoming.weatherUnits !== undefined ? incoming.weatherUnits : db.weather.units
        });
        weatherCache = { key: '', expiresAt: 0, data: null };
      }
      save(db); return json(res, 200, { ok: true });
    }

    if (p === '/api/update/status' && req.method === 'GET') return json(res, 200, updateStatus());
    if (p === '/api/update/check' && req.method === 'POST') {
      if (req.headers['x-countdown-action'] !== 'update-check') return json(res, 403, { error: 'Invalid update check request' });
      const checked = await checkForUpdate();
      return json(res, 200, { ok: true, ...checked, configured: updaterConfigured() });
    }
    if (p === '/api/update/start' && req.method === 'POST') {
      if (req.headers['x-countdown-action'] !== 'update') return json(res, 403, { error: 'Invalid update request' });
      const status = updateStatus();
      if (['pulling','preparing','restarting','verifying'].includes(status.phase)) return json(res, 409, { error: 'An update is already running' });
      const started = await installUpdateWithCasaOS();
      return json(res, 202, started);
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

server.listen(PORT, '0.0.0.0', () => {
  console.log('Quest Log listening on :' + PORT);
  setTimeout(() => syncGoogleTasks().catch(error => console.warn('Google Tasks startup sync failed:', error.message)), 5000);
});
setInterval(() => syncGoogleTasks().catch(error => console.warn('Google Tasks background sync failed:', error.message)), 5 * 60 * 1000);
