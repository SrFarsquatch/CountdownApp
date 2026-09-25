# Quest Log

Quest Log is a personal planner that brings calendars, tasks, goals, countdowns, weather, markets, AI assistance, and configurable e-ink dashboards into one application.

It is built from **one repository and one `main` branch**, but supports two deliberately independent runtimes:

| Runtime | App server | Persistence | Authentication | Best for |
| --- | --- | --- | --- | --- |
| Self-hosted | Node.js / Docker | Local JSON at `/data/countdown-data.json` | Trusted LAN / your reverse proxy | CasaOS, home servers, local AI |
| Cloud | Cloudflare Worker | Cloudflare D1 | Native Quest Log accounts | Always-on hosted access and multi-user accounts |

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

### Finance and bank connections

- The former Markets page is evolving into a lightweight **Finance** workspace.
- Quest Log supports **Plaid, Envestnet | Yodlee, and Flinks** behind one Finance API. Users can choose any provider that is configured for the deployment.
- **Yodlee FastLink 4** is available for direct/tokenized Canadian connections and can reopen an existing provider account in refresh mode when MFA is required.
- **Flinks Connect** is available as a Canadian-focused fallback. Flinks connections retain their `loginId` so Quest Log can reopen Connect for interactive MFA/reconnect; Flinks refresh is user-triggered rather than silently run whenever Finance opens.
- Connected accounts, balances, and recent transactions from all configured providers are normalized into the same Finance dashboard alongside the Yahoo Finance watchlist.
- Plaid access tokens remain encrypted with `APP_SECRET`; Yodlee client credentials and Flinks API/auth keys stay server-side and are never persisted in browser storage.
- Cloud deployments use native **Quest Log user IDs**. Planner state, connected services, Plaid Items, accounts, and transactions are isolated per user, and one user can connect multiple institutions without exposing data to other users.
- Self-hosted deployments keep Plaid data in a separate `/data/finance-data.json` store; the current self-hosted runtime remains a trusted single-user installation until Quest Log's native multi-user login is added. Only the Plaid access token is encrypted, so treat the persistent data directory as private.
- This first finance slice syncs when Finance is opened (with a short cache) and when the user presses **Sync**. Budget rules, spending categories, cash-flow planning, goals, and webhook-driven background refresh are intended follow-on layers.

### Markets

- Yahoo Finance-backed market watchlist covering U.S., Canadian, and other Yahoo-supported instruments.
- Today dashboard summary, dedicated Markets view, and e-ink Markets widget.
- Server-side shared caching so Today, Markets, Navi, and e-ink views reuse the same provider snapshot.
- Canadian symbols use Yahoo Finance suffixes such as `.TO` for TSX and `.V` for TSX Venture; legacy `.TRT`/`.TRV` symbols are migrated automatically.

### Navi AI assistant

Navi is the built-in planning assistant. It receives a bounded planner context and can propose changes to Quest Log.

Supported actions currently include:

- create/update task;
- create/update goal;
- create/update countdown;
- create/update Google Calendar event.

Navi does **not** silently execute planner changes. Proposed actions are shown to the user for approval first, and delete actions are intentionally not exposed.

Self-hosted Navi supports direct presets for:

- OpenAI;
- Anthropic Claude;
- Google Gemini;
- OpenRouter;
- Groq;
- Mistral AI;
- DeepSeek;
- xAI;
- Ollama;
- LM Studio;
- Hermes Agent;
- OpenClaw;
- any custom OpenAI-compatible HTTP API.

Cloud Navi supports the hosted providers above through Worker secrets, plus a local/private OpenAI-compatible model exposed through a secure **HTTPS** endpoint.

The cloud local-model connector is only an AI endpoint. It does not connect the cloud Quest Log application to the self-hosted Quest Log application or its data.

### E-ink / FrameOS

