# Quest Log

Quest Log is a personal planner that brings calendars, tasks, goals, countdowns, weather, markets, AI assistance, and configurable e-ink dashboards into one application.

It is built from **one repository and one `main` branch**, but supports two deliberately independent runtimes:

| Runtime | App server | Persistence | Authentication | Best for |
| --- | --- | --- | --- | --- |
| Self-hosted | Node.js / Docker | Local JSON at `/data/countdown-data.json` | Trusted LAN / your reverse proxy | CasaOS, home servers, local AI |
| Cloud | Cloudflare Worker | Cloudflare D1 | Cloudflare Access | Always-on hosted access without a home-server dependency |

The cloud and self-hosted editions share the same frontend and product version, but **do not connect to each other and do not synchronize Quest Log data**. Each runtime has its own tasks, goals, countdowns, settings, tokens, secrets, and display configuration.

If both runtimes are connected to the same external service, such as the same Google account, they may naturally see the same upstream Google Calendar or Google Tasks data. That is still two independent Quest Log installations talking to Google — not a Quest Log-to-Quest Log sync.

## Features

### Planning

- Responsive **Today** dashboard with calendar, tasks, goals, countdowns, weather, and Navi.
- **Day, Week, and Month** planner views with positioned time blocks, all-day rows, overlapping event columns, and Google Calendar colors.
- Prioritized tasks with due dates, projects/lists, goal links, and completion tracking.
- Number, checklist, and deadline goals with progress tracking.
- Multiple countdowns with pinning, colors, date/time formats, progress bars, and e-ink visibility controls.
- Installable PWA for desktop and mobile.

### Google Calendar and Google Tasks

- Connect multiple Google accounts.
- Read selected calendars.
- Create, edit, and delete events on calendars where Google reports writer/owner access.
- Quick-create events from empty Day/Week planner time slots.
- Two-way Google Tasks sync for selected task lists.
- Sync task title, notes, due date, completion state, edits, and deletes.
- Choose a default Google Task list for new linked tasks.

### Weather

- Location search with saved coordinates and metric/imperial units.
- Current conditions and multi-day forecasts.
- Self-hosted runtime uses **Environment and Climate Change Canada + Open-Meteo** for Canadian locations, with Open-Meteo as fallback/global forecast source.
- Cloud runtime currently uses **Open-Meteo** directly.
- No weather API key is required.

### Markets

- Alpha Vantage-backed stock/ETF watchlist.
- Today dashboard summary, dedicated Markets view, and e-ink Markets widget.
- Server-side caching and quota-aware refresh behavior.
- Provider-qualified symbols are retained so Canadian listings can be tracked correctly.

### Navi AI assistant

Navi is the built-in planning assistant. It receives a bounded planner context and can propose changes to Quest Log.

Supported actions currently include:

- create/update task;
- create/update goal;
- create/update countdown;
- create/update Google Calendar event.

Navi does **not** silently execute planner changes. Proposed actions are shown to the user for approval first, and delete actions are intentionally not exposed.

Self-hosted Navi supports:

- Hermes Agent;
- OpenClaw;
- any OpenAI-compatible HTTP API.

Cloud Navi supports:

- OpenAI using a Worker secret;
- a local/private OpenAI-compatible model exposed through a secure **HTTPS** endpoint.

The cloud local-model connector is only an AI endpoint. It does not connect the cloud Quest Log application to the self-hosted Quest Log application or its data.

### E-ink / FrameOS

- Token-protected JSON feed.
- Token-protected rendered SVG endpoint.
- Browser preview using the same display renderer.
- Dashboard, Daily, Weekly, Monthly, and Countdowns display modes.
- Agenda, Weather, Tasks, Goals, Countdowns, and Markets widgets.
- 24 × 16 drag-and-resize layout editor.
- Landscape and portrait output.
- Spectra-style six-color and monochrome palettes.
- Resolution-independent rendering for displays such as 800 × 480 panels.

## Repository layout

