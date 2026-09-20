const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8090);
const SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const TARGET_CONTAINER = process.env.TARGET_CONTAINER || "countdownapp";
const TARGET_IMAGE = process.env.TARGET_IMAGE || "ghcr.io/srfarsquatch/countdownapp:edge";
const UPDATE_TOKEN = process.env.UPDATE_TOKEN || "countdown-internal-updater";
const DATA_DIR = process.env.DATA_DIR || "/data";
const STATUS_PATH = path.join(DATA_DIR, "update-status.json");

let apiVersion = "";
let state = {
  phase: "idle",
  message: "Ready",
  startedAt: null,
  finishedAt: null,
  error: null
};

function persistState(next) {
  state = { ...state, ...next };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temp = STATUS_PATH + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, STATUS_PATH);
  } catch (error) {
    console.error("Could not persist update status:", error.message);
  }
}

function respond(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  return req.headers["x-update-token"] === UPDATE_TOKEN;
}

function dockerRaw(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      socketPath: SOCKET,
      path: endpoint,
      method,
      headers: payload ? {
        "Content-Type": "application/json",
        "Content-Length": payload.length
      } : {}
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode >= 200 && res.statusCode < 300) || res.statusCode === 304) {
          return resolve({ status: res.statusCode, raw });
        }
        reject(new Error(`Docker API ${method} ${endpoint} failed (${res.statusCode}): ${raw.slice(0, 500)}`));
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function negotiateApiVersion() {
  const result = await dockerRaw("GET", "/version");
  const info = JSON.parse(result.raw);
  apiVersion = info.ApiVersion ? `/v${info.ApiVersion}` : "";
}

async function docker(method, endpoint, body) {
  if (!apiVersion) await negotiateApiVersion();
  return dockerRaw(method, apiVersion + endpoint, body);
}

async function dockerJson(method, endpoint, body) {
  const result = await docker(method, endpoint, body);
  return result.raw ? JSON.parse(result.raw) : {};
}

async function inspectContainer(name) {
  return dockerJson("GET", "/containers/" + encodeURIComponent(name) + "/json");
}

async function inspectImage(name) {
  return dockerJson("GET", "/images/" + encodeURIComponent(name) + "/json");
}

async function pullImage() {
  const image = TARGET_IMAGE.includes(":") ? TARGET_IMAGE.slice(0, TARGET_IMAGE.lastIndexOf(":")) : TARGET_IMAGE;
  const tag = TARGET_IMAGE.includes(":") ? TARGET_IMAGE.slice(TARGET_IMAGE.lastIndexOf(":") + 1) : "latest";
  const result = await docker("POST", "/images/create?fromImage=" + encodeURIComponent(image) + "&tag=" + encodeURIComponent(tag));
  for (const line of result.raw.split("\n")) {
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

function runtimeEnvironment(env) {
  const keep = new Set([
    "TZ",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "APP_BASE_URL",
    "APP_SECRET",
    "DOCKER_SOCKET"
  ]);
  return (env || []).filter(entry => keep.has(String(entry).split("=")[0]));
}

function networkingConfig(inspect) {
  const endpoints = {};
  for (const [name, value] of Object.entries(inspect.NetworkSettings?.Networks || {})) {
    endpoints[name] = {
      Aliases: value.Aliases || undefined,
      Links: value.Links || undefined,
      IPAMConfig: value.IPAMConfig || undefined,
      MacAddress: value.MacAddress || undefined,
      DriverOpts: value.DriverOpts || undefined,
      GwPriority: value.GwPriority || undefined
    };
    Object.keys(endpoints[name]).forEach(key => endpoints[name][key] === undefined && delete endpoints[name][key]);
  }
  return Object.keys(endpoints).length ? { EndpointsConfig: endpoints } : undefined;
}

function createConfig(inspect) {
  const config = {
    Image: TARGET_IMAGE,
    Env: runtimeEnvironment(inspect.Config?.Env),
    Labels: inspect.Config?.Labels || {},
    Healthcheck: inspect.Config?.Healthcheck,
    ExposedPorts: inspect.Config?.ExposedPorts || undefined,
    HostConfig: inspect.HostConfig || {}
  };
  const network = networkingConfig(inspect);
  if (network) config.NetworkingConfig = network;
  if (!config.Healthcheck) delete config.Healthcheck;
  if (!config.ExposedPorts) delete config.ExposedPorts;
  return config;
}

async function waitForHealthy(name, timeoutMs = 75000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let info;
    try {
      info = await inspectContainer(name);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1500));
      continue;
    }
    const running = info.State?.Running === true;
    const health = info.State?.Health?.Status;
    if (running && (!health || health === "healthy")) return true;
    if (info.State?.Status === "exited" || health === "unhealthy") return false;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return false;
}

