const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || "/data";
const DB_PATH = path.join(DATA_DIR, "countdown-data.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const APP_SECRET = process.env.APP_SECRET || "";
const SCOPES = "https://www.googleapis.com/auth/calendar.readonly";

fs.mkdirSync(DATA_DIR, { recursive: true });

function defaultDb() {
  return {
    countdowns: [],
    google: {
      token: null,
      selectedCalendarIds: [],
      showCalendarCountdowns: true,
      countdownWindowDays: 30
    },
    display: {
      token: crypto.randomBytes(24).toString("hex"),
      title: "Upcoming",
      maxEvents: 6,
      maxCountdowns: 5,
      orientation: "landscape",
      colorTheme: "spectrum"
    }
  };
}

function loadDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    return {
      ...defaultDb(),
      ...parsed,
      google: { ...defaultDb().google, ...(parsed.google || {}) },
      display: { ...defaultDb().display, ...(parsed.display || {}) }
    };
  } catch {
    const db = defaultDb();
    saveDb(db);
    return db;
  }
}

function saveDb(db) {
  const temp = DB_PATH + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  fs.renameSync(temp, DB_PATH);
}

let db = loadDb();

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function safeId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
}

function encryptionKey() {
  if (!APP_SECRET) return null;
  return crypto.createHash("sha256").update(APP_SECRET).digest();
}

function encrypt(value) {
  const key = encryptionKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map(x => x.toString("base64url")).join(".");
}

function decrypt(value) {
  if (!value) return null;
  const key = encryptionKey();
  if (!key) return null;
  try {
    const [ivB64, tagB64, dataB64] = value.split(".");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const out = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final()
    ]);
    return JSON.parse(out.toString("utf8"));
  } catch {
    return null;
  }
}

function publicBase(req) {
  if (APP_BASE_URL) return APP_BASE_URL;
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function googleConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && APP_SECRET);
}

async function exchangeCode(code, req) {
  const redirectUri = publicBase(req) + "/api/google/callback";
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) throw new Error("Google token exchange failed");
  return r.json();
}

async function getAccessToken() {
  const token = decrypt(db.google.token);
  if (!token) return null;

  if (token.access_token && token.expires_at && Date.now() < token.expires_at - 60000) {
    return token.access_token;
  }

  if (!token.refresh_token) return null;

  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: token.refresh_token,
    grant_type: "refresh_token"
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) return null;
  const refreshed = await r.json();
  const merged = {
    ...token,
    ...refreshed,
    refresh_token: token.refresh_token,
    expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000
  };
  db.google.token = encrypt(merged);
  saveDb(db);
  return merged.access_token;
}

async function googleFetch(endpoint) {
  const access = await getAccessToken();
  if (!access) throw new Error("Google Calendar is not connected");
  const r = await fetch("https://www.googleapis.com/calendar/v3" + endpoint, {
    headers: { Authorization: "Bearer " + access }
  });
  if (!r.ok) {
    const details = await r.text();
    throw new Error("Google Calendar request failed: " + details.slice(0, 200));
  }
  return r.json();
}

async function calendarList() {
  const out = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ maxResults: "250" });
    if (pageToken) q.set("pageToken", pageToken);
    const data = await googleFetch("/users/me/calendarList?" + q.toString());
    out.push(...(data.items || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return out.map(c => ({
    id: c.id,
    summary: c.summary,
    primary: Boolean(c.primary),
    backgroundColor: c.backgroundColor
  }));
}

async function upcomingEvents() {
  const ids = db.google.selectedCalendarIds || [];
  if (!ids.length) return [];
  const now = new Date();
  const days = Math.max(1, Math.min(365, Number(db.google.countdownWindowDays || 30)));
  const timeMax = new Date(now.getTime() + days * 86400000);
  const merged = [];

  for (const id of ids) {
    const q = new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50"
    });
    const data = await googleFetch("/calendars/" + encodeURIComponent(id) + "/events?" + q.toString());
    for (const e of data.items || []) {
      if (e.status === "cancelled") continue;
      merged.push({
        id: e.id,
        calendarId: id,
        title: e.summary || "Busy",
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        allDay: Boolean(e.start?.date),
        location: e.location || "",
        htmlLink: e.htmlLink || ""
      });
    }
  }
  merged.sort((a, b) => new Date(a.start) - new Date(b.start));
  return merged;
}