| Path | Purpose |
| --- | --- |
| `public/` | Shared frontend used by both runtimes |
| `server.js` | Self-hosted Node.js API/runtime |
| `Dockerfile` | Self-hosted container image |
| `docker-compose.casaos.yml` | CasaOS custom-install compose |
| `docker-compose.yml` | Docker/CasaOS compose variant |
| `cloudflare/worker.js` | Cloudflare Worker API/runtime |
| `cloudflare/state.js` | D1-backed cloud state adapter |
| `cloudflare/google.js` | Cloud Google Calendar/Tasks integration |
| `cloudflare/agent.js` | Cloud Navi integration |
| `cloudflare/markets.js` | Cloud Alpha Vantage integration |
| `cloudflare/display.js` | Cloud e-ink feed/SVG renderer |
| `cloudflare/migrations/` | D1 schema |
| `wrangler.jsonc` | Cloudflare Worker + D1 configuration |

---

# Self-hosted deployment

## Option A — CasaOS

The published image is:

`ghcr.io/srfarsquatch/countdownapp:edge`

GitHub Actions publishes both amd64 and arm64 images from `main`.

1. In CasaOS, open **App Store → Custom Install**.
2. Import `docker-compose.casaos.yml` from this repository.
3. Configure the optional integration environment variables described below.
4. Install the app.
5. Open:

~~~text
http://<casaos-server-ip>:8088
~~~

The container listens on port `8080` and the compose maps it to host port `8088`.

Persistent application data is stored on the CasaOS host at:

~~~text
/DATA/AppData/countdownapp/data
~~~

and mounted to:

~~~text
/data
~~~

Do not delete that directory unless you intentionally want to reset the self-hosted instance.

## Option B — regular Docker

Quest Log does not require CasaOS to run. A minimal Docker deployment can use a named volume:

~~~bash
docker run -d \
  --name countdownapp \
  --restart unless-stopped \
  -p 8088:8080 \
  -v questlog-data:/data \
  -e TZ=America/Vancouver \
  ghcr.io/srfarsquatch/countdownapp:edge
~~~

Open `http://<server-ip>:8088`.

Google, Markets, and stored Navi credentials require additional environment variables.

The CasaOS one-click updater also requires the Docker socket. A normal Docker deployment can omit that mount and update the image using your usual Docker workflow instead.

## Self-hosted environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | For Google | Google OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | For Google | Google OAuth client secret |
| `APP_BASE_URL` | For Google | Public HTTPS origin used to build the OAuth callback |
| `APP_SECRET` | Strongly recommended | Encrypts Google tokens and saved Navi API credentials |
| `ALPHA_VANTAGE_API_KEY` | For Markets | Alpha Vantage API key |
| `TZ` | Optional | Container timezone |
| `DOCKER_SOCKET` | Updater only | Defaults to `/var/run/docker.sock` |
| `TARGET_CONTAINER` | Updater only | Defaults to `countdownapp` |
| `TARGET_IMAGE` | Updater only | Defaults to the GHCR edge image |

Keep `APP_SECRET` stable. Changing it makes credentials encrypted with the old value unreadable and will require reconnecting those integrations.

## Self-hosted updates

The CasaOS deployment includes an in-app update workflow. Quest Log can pull the newest GHCR image and hand the existing compose definition back to CasaOS App Management so CasaOS performs the managed recreate.

The compose mounts `/var/run/docker.sock` for this feature. Docker socket access is effectively host-level Docker access, so only expose the self-hosted Quest Log instance to trusted users.

If you do not want the in-app updater, use a normal Docker deployment without the Docker socket and update the container externally.

---

# Cloudflare deployment

The cloud runtime is a native Cloudflare Worker. It does **not** proxy to CasaOS and does not need a Cloudflare Tunnel to the self-hosted Quest Log app.

Architecture:

~~~text
Browser
   |
Cloudflare Access
   |
Quest Log Worker
   |
   +-- D1
   +-- Google Calendar / Tasks
   +-- Open-Meteo
   +-- Alpha Vantage
   +-- OpenAI or secure HTTPS local-model endpoint
~~~

## 1. Install dependencies and authenticate Wrangler

~~~bash
npm install
npx wrangler login
~~~

## 2. Create the D1 database

Create a D1 database named `quest-log`:

~~~bash
npx wrangler d1 create quest-log
~~~