async function rollback(backupName, replacementName) {
  try { await docker("POST", "/containers/" + encodeURIComponent(replacementName) + "/stop?t=5"); } catch {}
  try { await docker("DELETE", "/containers/" + encodeURIComponent(replacementName) + "?force=true"); } catch {}
  try { await docker("POST", "/containers/" + encodeURIComponent(backupName) + "/rename?name=" + encodeURIComponent(TARGET_CONTAINER)); } catch {}
  try { await docker("POST", "/containers/" + encodeURIComponent(TARGET_CONTAINER) + "/start"); } catch {}
}

async function runUpdate() {
  persistState({
    phase: "pulling",
    message: "Pulling latest image",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null
  });

  let backupName = null;
  let replacementName = null;

  try {
    const current = await inspectContainer(TARGET_CONTAINER);
    await pullImage();
    const latestImage = await inspectImage(TARGET_IMAGE);

    if (current.Image === latestImage.Id) {
      persistState({
        phase: "complete",
        message: "Already running the latest container image",
        finishedAt: new Date().toISOString()
      });
      return true;
    }

    persistState({ phase: "preparing", message: "Preparing replacement container" });

    const stamp = Date.now().toString(36);
    replacementName = TARGET_CONTAINER + "-next-" + stamp;
    backupName = TARGET_CONTAINER + "-backup-" + stamp;

    await dockerJson(
      "POST",
      "/containers/create?name=" + encodeURIComponent(replacementName),
      createConfig(current)
    );

    persistState({ phase: "restarting", message: "Restarting CountdownApp" });

    try { await docker("POST", "/containers/" + encodeURIComponent(TARGET_CONTAINER) + "/stop?t=10"); } catch {}
    await docker("POST", "/containers/" + encodeURIComponent(TARGET_CONTAINER) + "/rename?name=" + encodeURIComponent(backupName));
    await docker("POST", "/containers/" + encodeURIComponent(replacementName) + "/rename?name=" + encodeURIComponent(TARGET_CONTAINER));
    await docker("POST", "/containers/" + encodeURIComponent(TARGET_CONTAINER) + "/start");

    const healthy = await waitForHealthy(TARGET_CONTAINER);
    if (!healthy) {
      await rollback(backupName, TARGET_CONTAINER);
      throw new Error("The new container did not become healthy. The previous version was restored.");
    }

    try { await docker("DELETE", "/containers/" + encodeURIComponent(backupName) + "?force=true"); } catch {}

    persistState({
      phase: "complete",
      message: "Update installed successfully",
      finishedAt: new Date().toISOString()
    });
    return true;
  } catch (error) {
    if (backupName) {
      try {
        const active = await inspectContainer(TARGET_CONTAINER);
        if (!active.State?.Running) await rollback(backupName, TARGET_CONTAINER);
      } catch {
        try { await rollback(backupName, TARGET_CONTAINER); } catch {}
      }
    }
    persistState({
      phase: "error",
      message: "Update failed",
      error: error.message,
      finishedAt: new Date().toISOString()
    });
    console.error(error);
    return false;
  }
}

if (process.argv.includes("--once") || process.env.RUN_ONCE === "1") {
  runUpdate().then(ok => process.exit(ok ? 0 : 1));
} else {
  const server = http.createServer((req, res) => {
    if (!authorized(req)) return respond(res, 401, { error: "Unauthorized" });

    if (req.method === "GET" && req.url === "/status") {
      return respond(res, 200, state);
    }

    if (req.method === "POST" && req.url === "/update") {
      if (["pulling", "preparing", "restarting"].includes(state.phase)) {
        return respond(res, 409, { error: "An update is already running", state });
      }
      setTimeout(() => runUpdate(), 250);
      return respond(res, 202, { ok: true, message: "Update started" });
    }

    return respond(res, 404, { error: "Not found" });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`CountdownApp updater listening on :${PORT}`);
  });
}
