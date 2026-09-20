# Planner (formerly CountdownApp)

A self-hosted personal planner for CasaOS that combines Google Calendar, tasks, goals, countdowns and a configurable e-ink dashboard.

## What it does\n\n- Use a responsive Today dashboard that combines tasks, calendar events, goals and countdowns.\n- Create prioritized tasks with due dates, projects/lists and goal links.\n- Create measurable or deadline-driven goals and track progress.\n- Use Day, Week and Month Planner views with Google-style positioned time blocks, all-day rows, overlapping-event columns, and each calendar's Google color.
- Create, edit and delete Google Calendar events directly from Planner, including quick-creating events by tapping empty Day/Week time slots.\n- Keep the existing countdown system as a first-class planning module.\n- Configure the e-ink feed to show agenda, tasks, goals and/or countdowns.
- Build custom e-ink layouts with a drag-and-resize section editor: move Agenda, Tasks, Goals and Countdowns on a resolution-independent 12 × 8 grid, resize each section, and control per-section item limits.\n- Install the web app as a standalone PWA.\n

- Create and edit multiple countdowns with per-countdown accent colors.
- Choose days-only, days + hours, days + hours + minutes, live seconds, weeks + days, or target-date countdown displays.
- Choose short, medium, long, or numeric date formats.
- Add solid, segmented, or thin progress bars using time elapsed or manual goals.
- Pin important countdowns and independently hide them from e-ink.
- Store countdowns persistently on the server instead of only in one browser.
- Connect multiple Google accounts using OAuth and choose calendars independently from each account.
- Sync selected Google Task lists two ways: Google-created tasks appear in Planner, and linked Planner tasks write title, notes, due date, completion, edits, and deletes back to Google.
- Select which Google calendars are included.
- Show an upcoming agenda from those calendars.
- Publish a private JSON feed for FrameOS or another e-ink client.
- Publish a rendered SVG endpoint so FrameOS can show the exact dashboard design.
- Provide a dedicated `/frame` preview that uses that same SVG renderer.
- Render landscape or portrait layouts with split-flap/plain date headers and six-color or monochrome palettes.
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

The app stores its JSON database at `/DATA/AppData/$AppID/data` on the CasaOS host, bind-mounted to `/data` in the container.

Do not delete that AppData folder if you want to retain countdowns, Google Calendar credentials, selected calendars and the FrameOS display token.

## Google Calendar setup

Planner requests Google's `calendar.events`, `calendar.calendarlist.readonly`, and `tasks` scopes. Calendar events and selected Google Task lists can sync both ways while calendar-subscription management remains read-only. OAuth tokens are stored server-side and encrypted with `APP_SECRET`.

Create a Google Cloud OAuth 2.0 **Web application** credential with both the **Google Calendar API** and **Google Tasks API** enabled.

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

1. Open **Settings → Google Calendar**.
2. Click **Connect Google Calendar**.
3. Approve Calendar event access, read-only calendar-list access, and Google Tasks access.
4. Select the calendars you want Planner to display.
5. Choose which Google Task lists should sync and select a default task list for new linked Planner tasks.
6. Planner only enables event editing on calendars where Google reports `writer` or `owner` access.

If an account was connected before Calendar writeback or Google Tasks sync was enabled, reconnect that account once so Google can issue a token containing the current scopes.

Google Tasks only stores a due **date** through the API, not a due time. Planner keeps the local time component while syncing the date to Google.

## FrameOS

Open **Display** in CountdownApp. It shows private tokenized display URLs:

- **Rendered SVG**: `/api/frameos/svg?token=...&w=800&h=480`
- **JSON feed**: `/api/frameos/feed?token=...`
- **Browser preview**: `/frame?token=...&w=800&h=480`

Use the rendered SVG when you want FrameOS to match CountdownApp exactly. Set `w` and `h` to the panel's native resolution. The renderer automatically supports portrait and landscape sizing and deliberately limits itself to e-ink-safe colors.

The JSON feed contains:

- generation timestamp,
- next calendar event,
- upcoming selected-calendar events,
- active manual countdowns,
- days/seconds remaining.

Treat the display token like a password. Use **Rotate display token** if a URL is exposed.

For FrameOS, use the rendered SVG endpoint for the built-in CountdownApp layout, or point a custom app at the JSON feed if you want to build your own scene.

Per-countdown display controls include accent color, time/date format, progress source/style, pinning, and e-ink visibility. Display-wide controls include palette, layout, date-header style, refresh interval, and row limits.

The **Displays → Section editor** can switch between automatic layout and a custom grid. In custom mode, drag sections to reposition them and use the bottom-right handle to resize them. **Arrange for resolution** creates a two-column landscape layout or a stacked portrait layout based on the preview dimensions. Long agenda/task labels are clipped and shortened inside their section so they do not bleed into neighboring content.

## Update Center

Planner checks the published GHCR image in the background and shows an **Update** badge on Settings when a newer container is available. The Settings update card shows the installed build, latest build, last check time, and a staged progress bar while an update is being installed.

Update progress survives the brief container restart because it is written to the persistent `/data/update-status.json` file. The UI polls the status endpoint through the restart and reloads Planner after the new container reports healthy.

## One-click updates

The CasaOS install still runs as a single long-lived application container. There is no permanent updater sidecar and no `depends_on` install dependency.

The app mounts `/var/run/docker.sock` so **Settings → Application updates** can check the published image and launch a short-lived helper container only when **Install update** is requested. That helper:

- pulls the newest `ghcr.io/srfarsquatch/countdownapp:edge` image,
- reports staged progress for download, preparation, restart, health verification and cleanup,
- recreates only the `countdownapp` container,
- preserves the current environment, port, network, labels, health check and mounts,
- waits for the replacement to become healthy,
- restores the previous container if the replacement fails,
- writes update progress to `/DATA/AppData/countdownapp/data/update-status.json`,
- removes itself automatically when finished.

Because Docker socket access is effectively host-level Docker control, only expose CountdownApp to people you trust.

Existing installations created from the single-container compose must be re-imported once after this change so the Docker socket mount is added. After that, future updates can be installed directly from the app page.

Persistent application data remains at:

`/DATA/AppData/countdownapp/data`

## Updating the source

Push changes to `main`. The **Publish Countdown container** workflow builds and publishes a fresh multi-architecture image. Once GitHub Actions finishes, an installed CountdownApp can pull it from its **Update now** button.

## Registry access

If CasaOS reports `unauthorized` while pulling the image, make the `countdownapp` package public in GitHub Packages or authenticate the CasaOS Docker host to `ghcr.io` with a token that has `read:packages`.

## Port

The host web interface remains on **8088**. The container now listens internally on **8080**.