function manualCountdowns() {
  return [...db.countdowns].sort((a, b) => new Date(a.end) - new Date(b.end));
}

function isAuthorizedDisplay(url) {
  return url.searchParams.get("token") && url.searchParams.get("token") === db.display.token;
}

async function buildFeed() {
  let events = [];
  let calendarError = null;
  if (db.google.token && (db.google.selectedCalendarIds || []).length) {
    try { events = await upcomingEvents(); }
    catch (e) { calendarError = e.message; }
  }
  const now = Date.now();
  const countdowns = manualCountdowns()
    .filter(c => new Date(c.end).getTime() > now)
    .slice(0, Number(db.display.maxCountdowns || 5))
    .map(c => ({
      id: c.id,
      title: c.name,
      end: c.end,
      secondsRemaining: Math.max(0, Math.floor((new Date(c.end).getTime() - now) / 1000)),
      daysRemaining: Math.max(0, Math.ceil((new Date(c.end).getTime() - now) / 86400000))
    }));

  return {
    generatedAt: new Date().toISOString(),
    title: db.display.title || "Upcoming",
    display: {
      orientation: db.display.orientation || "landscape",
      colorTheme: db.display.colorTheme || "spectrum",
      nativeColors: ["white", "black", "red", "blue", "green", "yellow"]
    },
    calendarError,
    nextEvent: events[0] || null,
    events: events.slice(0, Number(db.display.maxEvents || 6)),
    countdowns
  };
}

