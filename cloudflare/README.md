# Quest Log Cloudflare deployment

Quest Log uses one codebase for both CasaOS and Cloudflare. Do not maintain a separate cloud fork.

## Stage 1: authenticated bridge

The first cloud stage deliberately keeps the existing Node backend and JSON data store as the source of truth.

```text
Browser
  |
  | Google login through Cloudflare Access
  v
quest.example.com
Cloudflare Worker
  |-- shared public/ frontend
  |
  | Cloudflare Access service token
  v
quest-origin.example.com
Cloudflare Tunnel
  v
CasaOS :8088
  v
existing Quest Log Node backend + JSON data
```

This means the cloud and self-hosted URLs use the same frontend from the same Git commit and the same live planner data. There is no feature fork while the Worker backend is migrated to D1.

## Why this is staged

The current Node server contains persistence, Google Calendar/Tasks OAuth, Navi, weather, markets, FrameOS output and the CasaOS updater in one runtime. Rewriting all of it at once would create two implementations that could drift.

Bridge mode gives the private cloud URL first. API routes can then move to the Worker behind the same `/api/*` contract.

## Cloudflare Worker configuration

The Worker is configured by `wrangler.jsonc`.

Static files come directly from `public/`. Requests to `/api/*` and `/frame` are handled by the Worker first and forwarded to the private origin during bridge mode.

### Public Access application

Create a Cloudflare Access self-hosted application for the public Quest Log hostname, such as:

```text
quest.example.com
```

Use Google as the identity provider and create an Allow policy containing only the Google account(s) that should be able to open Quest Log.

Configure these Worker variables:

- `CF_ACCESS_TEAM_DOMAIN` - for example `your-team.cloudflareaccess.com`
- `CF_ACCESS_AUD` - Application Audience (AUD) from the public Access application
- `ALLOWED_EMAILS` - optional comma-separated email allowlist used as defense in depth
- `ORIGIN_BASE_URL` - for example `https://quest-origin.example.com`

The Worker validates the Access JWT itself before serving the application.

### Private origin application

Create a Cloudflare Tunnel from the home network to the existing CasaOS service and give it a different hostname, for example:

```text
quest-origin.example.com -> http://<casaos-host>:8088
```

Create a second Cloudflare Access self-hosted application for that origin hostname. Give it a **Service Auth** policy, not a normal user Allow policy.

Create a dedicated Access service token and save its values as Worker secrets:

- `ORIGIN_ACCESS_CLIENT_ID`
- `ORIGIN_ACCESS_CLIENT_SECRET`

The public Worker sends those service-token headers when it forwards requests to the origin.

Do not leave the origin hostname publicly accessible.

## Google OAuth

When traffic is coming through the bridge, the Node backend uses the forwarded public hostname to build its Google redirect URI.

For the production cloud deployment, register:

```text
https://quest.example.com/api/google/callback
```

in the Google OAuth Web application.

The direct CasaOS URL still works for normal planner access. If you also need a separate OAuth callback for direct self-hosted access, register that callback with Google as an additional authorized redirect URI and use the appropriate external URL.

## Local development

The local Worker can sit in front of the local Node server just like production.

1. Install dependencies:

```bash
npm install
```

2. Copy the development environment example:

```bash
cp .dev.vars.example .dev.vars
```

3. Start the existing Node app:

```bash
npm run dev:selfhosted
```

4. In another terminal start Wrangler:

```bash
npm run dev:cloudflare
```

The example development configuration uses `AUTH_BYPASS=true` and an unprotected localhost origin. Those flags are development-only and must not be used in production.

## One branch, two deployments

Both runtime targets follow `main`.

- CasaOS/GHCR continues building the Node/Docker deployment from `main`.
- Cloudflare Workers Builds should also deploy the Worker from `main`.
- Shared UI changes remain in `public/` and are consumed by both deployments automatically.
- Shared API behavior should keep the same route contract even as individual routes become Worker-native.

The Cloudflare Worker exposes:

```text
GET /api/runtime
```

and returns its Worker version metadata.

The Node backend also exposes `GET /api/runtime` and reports `runtime: "self-hosted"`.

## D1 migration

`cloudflare/migrations/0001_state_store.sql` is the initial persistence foundation.

The migration plan is:

1. **Bridge** - Worker serves the shared UI and proxies the existing backend.
2. **D1 state store** - copy the current JSON state into D1 while preserving the state shape.
3. **Native CRUD** - move tasks, goals, countdowns and settings to Worker-native routes.
4. **Cloud integrations** - move Google OAuth, Navi, weather and markets to Worker secrets/API calls.
5. **Standalone cloud** - Cloudflare no longer requires CasaOS, while the Node runtime remains available as a self-hosted deployment of the same app.

Do not duplicate frontend features between the two runtimes. New product features should continue to land in the shared UI and shared API contract.
