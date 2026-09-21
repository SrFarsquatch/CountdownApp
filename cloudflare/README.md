# Quest Log Cloudflare deployment

Quest Log supports two independent runtimes from the same GitHub repository and the same `main` branch.

```text
                    SrFarsquatch/CountdownApp
                              main
                                |
                 +--------------+--------------+
                 |                             |
           CasaOS / Docker                Cloudflare
              Node.js                       Worker
                 |                             |
          JSON persistence                    D1
                 |                             |
      local environment vars              Worker secrets
```

There is deliberately **no network connection between the two deployments**.

The self-hosted runtime keeps using `/data/countdown-data.json` on CasaOS.

The cloud runtime uses Cloudflare D1 as its own source of truth.

Both deployments share the same frontend in `public/` and should keep the same API contract wherever practical so feature development stays synchronized.

## Cloud runtime

The standalone Worker is defined in:

```text
cloudflare/worker.js
```

Cloud persistence helpers are in:

```text
cloudflare/state.js
```

The initial D1 schema is:

```text
cloudflare/migrations/0001_state_store.sql
```

The Worker serves the same `public/` directory as the self-hosted app.

## Required Cloudflare resources

### 1. D1 database

Create a D1 database named:

```text
quest-log
```

Bind it to the Worker using the binding name:

```text
DB
```

The D1 database ID should also be added to `wrangler.jsonc` so GitHub/Workers Builds deploy the binding consistently.

### 2. Cloudflare Access

Protect the public Quest Log hostname, for example:

```text
questlog.mattmoonie.ca
```

with a Cloudflare Access self-hosted application.

Use Google as the identity provider and allow only the email addresses that should be able to open the cloud application.

Configure these Worker variables:

- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_AUD`
- `ALLOWED_EMAILS`

The Worker validates the Access JWT in addition to the Access policy.

### 3. Cloud workspace

By default the Worker uses one shared cloud workspace called:

```text
default
```

You can override it with:

```text
CLOUD_WORKSPACE_ID
```

Every Google login allowed through Cloudflare Access currently sees the same Quest Log cloud workspace. Multi-workspace/user isolation can be added later without coupling the cloud deployment to CasaOS.

## Cloud-only integrations

The cloud runtime uses its own credentials. Do not reuse the self-hosted app as an API backend.

### Google Calendar / Tasks

Cloud Google integration will use Worker secrets:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `APP_SECRET`

The production OAuth callback should be registered as:

```text
https://questlog.mattmoonie.ca/api/google/callback
```

These credentials and tokens belong to the cloud deployment only.

### Navi / OpenAI

Cloud Navi will use:

- `OPENAI_API_KEY`
- optional `OPENAI_MODEL`

The default model target is:

```text
gpt-5.6-luna
```

The OpenAI key is stored as a Worker secret and is never sent to the browser.

### Markets

Cloud Markets uses:

- `ALPHA_VANTAGE_API_KEY`

as a Worker secret.

### Weather

Cloud weather is fetched directly from Open-Meteo by the Worker and uses coordinates stored in D1.

## Cloud-specific behavior

Some features intentionally differ by runtime.

### Updates

Self-hosted Quest Log keeps the CasaOS one-click updater.

Cloud Quest Log is deployed from GitHub through Cloudflare Workers Builds. The cloud API reports that updates are cloud-managed and never attempts Docker/CasaOS operations.

### Persistence

Self-hosted:

```text
/data/countdown-data.json
```

Cloud:

```text
Cloudflare D1 -> questlog_state
```

The two stores never synchronize automatically.

### FrameOS

The cloud runtime keeps an independent display token in D1. Cloud FrameOS endpoints must not depend on the self-hosted server.

## Local development

Install dependencies:

```bash
npm install
```

Run the CasaOS/Node runtime:

```bash
npm run dev:selfhosted
```

For Worker development:

```bash
cp .dev.vars.example .dev.vars
npm run dev:cloudflare
```

Local Worker development requires a D1 `DB` binding. Use Wrangler's local D1 support once the binding has been added to `wrangler.jsonc`.

`AUTH_BYPASS=true` is for local development only. Never enable it in production.

## Development rule

Do not create separate product branches for cloud-only feature development.

New shared features should:

1. update the shared frontend once;
2. preserve a common API contract;
3. implement the runtime-specific persistence/integration adapter in Node and Worker as needed;
4. ship both deployments from the same `main` commit.

That keeps the cloud and self-hosted editions on the same product version without sharing infrastructure or data.