function serveStatic(req, res, pathname) {
  let file = pathname === "/" ? "/index.html" : pathname;
  file = path.normalize(file).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return text(res, 403, "Forbidden");
  fs.readFile(full, (err, data) => {
    if (err) return text(res, 404, "Not found");
    const ext = path.extname(full).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".json": "application/json; charset=utf-8"
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local");
  const p = url.pathname;

  try {
    if (p === "/healthz") return text(res, 200, "ok");

    if (p === "/api/state" && req.method === "GET") {
      const connected = Boolean(decrypt(db.google.token));
      return json(res, 200, {
        countdowns: manualCountdowns(),
        google: {
          configured: googleConfigured(),
          connected,
          selectedCalendarIds: db.google.selectedCalendarIds || [],
          showCalendarCountdowns: db.google.showCalendarCountdowns !== false,
          countdownWindowDays: db.google.countdownWindowDays || 30
        },
        display: {
          title: db.display.title,
          maxEvents: db.display.maxEvents,
          maxCountdowns: db.display.maxCountdowns,
          orientation: db.display.orientation || "landscape",
          colorTheme: db.display.colorTheme || "spectrum",
          feedPath: "/api/frameos/feed?token=" + db.display.token,
          viewPath: "/frame?token=" + db.display.token
        }
      });
    }

    if (p === "/api/countdowns" && req.method === "POST") {
      const body = await readBody(req);
      const name = String(body.name || "").trim().slice(0, 100);
      const date = new Date(body.end);
      if (!name || Number.isNaN(date.getTime())) return json(res, 400, { error: "Name and a valid end date are required." });
      const item = { id: safeId(), name, end: date.toISOString(), created: new Date().toISOString() };
      db.countdowns.push(item);
      saveDb(db);
      return json(res, 201, item);
    }

    if (p.startsWith("/api/countdowns/") && req.method === "PUT") {
      const id = decodeURIComponent(p.split("/").pop());
      const item = db.countdowns.find(x => x.id === id);
      if (!item) return json(res, 404, { error: "Not found" });
      const body = await readBody(req);
      const name = String(body.name || "").trim().slice(0, 100);
      const date = new Date(body.end);
      if (!name || Number.isNaN(date.getTime())) return json(res, 400, { error: "Name and a valid end date are required." });
      item.name = name;
      item.end = date.toISOString();
      saveDb(db);
      return json(res, 200, item);
    }

    if (p.startsWith("/api/countdowns/") && req.method === "DELETE") {
      const id = decodeURIComponent(p.split("/").pop());
      const before = db.countdowns.length;
      db.countdowns = db.countdowns.filter(x => x.id !== id);
      if (db.countdowns.length === before) return json(res, 404, { error: "Not found" });
      saveDb(db);
      return json(res, 200, { ok: true });
    }

    if (p === "/api/google/auth" && req.method === "GET") {
      if (!googleConfigured()) return json(res, 400, { error: "Google OAuth is not configured on the server." });
      const state = crypto.randomBytes(16).toString("hex");
      const redirectUri = publicBase(req) + "/api/google/callback";
      const q = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPES,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state
      });
      res.writeHead(302, {
        "Set-Cookie": `countdown_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
        Location: "https://accounts.google.com/o/oauth2/v2/auth?" + q.toString()
      });
      return res.end();
    }

    if (p === "/api/google/callback" && req.method === "GET") {
      const cookie = req.headers.cookie || "";
      const match = cookie.match(/(?:^|;\s*)countdown_oauth_state=([^;]+)/);
      if (!match || !url.searchParams.get("state") || match[1] !== url.searchParams.get("state")) {
        return text(res, 400, "Invalid OAuth state.");
      }
      if (url.searchParams.get("error")) return text(res, 400, "Google authorization was cancelled.");
      const token = await exchangeCode(url.searchParams.get("code"), req);
      token.expires_at = Date.now() + Number(token.expires_in || 3600) * 1000;
      db.google.token = encrypt(token);
      saveDb(db);
      res.writeHead(302, { Location: "/?calendar=connected", "Set-Cookie": "countdown_oauth_state=; Path=/; Max-Age=0" });
      return res.end();
    }

    if (p === "/api/google/disconnect" && req.method === "POST") {
      db.google.token = null;
      db.google.selectedCalendarIds = [];
      saveDb(db);
      return json(res, 200, { ok: true });
    }

    if (p === "/api/google/calendars" && req.method === "GET") {
      return json(res, 200, { calendars: await calendarList() });
    }

    if (p === "/api/google/events" && req.method === "GET") {
      return json(res, 200, { events: await upcomingEvents() });
    }

    if (p === "/api/settings" && req.method === "PUT") {
      const body = await readBody(req);
      if (Array.isArray(body.selectedCalendarIds)) db.google.selectedCalendarIds = body.selectedCalendarIds.slice(0, 30);
      if (body.showCalendarCountdowns !== undefined) db.google.showCalendarCountdowns = Boolean(body.showCalendarCountdowns);
      if (body.countdownWindowDays !== undefined) db.google.countdownWindowDays = Math.max(1, Math.min(365, Number(body.countdownWindowDays) || 30));
      if (body.displayTitle !== undefined) db.display.title = String(body.displayTitle || "Upcoming").slice(0, 80);
      if (body.maxEvents !== undefined) db.display.maxEvents = Math.max(1, Math.min(20, Number(body.maxEvents) || 6));
      if (body.maxCountdowns !== undefined) db.display.maxCountdowns = Math.max(1, Math.min(20, Number(body.maxCountdowns) || 5));
      if (body.orientation !== undefined && ["landscape", "portrait"].includes(body.orientation)) db.display.orientation = body.orientation;
      if (body.colorTheme !== undefined && ["mono", "red", "blue", "green", "yellow", "spectrum"].includes(body.colorTheme)) db.display.colorTheme = body.colorTheme;
      saveDb(db);
      return json(res, 200, { ok: true });
    }

    if (p === "/api/display/rotate-token" && req.method === "POST") {
      db.display.token = crypto.randomBytes(24).toString("hex");
      saveDb(db);
      return json(res, 200, {
        feedPath: "/api/frameos/feed?token=" + db.display.token,
        viewPath: "/frame?token=" + db.display.token
      });
    }

    if (p === "/api/frameos/feed" && req.method === "GET") {
      if (!isAuthorizedDisplay(url)) return json(res, 401, { error: "Invalid display token" });
      return json(res, 200, await buildFeed());
    }

    if (p === "/frame" && req.method === "GET") {
      if (!isAuthorizedDisplay(url)) return text(res, 401, "Invalid display token");
      return serveStatic(req, res, "/frame.html");
    }

    return serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e.message || "Unexpected error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`CountdownApp listening on :${PORT}`);
});
