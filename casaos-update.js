const http = require('http');
const fs = require('fs');
const path = require('path');

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const DATA_DIR = process.env.DATA_DIR || '/data';
const STATUS_PATH = path.join(DATA_DIR, 'update-status.json');
const CASAOS_RUNTIME_DIR = process.env.CASAOS_RUNTIME_DIR || '/var/run/casaos';
const CASAOS_URL_PATH = path.join(CASAOS_RUNTIME_DIR, 'app-management.url');
const APP_ID = process.env.CASAOS_APP_ID || 'countdownapp';
const TARGET_CONTAINER = process.env.TARGET_CONTAINER || 'countdownapp';
const OLD_IMAGE_ID = process.env.OLD_IMAGE_ID || '';
const TARGET_IMAGE = process.env.TARGET_IMAGE || 'ghcr.io/srfarsquatch/countdownapp:edge';

function readState() {
  try { return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')); }
  catch { return {}; }
}

function persistState(patch) {
  const next = { ...readState(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = STATUS_PATH + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(next, null, 2));
  fs.renameSync(temp, STATUS_PATH);
  return next;
}

function dockerRaw(method, endpoint) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: DOCKER_SOCKET, path: endpoint, method }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 200 && response.statusCode < 300) {
          return resolve({ status: response.statusCode, raw });
        }
        const error = new Error('Docker API ' + method + ' ' + endpoint + ' failed (' + response.statusCode + '): ' + raw.slice(0, 300));
        error.status = response.statusCode;
        reject(error);
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function dockerVersion() {
  const result = await dockerRaw('GET', '/version');
  const info = JSON.parse(result.raw);
  return info.ApiVersion ? '/v' + info.ApiVersion : '';
}

async function inspectContainer(version, ref) {
  try {
    const result = await dockerRaw('GET', version + '/containers/' + encodeURIComponent(ref) + '/json');
    return JSON.parse(result.raw);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function resolveManagedContainer(version) {
  const direct = await inspectContainer(version, TARGET_CONTAINER);
  if (direct) return direct;

  const result = await dockerRaw('GET', version + '/containers/json?all=1');
  const containers = JSON.parse(result.raw || '[]');
  const match = containers.find(item =>
    item?.Labels?.['com.docker.compose.project'] === APP_ID &&
    item?.Labels?.['com.docker.compose.service']
  );
  if (!match?.Id) return null;
  return inspectContainer(version, match.Id);
}

function casaOSBaseURL() {
  const value = fs.readFileSync(CASAOS_URL_PATH, 'utf8').trim();
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(value) && !/^http:\/\/\[::1\]:\d+$/.test(value)) {
    throw new Error('CasaOS App Management local URL was not found in the expected format.');
  }
  return value;
}

async function casaOSRequest(method, pathname, options = {}) {
  const response = await fetch(casaOSBaseURL() + pathname, {
    method,
    headers: options.headers || {},
    body: options.body
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error('CasaOS App Management ' + method + ' failed (' + response.status + '): ' + body.slice(0, 400));
  }
  return body;
}

async function applyThroughCasaOS() {
  const appPath = '/v2/app_management/compose/' + encodeURIComponent(APP_ID);
  persistState({
    phase: 'preparing',
    step: 'casaos',
    progress: 55,
    message: 'Handing update to CasaOS…',
    pullStatus: 'CasaOS is applying the managed app update',
    error: null,
    checkError: null
  });

  const composeYAML = await casaOSRequest('GET', appPath, {
    headers: { Accept: 'application/yaml' }
  });

  if (!composeYAML.trim()) throw new Error('CasaOS returned an empty compose configuration.');

  await casaOSRequest(
    'PUT',
    appPath + '?dry_run=false&check_port_conflict=false',
    {
      headers: { 'Content-Type': 'application/yaml' },
      body: composeYAML
    }
  );

  persistState({
    phase: 'restarting',
    step: 'restart',
    progress: 78,
    message: 'CasaOS is restarting Planner…',
    pullStatus: 'Waiting for the updated CasaOS-managed container'
  });
}

async function waitForReplacement() {
  const version = await dockerVersion();
  const deadline = Date.now() + 180000;
  let sawTransition = false;

  while (Date.now() < deadline) {
    const container = await resolveManagedContainer(version);

    if (!container) {
      sawTransition = true;
      await new Promise(resolve => setTimeout(resolve, 1500));
      continue;
    }

    const changedImage = Boolean(OLD_IMAGE_ID) && container.Image && container.Image !== OLD_IMAGE_ID;
    if (changedImage) sawTransition = true;

    const running = container.State?.Running === true;
    const health = container.State?.Health?.Status;
    const healthy = running && (!health || health === 'healthy');

    if (sawTransition && changedImage && healthy) {
      persistState({
        phase: 'complete',
        step: 'complete',
        progress: 100,
        available: false,
        message: 'Update installed successfully',
        pullStatus: 'CasaOS applied the new Planner image',
        currentImageId: container.Image || '',
        latestImageId: container.Image || '',
        finishedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        error: null,
        checkError: null,
        installMode: 'casaos-managed'
      });
      return true;
    }

    persistState({
      phase: 'verifying',
      step: 'verify',
      progress: sawTransition ? 94 : 86,
      message: sawTransition ? 'Checking the updated Planner…' : 'Waiting for CasaOS to recreate Planner…'
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error('CasaOS accepted the update, but Planner did not come back on the new image within 3 minutes.');
}

async function run() {
  try {
    persistState({
      phase: 'preparing',
      step: 'casaos',
      progress: 45,
      message: 'Starting CasaOS-managed update…',
      startedAt: readState().startedAt || new Date().toISOString(),
      finishedAt: null,
      error: null,
      checking: false,
      installMode: 'casaos-managed'
    });

    await applyThroughCasaOS();
    await waitForReplacement();
    process.exit(0);
  } catch (error) {
    persistState({
      phase: 'error',
      step: 'error',
      progress: 0,
      message: 'Update failed',
      error: error.message || String(error),
      finishedAt: new Date().toISOString(),
      installMode: 'casaos-managed'
    });
    console.error(error);
    process.exit(1);
  }
}

run();