- Token-protected JSON feed.
- Primary **HTML/CSS → Chromium screenshot → PNG** image renderer at `/api/frameos/image`.
- Self-hosted PNG output is quantized to the six Spectra colors (or monochrome) before it is returned.
- Cloud PNG output uses Cloudflare Browser Run with the same shared HTML/CSS renderer.
- The previous rendered SVG endpoint remains available as a lightweight fallback/debug renderer.
- Browser preview uses the image renderer and automatically benefits from the same display composition.
- Dashboard, Daily, Weekly, Monthly, and Countdowns display modes.
- Agenda, Weather, Tasks, Goals, Countdowns, and Markets widgets.
- Per-mode **freeform percentage-based layouts** with continuous drag and resize instead of a fixed 24 × 16 grid.
- Existing grid layouts are automatically migrated to equivalent percentage positions.
- Widget visibility, item limits, styles, ordering, landscape/portrait output, six-color and monochrome palettes remain configurable.
- Resolution-independent rendering for displays such as 800 × 480 panels.

The self-hosted container includes Chromium for screenshot rendering. If Chromium cannot start, `/api/frameos/image` automatically returns the legacy SVG renderer so the physical display is not left blank. The Cloudflare deployment declares a Browser Run binding named `BROWSER`; if Browser Run is unavailable, the same endpoint also falls back to SVG.

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
| `cloudflare/markets.js` | Cloud Yahoo Finance integration |
| `cloudflare/display.js` | Cloud e-ink feed/SVG fallback renderer |
| `eink/render.mjs` | Shared HTML/CSS e-ink renderer used by cloud and self-hosted screenshot pipelines |
| `eink/quantize.cjs` | Self-hosted six-color PNG quantizer |
| `cloudflare/migrations/` | D1 schema |
| `wrangler.jsonc` | Cloudflare Worker + D1 configuration |

---

## Push notifications

Quest Log supports standards-based Web Push notifications for tasks, timed Google Calendar events, goal deadlines, and countdowns. Push subscriptions are created per device/browser and are stored only in the Quest Log runtime that the device is connected to.

Generate one VAPID key pair:

~~~bash
npm install
npm run generate:vapid
~~~

Keep the generated **private key secret**. The public key is safe to expose to the browser.

### Self-hosted

Add these environment variables to the CasaOS/Docker deployment:

~~~text
VAPID_PUBLIC_KEY=<public key>
VAPID_PRIVATE_KEY=<private key>
VAPID_SUBJECT=mailto:you@example.com
~~~

The self-hosted runtime checks reminders every five minutes while the container is running.

Web Push requires a secure browser context. A plain LAN URL such as `http://192.168.x.x:8088` can still use Quest Log normally, but push subscription/service-worker features require HTTPS (or localhost). Use an HTTPS reverse proxy or trusted HTTPS VPN hostname for self-hosted push.

### Cloudflare

Configure:

- `VAPID_PUBLIC_KEY` as a Worker variable;
- `VAPID_PRIVATE_KEY` as a Worker secret;
- `VAPID_SUBJECT` as a Worker variable such as `mailto:you@example.com`.

The Worker has a `*/5 * * * *` Cron Trigger in `wrangler.jsonc` and checks due reminders every five minutes. Push delivery comes directly from the Worker to the browser's push service; it does not require the PWA to be open.

### Enable a device

Open **Settings → Push reminders → Enable notifications**. Approve the browser/Android permission prompt, choose the desired reminder types/lead times, and use **Send test** to verify delivery.

Each phone, tablet, or browser profile must be enabled separately. Removing a subscription on one device does not remove subscriptions on other devices.

## Install as a PWA

Quest Log can be used three ways without maintaining separate frontends:

- normal browser view;
- installed Progressive Web App (PWA);
- the same self-hosted or Cloudflare backend described below.

On Android/Chrome, open the HTTPS Quest Log URL and use **Settings → Install → Install Quest Log** when the install prompt is available. The installed app opens in a standalone window and uses the exact same Quest Log data/API as the regular browser view for that URL.

Cloudflare Access-protected deployments load the manifest with credentials so authenticated users can install the PWA without making the manifest public.

