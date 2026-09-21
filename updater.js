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
let state = (() => {
  const fallback = {
    phase: "idle", step: "idle", progress: 0, message: "Ready",
    startedAt: null, finishedAt: null, error: null,
    checking: false, available: null, lastCheckedAt: null, checkError: null,
    currentImageId: "", latestImageId: "", currentRevision: "", latestRevision: "",
    currentVersion: "", latestVersion: "", latestCreatedAt: ""
  };
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(STATUS_PATH, "utf8")) }; }
  catch { return fallback; }
})();

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

function dockerStream(method, endpoint, onEvent) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, path: endpoint, method }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => reject(new Error("Docker API " + method + " " + endpoint + " failed (" + res.statusCode + "): " + Buffer.concat(chunks).toString("utf8").slice(0, 500))));
        return;
      }
      let buffer = "";
      const consume = line => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.errorDetail?.message) throw new Error(event.errorDetail.message);
          if (event.error) throw new Error(event.error);
          onEvent?.(event);
        } catch (error) {
          if (error instanceof SyntaxError) return;
          reject(error);
        }
      };
      res.on("data", chunk => {
        buffer += chunk.toString("utf8");
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          consume(line);
        }
      });
      res.on("end", () => {
        if (buffer.trim()) consume(buffer);
        resolve();
      });
    });
    req.on("error", reject);
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

async function pullImage(onProgress) {
  if (!apiVersion) await negotiateApiVersion();
  const slash = TARGET_IMAGE.lastIndexOf("/");
  const colon = TARGET_IMAGE.lastIndexOf(":");
  const image = colon > slash ? TARGET_IMAGE.slice(0, colon) : TARGET_IMAGE;
  const tag = colon > slash ? TARGET_IMAGE.slice(colon + 1) : "latest";
  const layers = new Map();
  const done = new Set();
  let maxPercent = 0;
  await dockerStream("POST", apiVersion + "/images/create?fromImage=" + encodeURIComponent(image) + "&tag=" + encodeURIComponent(tag), event => {
    if (event.id && event.progressDetail && Number(event.progressDetail.total) > 0) {
      layers.set(event.id, {
        current: Math.max(0, Number(event.progressDetail.current) || 0),
        total: Math.max(1, Number(event.progressDetail.total) || 1)
      });
    }
    if (event.id && /pull complete|already exists|download complete/i.test(String(event.status || ""))) done.add(event.id);
    let current = 0, total = 0;
    for (const layer of layers.values()) { current += Math.min(layer.current, layer.total); total += layer.total; }
    let percent = total > 0 ? Math.round(current / total * 100) : maxPercent;
    if (/pull complete|already exists/i.test(String(event.status || "")) && layers.size && done.size >= layers.size) percent = 100;
    maxPercent = Math.max(maxPercent, Math.min(100, percent));
    onProgress?.(maxPercent, event.status || "Pulling image");
  });
  onProgress?.(100, "Image ready");
}