Copy the returned database ID into `wrangler.jsonc` under:

~~~json
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "quest-log",
    "database_id": "YOUR_D1_DATABASE_ID"
  }
]
~~~

The binding name must remain:

`DB`

Initialize the database schema:

~~~bash
npx wrangler d1 execute quest-log --remote --file=./cloudflare/migrations/0001_state_store.sql
~~~

## 3. Configure Cloudflare Access

Create a **Self-hosted** Cloudflare Access application for the hostname you will use, for example:

~~~text
questlog.example.com
~~~

Configure Google or another supported Cloudflare Access identity provider and restrict the Access policy to the users who should be allowed into Quest Log.

From the Access application, collect:

- the Access team domain, such as `your-team.cloudflareaccess.com`;
- the application AUD/tag.

Add these Worker variables:

| Variable | Example / purpose |
| --- | --- |
| `CF_ACCESS_TEAM_DOMAIN` | `your-team.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | Access application AUD/tag |
| `ALLOWED_EMAILS` | Comma-separated allowlist of user emails |
| `CLOUD_WORKSPACE_ID` | Optional; defaults to `default` |

The Worker validates the Cloudflare Access JWT itself in addition to the Access policy.

**Do not create a Bypass policy for the main Quest Log hostname or `/login*`.** Cloudflare Access is intentionally in front of the Worker for normal human access.

## 4. Configure Worker secrets

In **Workers & Pages → Quest Log Worker → Settings → Variables and Secrets**, add only the integrations you plan to use.

Core/integration secrets:

| Name | Type | Used for |
| --- | --- | --- |
| `APP_SECRET` | Secret | Google token encryption and OAuth state signing |
| `GOOGLE_CLIENT_SECRET` | Secret | Google Calendar/Tasks |
| `ALPHA_VANTAGE_API_KEY` | Secret | Markets |
| `OPENAI_API_KEY` | Secret | Cloud Navi with OpenAI |
| `LOCAL_AGENT_API_KEY` | Secret | Optional bearer token for a private local-model endpoint |
| `LOCAL_AGENT_ACCESS_CLIENT_ID` | Secret | Optional Cloudflare Access service-token client ID |
| `LOCAL_AGENT_ACCESS_CLIENT_SECRET` | Secret | Optional Cloudflare Access service-token client secret |

Useful non-secret variables:

| Name | Used for |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `OPENAI_MODEL` | Optional OpenAI model override |
| `LOCAL_AGENT_BASE_URL` | Optional default HTTPS local-model base URL |
| `LOCAL_AGENT_MODEL` | Optional local-model override |
| `CF_ACCESS_TEAM_DOMAIN` | Access validation |
| `CF_ACCESS_AUD` | Access validation |
| `ALLOWED_EMAILS` | Worker-side email allowlist |
| `CLOUD_WORKSPACE_ID` | D1 workspace key |

`AUTH_BYPASS=true` exists only for local Worker development. Never enable it in production.

Keep `APP_SECRET` stable. Rotating it will make existing encrypted cloud Google tokens unreadable.

## 5. Deploy the Worker

Deploy from the repository:

~~~bash
npm run deploy:cloudflare
~~~

Then add your production custom domain to the Worker in Cloudflare and make sure the same hostname is covered by the Access application.

For continuous deployment, connect the GitHub repository to Cloudflare Workers Builds, use `main` as the production branch, and deploy using the repository's `npm run deploy:cloudflare` script. Keep the D1 binding declared in `wrangler.jsonc` so deployments do not lose it.

The cloud edition and the GHCR self-hosted image should both be shipped from the same `main` commit.

---

# Connector setup

## Google Calendar + Google Tasks

Quest Log requests these Google scopes:

~~~text
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/tasks
~~~

These provide event read/write, calendar-list read access, and Google Tasks read/write.

### Google Cloud configuration

1. Create or select a Google Cloud project.
2. Enable:
   - **Google Calendar API**
   - **Google Tasks API**
3. Configure **Google Auth Platform / OAuth consent**.
4. If the app is in testing, add the Google accounts that will use Quest Log as test users.
5. Create an OAuth 2.0 **Web application** client.

For self-hosted Quest Log, add:

~~~text
<APP_BASE_URL>/api/google/callback
~~~

Example:

~~~text
https://planner.example.com/api/google/callback
~~~

For cloud Quest Log, add:

~~~text
https://questlog.example.com/api/google/callback
~~~

Use the matching client ID/secret in that runtime.

It is recommended to use a separate Google OAuth client for Quest Log's Calendar/Tasks authorization rather than reusing the OAuth client used by Cloudflare Access for sign-in.

### Connect inside Quest Log

After deployment:

1. Open **Settings → Google Calendar**.
2. Choose **Connect Google Calendar**.
3. Approve the requested scopes.
4. Select the calendars to display.
5. Select the Google Task lists to synchronize.
6. Choose a default Task list for newly linked Quest Log tasks.

Event edits are only enabled for calendars where Google's API reports `writer` or `owner` access.

Google Tasks exposes a due **date**, not a due time. Quest Log retains its local task time while synchronizing the date to Google.

## Alpha Vantage Markets

1. Create an Alpha Vantage API key.
2. Self-hosted: set `ALPHA_VANTAGE_API_KEY` in the container environment and restart/recreate the container.
3. Cloud: store `ALPHA_VANTAGE_API_KEY` as a Worker secret and redeploy if required.
4. Open **Markets** and use the in-app symbol search to add securities.

Using the in-app search is recommended for Canadian listings so Quest Log stores the provider-qualified symbol returned by Alpha Vantage.

Market data is cached server-side and refresh intervals are constrained to reduce free-tier API usage.

## Weather

No API key is required.

In Quest Log, choose a weather location in Settings/Displays. Quest Log stores the selected coordinates.

Self-hosted behavior:

~~~text
Canadian location
   +-- Environment and Climate Change Canada current/official data
   +-- Open-Meteo forecast/fallback
~~~

Other self-hosted locations use Open-Meteo.

Cloud behavior:

~~~text
Open-Meteo
~~~

The cloud weather implementation currently does not query Environment Canada.

## Navi — self-hosted AI

Open **Settings → AI connection**.

### Hermes Agent

Example:

~~~text
Provider: Hermes Agent
Base URL: http://192.168.1.50:8642/v1
Model: hermes-agent
API key: optional, if the Hermes server requires one
~~~

### OpenClaw

Enable OpenClaw's OpenAI-compatible Chat Completions API and use values such as:

~~~text
Provider: OpenClaw
Base URL: http://192.168.1.50:18789/v1
Model: openclaw/default
API key: your Gateway token
~~~

### Other OpenAI-compatible servers

Choose **OpenAI-compatible** and enter:

- the server's `/v1` base URL;
- model ID;
- optional bearer token.

The endpoint must be reachable **from the Quest Log container**, not just from your browser. If the model runs on another computer, do not use `localhost` or `127.0.0.1`; use that computer's LAN-reachable address/hostname.

Quest Log stores a saved self-hosted agent credential encrypted with `APP_SECRET`.

The **Test connection** action checks the provider's `/v1/models` endpoint.

## Navi — cloud OpenAI

Store:

- `OPENAI_API_KEY` as a Worker secret;
- optional `OPENAI_MODEL` as a variable.

Then choose **OpenAI** in Quest Log's cloud AI settings.

## Navi — cloud to a local/private model

A Cloudflare Worker cannot directly call a private `192.168.x.x` LAN address. The model must be exposed through a secure public **HTTPS** URL.

Typical architecture:

~~~text
Quest Log Worker
      |
      | HTTPS
      v
Cloudflare Tunnel / reverse proxy
      |
      v
Hermes / OpenClaw / OpenAI-compatible model server
~~~

In Quest Log choose **Local model (HTTPS)** and configure the HTTPS `/v1` endpoint.

Optional Worker configuration:

- `LOCAL_AGENT_BASE_URL`
- `LOCAL_AGENT_MODEL`
- `LOCAL_AGENT_API_KEY`

If the model endpoint is protected by Cloudflare Access, create a Cloudflare Access **service token** for the model endpoint and store:

- `LOCAL_AGENT_ACCESS_CLIENT_ID`
- `LOCAL_AGENT_ACCESS_CLIENT_SECRET`

The Worker sends those as `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers.

