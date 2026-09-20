# CountdownApp

A lightweight self-hosted countdown, Google Calendar and e-ink dashboard designed for CasaOS.

## What it does

- Create and edit multiple countdowns.
- Store countdowns persistently on the server instead of only in one browser.
- Connect Google Calendar using read-only OAuth access.
- Select which Google calendars are included.
- Show an upcoming agenda from those calendars.
- Publish a private JSON feed for FrameOS or another e-ink client.
- Provide a dedicated monochrome `/frame` view for browser-capable displays.
- Run on amd64 or arm64 from the existing GHCR/CasaOS deployment flow.

## CasaOS deployment

GitHub Actions builds the application image from `main` and publishes:

`ghcr.io/srfarsquatch/countdownapp:edge`

CasaOS pulls the finished image directly. No source checkout or local Docker build is required.

1. Open **App Store** in CasaOS.
2. Choose **Custom Install**.
3. Import/upload `docker-compose.casaos.yml`.
4. Install the application.
5. Open `http://<casaos-server-ip>:8088`.

The compose file uses `pull_policy: always`. Recreate/update the app after a successful GitHub Actions build to pull the newest image.

## Persistent data

The app stores its JSON database in the named Docker volume `countdown-data`, mounted at `/data`.

Do not delete this volume if you want to retain countdowns, Google Calendar credentials, selected calendars and the FrameOS display token.

## Google Calendar setup

The app uses Google's `calendar.readonly` scope. OAuth tokens are stored server-side and encrypted with `APP_SECRET`.

Create a Google Cloud OAuth 2.0 **Web application** credential with the Google Calendar API enabled.

Set these environment variables in the CasaOS app:

- `GOOGLE_CLIENT_ID` — OAuth client ID.
- `GOOGLE_CLIENT_SECRET` — OAuth client secret.
- `APP_SECRET` — a long random secret used to encrypt stored Google tokens.
- `APP_BASE_URL` — the externally reachable base URL, for example `https://countdown.example.com`.

Add this exact authorized redirect URI to the Google OAuth client:

`<APP_BASE_URL>/api/google/callback`

Example:

`https://countdown.example.com/api/google/callback`

Google generally requires HTTPS for web-app redirect URIs other than localhost, so use a trusted HTTPS reverse proxy/domain or an HTTPS endpoint such as a suitable Tailscale setup when connecting a self-hosted server.

After the environment variables are configured and the container is restarted:

1. Open **Displays**.
2. Click **Connect Google Calendar**.
3. Approve read-only Calendar access.
4. Select the calendars you want this app to read.
5. Choose the upcoming-event window.

## FrameOS

Open **Displays** in CountdownApp. It shows two tokenized URLs:

- **JSON feed**: `/api/frameos/feed?token=...`
- **Monochrome view**: `/frame?token=...`

The JSON feed contains:

- generation timestamp,
- next calendar event,
- upcoming selected-calendar events,
- active manual countdowns,
- days/seconds remaining.

Treat the display token like a password. Use **Rotate display token** if a URL is exposed.

For FrameOS, point an HTTP/JSON source or custom app at the full JSON feed URL. A browser-capable frame can instead use the monochrome view URL directly.

## Updating

Push changes to `main`. The **Publish Countdown container** workflow builds and publishes a fresh multi-architecture image. Then recreate/update the Countdown app in CasaOS to pull the new `edge` image.

## Registry access

If CasaOS reports `unauthorized` while pulling the image, make the `countdownapp` package public in GitHub Packages or authenticate the CasaOS Docker host to `ghcr.io` with a token that has `read:packages`.

## Port

The host web interface remains on **8088**. The container now listens internally on **8080**.