function imageMetadata(info) {
  const labels = info?.Config?.Labels || {};
  const revision = String(labels["org.opencontainers.image.revision"] || "");
  const version = String(labels["org.opencontainers.image.version"] || "");
  return {
    imageId: info?.Id || "",
    revision,
    version,
    createdAt: info?.Created || ""
  };
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

async function waitForHealthy(name, timeoutMs = 75000, onProgress) {
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
    const elapsed = Math.max(0, timeoutMs - (deadline - Date.now()));
    onProgress?.(Math.min(99, 90 + Math.round(elapsed / timeoutMs * 9)), health || info.State?.Status || "starting");
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
    phase: "pulling", step: "download", progress: 6,
    message: "Downloading update",
    startedAt: state.startedAt || new Date().toISOString(),
    finishedAt: null,
    error: null,
    checking: false
  });

  let backupName = null;
  let replacementName = null;
  let lastPullPersist = 0;
  let lastPullPercent = -1;

  try {
    const current = await inspectContainer(TARGET_CONTAINER);
    const currentImage = await inspectImage(current.Image);
    const currentMeta = imageMetadata(currentImage);

    await pullImage((percent, status) => {
      const mapped = Math.max(7, Math.min(55, 7 + Math.round(percent * 0.48)));
      const now = Date.now();
      if (percent === 100 || percent >= lastPullPercent + 3 || now - lastPullPersist > 700) {
        lastPullPercent = percent;
        lastPullPersist = now;
        persistState({
          phase: "pulling", step: "download", progress: mapped,
          message: percent >= 100 ? "Download complete" : "Downloading update · " + percent + "%",
          pullStatus: status
        });
      }
    });

    const latestImage = await inspectImage(TARGET_IMAGE);
    const latestMeta = imageMetadata(latestImage);

    if (current.Image === latestImage.Id) {
      persistState({
        phase: "complete", step: "complete", progress: 100,
        message: "Quest Log is already up to date",
        available: false,
        currentImageId: latestMeta.imageId, latestImageId: latestMeta.imageId,
        currentRevision: latestMeta.revision, latestRevision: latestMeta.revision,
        currentVersion: latestMeta.version, latestVersion: latestMeta.version,
        latestCreatedAt: latestMeta.createdAt,
        lastCheckedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString()
      });
      return true;
    }

    persistState({
      phase: "preparing", step: "prepare", progress: 62,
      message: "Preparing the new version",
      currentImageId: currentMeta.imageId, latestImageId: latestMeta.imageId,
      currentRevision: currentMeta.revision, latestRevision: latestMeta.revision,
      currentVersion: currentMeta.version, latestVersion: latestMeta.version,
      latestCreatedAt: latestMeta.createdAt
    });

    const stamp = Date.now().toString(36);
    replacementName = TARGET_CONTAINER + "-next-" + stamp;
    backupName = TARGET_CONTAINER + "-backup-" + stamp;

    await dockerJson(
      "POST",
      "/containers/create?name=" + encodeURIComponent(replacementName),
      createConfig(current)
    );

    persistState({ phase: "restarting", step: "restart", progress: 74, message: "Restarting Quest Log" });

    try { await docker("POST", "/containers/" + encodeURIComponent(TARGET_CONTAINER) + "/stop?t=10"); } catch {}
    persistState({ phase: "restarting", step: "restart", progress: 79, message: "Switching to the new version" });

    await docker("POST", "/containers/" + encodeURIComponent(TARGET_CONTAINER) + "/rename?name=" + encodeURIComponent(backupName));
    await docker("POST", "/containers/" + encodeURIComponent(replacementName) + "/rename?name=" + encodeURIComponent(TARGET_CONTAINER));
    await docker("POST", "/containers/" + encodeURIComponent(TARGET_CONTAINER) + "/start");

    persistState({ phase: "verifying", step: "verify", progress: 90, message: "Checking that Quest Log started correctly" });
    const healthy = await waitForHealthy(TARGET_CONTAINER, 75000, (progress, health) => {
      persistState({
        phase: "verifying", step: "verify", progress,
        message: health === "healthy" ? "Quest Log is healthy" : "Waiting for Quest Log to become healthy"
      });
    });
    if (!healthy) {
      await rollback(backupName, TARGET_CONTAINER);
      throw new Error("The new container did not become healthy. The previous version was restored.");
    }

    persistState({ phase: "verifying", step: "cleanup", progress: 98, message: "Finishing update" });
    try { await docker("DELETE", "/containers/" + encodeURIComponent(backupName) + "?force=true"); } catch {}

    persistState({
      phase: "complete", step: "complete", progress: 100,
      message: "Update installed successfully",
      available: false,
      currentImageId: latestMeta.imageId, latestImageId: latestMeta.imageId,
      currentRevision: latestMeta.revision, latestRevision: latestMeta.revision,
      currentVersion: latestMeta.version, latestVersion: latestMeta.version,
      latestCreatedAt: latestMeta.createdAt,
      lastCheckedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: null
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
      phase: "error", step: "error",
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
    console.log(`Quest Log updater listening on :${PORT}`);
  });
}