This connection exposes only the model API to cloud Navi. It is not a tunnel into the self-hosted Quest Log application.

## FrameOS / e-ink

Open **Displays** in Quest Log. The app generates a private display token and exposes:

~~~text
/api/frameos/svg?token=...&w=800&h=480
/api/frameos/feed?token=...
/frame?token=...&w=800&h=480
~~~

Use:

- **SVG** for the exact Quest Log-rendered display;
- **JSON feed** for a custom FrameOS scene/client;
- **/frame** for browser preview/testing.

Treat the display token like a password. Rotate it in Quest Log if a display URL is exposed.

### FrameOS with self-hosted Quest Log

FrameOS must be able to reach the self-hosted Quest Log server over your LAN, VPN, or reverse proxy.

Example:

~~~text
http://192.168.1.20:8088/api/frameos/svg?token=...&w=800&h=480
~~~

### FrameOS with cloud Quest Log

Cloudflare Access normally requires an interactive human login, which an unattended e-ink device cannot perform.

Keep the main application protected, but if you need direct FrameOS access create narrowly scoped Access applications for only:

~~~text
questlog.example.com/frame
questlog.example.com/api/frameos/*
~~~

Use a **Bypass / Everyone** policy only on those machine-display paths.

The Worker still validates the private display token before returning feed/SVG data.

Do **not** bypass Access for the rest of `questlog.example.com`.

---

# Cloudflare Access sign-in

Cloud Quest Log uses Cloudflare Access for human authentication.

Unauthenticated users are stopped by Access before the Worker loads. Once authenticated, the Worker validates the Access JWT and surfaces the authenticated email through `/api/runtime`.

The in-app cloud logout action uses:

~~~text
/cdn-cgi/access/logout
~~~

Self-hosted Quest Log does not use Cloudflare Access unless you independently place it behind Access/reverse-proxy authentication.

---

# Persistence and backups

## Self-hosted

Main state:

~~~text
/data/countdown-data.json
~~~

CasaOS host location:

~~~text
/DATA/AppData/countdownapp/data
~~~

Back up that directory to preserve self-hosted Quest Log data.

## Cloud

Cloud state is stored in the D1 database bound as `DB`, currently in the `questlog_state` table.

Back up/export D1 separately if you need an external cloud backup.

The cloud and self-hosted persistence stores are intentionally independent.

---

# Security notes

- Never commit `.dev.vars`, Google client secrets, Alpha Vantage keys, OpenAI keys, or agent bearer tokens.
- Use Cloudflare **Secrets** for cloud credentials.
- Keep `APP_SECRET` long, random, private, and stable.
- Treat FrameOS display tokens as credentials.
- Cloudflare Access protects the human cloud UI; the Worker's JWT validation is an additional check.
- Do not add an Access Bypass policy to the main Quest Log hostname.
- Docker socket access is powerful; only mount it when you want the CasaOS-managed in-app updater.
- For cloud local AI, expose only the model endpoint through HTTPS — never the self-hosted Quest Log data/runtime.

---

# Local development

Install dependencies:

~~~bash
npm install
~~~

Run the self-hosted Node runtime:

~~~bash
npm run dev:selfhosted
~~~

Run the Cloudflare Worker locally:

~~~bash
cp .dev.vars.example .dev.vars
npm run dev:cloudflare
~~~

`.dev.vars.example` includes `AUTH_BYPASS=true` for local Worker development. Do not copy that setting into production.

---

# Release model

`main` is the source of truth.

A push/merge to `main` can update both deployment targets:

~~~text
main
  |
  +-- GitHub Actions -> GHCR edge image -> CasaOS / Docker
  |
  +-- Cloudflare Workers Builds or Wrangler -> Worker + D1
~~~

Shared frontend changes should be implemented once in `public/`. Runtime-specific backend behavior belongs in `server.js` or the `cloudflare/` modules while keeping the API contract aligned wherever practical.

For deeper cloud implementation notes, see `cloudflare/README.md`.