For a self-hosted LAN URL such as `http://192.168.x.x:8088`, the normal web view works but browsers do not allow service workers/PWA installation on an insecure LAN origin. Put the self-hosted instance behind HTTPS (for example a trusted reverse proxy or HTTPS VPN hostname) if you want that self-hosted URL to be installable.

The PWA service worker deliberately does not cache `/api/*`, Cloudflare Access routes, login routes, or FrameOS endpoints. Planner data continues to come from the selected Quest Log backend.

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

Google and stored Navi credentials may require additional environment variables. Markets use Yahoo Finance server-side and do not require a market API key.

The CasaOS one-click updater also requires the Docker socket. A normal Docker deployment can omit that mount and update the image using your usual Docker workflow instead.

## Self-hosted environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | For Google | Google OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | For Google | Google OAuth client secret |
| `APP_BASE_URL` | For Google | Public HTTPS origin used to build the OAuth callback |
| `APP_SECRET` | Strongly recommended | Encrypts Google tokens and saved Navi API credentials |
| `PLAID_CLIENT_ID` | For Finance | Plaid application client ID |
| `PLAID_SECRET` | For Finance | Plaid Sandbox or Production secret; keep secret |
| `PLAID_ENV` | Optional | `sandbox` while developing, `production` for live bank connections |
| `PLAID_COUNTRY_CODES` | Optional | Comma-separated Plaid countries; defaults to `CA` |
| `YODLEE_CLIENT_ID` | For Yodlee | Yodlee client-credential application ID |
| `YODLEE_SECRET` | For Yodlee | Yodlee client-credential secret; keep secret |
| `YODLEE_API_URL` | Optional | Yodlee YSL API base; defaults to sandbox |
| `YODLEE_FASTLINK_URL` | For Yodlee | FastLink 4 launch URL supplied by Yodlee |
| `YODLEE_FASTLINK_CONFIG_NAME` | For Yodlee | FastLink configuration name |
| `YODLEE_LOGIN_NAME` | Self-hosted Yodlee | Stable Yodlee user login; defaults to `questlog_selfhosted` |
| `FLINKS_AUTH_KEY` | For Flinks | Flinks Connect authorization key; keep secret |
| `FLINKS_API_KEY` | For Flinks | Flinks data API key; keep secret |
| `FLINKS_API_BASE` | For Flinks | BankingServices API base supplied by Flinks |
| `FLINKS_IFRAME_URL` | For Flinks | Flinks Connect v2 iframe URL |
| `FLINKS_REDIRECT_URL` | Optional | Absolute Quest Log `/flinks-oauth.html` URL |
| `VAPID_PUBLIC_KEY` | For notifications | Web Push public application-server key |
| `VAPID_PRIVATE_KEY` | For notifications | Web Push private application-server key; keep secret |
| `VAPID_SUBJECT` | For notifications | Contact URI, usually `mailto:you@example.com` |
| `TZ` | Optional | Container timezone |
| `DOCKER_SOCKET` | Updater only | Defaults to `/var/run/docker.sock` |
| `TARGET_CONTAINER` | Updater only | Defaults to `countdownapp` |
| `TARGET_IMAGE` | Updater only | Defaults to the GHCR edge image |

Keep `APP_SECRET` stable. Changing it makes credentials encrypted with the old value unreadable and will require reconnecting those integrations, including Plaid bank connections.

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
   +-- Yahoo Finance
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

## 3. Native Quest Log authentication

The Cloudflare app uses Quest Log's own email/password account system. Cloudflare Access should **not** sit in front of the main Quest Log hostname once native auth is deployed, otherwise users will see Cloudflare's login before Quest Log's login page.

Quest Log stores password derivations and opaque session hashes in D1. Browser sessions use an HTTP-only, SameSite cookie. Each authenticated user gets an isolated D1 workspace for planner state and connected integrations.

Recommended Worker variables:

| Variable | Purpose |
| --- | --- |
| `ALLOW_SIGNUPS` | `true` while account creation is enabled; set `false` to close registration |
| `ENFORCE_ALLOWED_EMAILS` | `yes`/`true` to restrict signup, login, and active sessions to `ALLOWED_EMAILS`; `no`/`false` disables the restriction |
| `ALLOWED_EMAILS` | Comma-separated email addresses permitted when allowlist enforcement is enabled |
| `LEGACY_OWNER_EMAIL` | Optional. When this email creates its account, the old `default` workspace is copied into that user's private workspace |
| `TURNSTILE_SITE_KEY` | Optional but recommended before public launch |
| `TURNSTILE_SECRET_KEY` | Secret paired with the Turnstile site key |

Before removing Cloudflare Access from the hostname, deploy and validate the native login branch first.

### Safe migration from the existing Access login

For an existing Quest Log installation, use this order:

1. Keep the current Cloudflare Access application/policy enabled.
2. Set `LEGACY_OWNER_EMAIL` to the email that currently owns the personal Quest Log workspace.
3. Deploy the native-auth build.
4. Visit `/login` through the existing Cloudflare Access gate and create the native Quest Log account using the same email. Quest Log verifies the Access identity before copying the legacy `default` workspace into that user's private workspace.
5. Sign out and back in to confirm the native Quest Log session and existing planner data are present.
6. Remove or disable the Cloudflare Access application/policy protecting the main Quest Log hostname. Do not remove Worker/D1/custom-domain configuration.
7. Optionally enable Cloudflare Turnstile and keep `ALLOW_SIGNUPS=true` for public registration, or set it to `false` for a closed beta.

Do not remove Access before step 4 if you need the automatic legacy workspace claim.


## 4. Configure Worker secrets

In **Workers & Pages → Quest Log Worker → Settings → Variables and Secrets**, add only the integrations you plan to use.

Core/integration secrets:

| Name | Type | Used for |
| --- | --- | --- |
| `APP_SECRET` | Secret | Credential encryption, OAuth state signing, and auth rate-limit hashing |
| `GOOGLE_CLIENT_SECRET` | Secret | Google Calendar/Tasks |
| `TURNSTILE_SECRET_KEY` | Secret | Native signup/login bot protection |
| `PLAID_SECRET` | Secret | Plaid bank connections |
| `YODLEE_SECRET` | Secret | Yodlee bank connections |
| `FLINKS_AUTH_KEY` | Secret | Flinks Connect authorization |
| `FLINKS_API_KEY` | Secret | Flinks account/transaction retrieval |
| `OPENAI_API_KEY` | Secret | Optional fallback for Cloud Navi OpenAI |
| `ANTHROPIC_API_KEY` | Secret | Optional fallback for Cloud Navi Anthropic |
| `GEMINI_API_KEY` | Secret | Optional fallback for Cloud Navi Gemini |
| `OPENROUTER_API_KEY` | Secret | Optional fallback for Cloud Navi OpenRouter |
| `GROQ_API_KEY` | Secret | Optional fallback for Cloud Navi Groq |
| `MISTRAL_API_KEY` | Secret | Optional fallback for Cloud Navi Mistral |
| `DEEPSEEK_API_KEY` | Secret | Optional fallback for Cloud Navi DeepSeek |
| `XAI_API_KEY` | Secret | Optional fallback for Cloud Navi xAI |
| `VAPID_PRIVATE_KEY` | Secret | Web Push private key |
| `LOCAL_AGENT_API_KEY` | Secret | Optional bearer token for a private local-model endpoint |
| `LOCAL_AGENT_ACCESS_CLIENT_ID` | Secret | Optional Cloudflare Access service-token client ID |
| `LOCAL_AGENT_ACCESS_CLIENT_SECRET` | Secret | Optional Cloudflare Access service-token client secret |

Useful non-secret variables:

| Name | Used for |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `YODLEE_CLIENT_ID` | Yodlee client-credential application ID |
| `YODLEE_API_URL` | Yodlee YSL API base |
| `YODLEE_FASTLINK_URL` | Yodlee FastLink 4 URL |
| `YODLEE_FASTLINK_CONFIG_NAME` | Yodlee FastLink configuration |
| `FLINKS_API_BASE` | Flinks BankingServices API base |
| `FLINKS_IFRAME_URL` | Flinks Connect v2 iframe URL |
| `FLINKS_REDIRECT_URL` | Optional Quest Log Flinks callback URL |
| `VAPID_PUBLIC_KEY` | Web Push public key |
| `VAPID_SUBJECT` | Web Push contact URI |
| `OPENAI_MODEL` | Optional OpenAI model override |
| `LOCAL_AGENT_BASE_URL` | Optional default HTTPS local-model base URL |
| `LOCAL_AGENT_MODEL` | Optional local-model override |
| `CF_ACCESS_TEAM_DOMAIN` | Access validation |
| `CF_ACCESS_AUD` | Access validation |
| `ENFORCE_ALLOWED_EMAILS` | Enables/disables the Worker-side email allowlist |
| `ALLOWED_EMAILS` | Comma-separated Worker-side email allowlist |
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

## Yahoo Finance Markets

Quest Log uses the unofficial `yahoo-finance2` server-side client for market quotes and symbol search. No market API key is required.

Open **Markets** and use the in-app search to add securities. Canadian symbols use Yahoo Finance suffixes such as `.TO` for TSX and `.V` for TSX Venture. Existing legacy `.TRT` and `.TRV` watchlist symbols are migrated automatically.

Market data is cached server-side so Today, Markets, Navi, and e-ink views can reuse the same snapshot instead of making duplicate requests.

Yahoo Finance does not provide an official public developer API, so availability and response formats can change. Quest Log keeps the provider behind its market adapter so it can be replaced later without redesigning the frontend.

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

### Hosted providers

For OpenAI, Anthropic, Gemini, OpenRouter, Groq, Mistral, DeepSeek, and xAI, choose the provider preset in **Settings → AI connection**, enter the model ID, and save the provider's API key. Quest Log fills the standard API endpoint automatically.

Anthropic uses its native Messages API. The other hosted presets use OpenAI-compatible chat/model endpoints.

### Local model presets

Quest Log includes presets for Ollama and LM Studio in addition to Hermes and OpenClaw. Enter an endpoint reachable from the Quest Log container, for example an Ollama OpenAI-compatible `/v1` endpoint or LM Studio's local server.

### Other OpenAI-compatible servers

Choose **Custom OpenAI-compatible** and enter:

- the server's `/v1` base URL;
- model ID;
- optional bearer token.

The endpoint must be reachable **from the Quest Log container**, not just from your browser. If the model runs on another computer, do not use `localhost` or `127.0.0.1`; use that computer's LAN-reachable address/hostname.

Quest Log stores a saved self-hosted agent credential encrypted with `APP_SECRET`.

The **Test connection** action checks the provider's `/v1/models` endpoint.

## Navi — cloud hosted AI

For normal cloud setup, configure **`APP_SECRET` once** on the Worker. Then manage provider credentials directly in **Settings → AI connection**:

1. Choose OpenAI, Anthropic, Gemini, OpenRouter, Groq, Mistral, DeepSeek, or xAI.
2. Paste the provider API key.
3. Save Navi.
4. Use **Load models** to discover models exposed by that provider when supported.
5. Select a discovered model or enter a model ID manually.

Quest Log encrypts saved cloud AI credentials with AES-GCM using `APP_SECRET` and stores only the ciphertext in D1. The saved API key is never returned to the browser.

Provider-specific Worker secrets such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and the matching optional `*_MODEL` values remain supported as deployment-level fallbacks, but they are no longer required for normal in-app setup.

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

- Never commit `.dev.vars`, Google client secrets, OpenAI keys, or agent bearer tokens.
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


### Spectra 6 e-ink display

Quest Log's `spectra6` palette is tuned for a 6-color e-ink panel at **800×480**. Rendered SVG output is restricted to the panel's six native colors: black, white, red, green, blue, and yellow. The display editor defaults to 800×480, with a 480×800 portrait preset.

Avoid adding arbitrary RGB colors to the e-ink renderer; event and accent colors are quantized to the native palette.
