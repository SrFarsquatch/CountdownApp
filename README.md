# Quest Log

Quest Log is a self-hosted personal planning app for CasaOS that combines Google Calendar, tasks, goals, countdowns and a configurable e-ink dashboard.

## What it does\n\n- Use a responsive Today dashboard that combines tasks, calendar events, goals and countdowns.\n- Create prioritized tasks with due dates, projects/lists and goal links.\n- Create measurable or deadline-driven goals and track progress.\n- Use Day, Week and Month Planner views with Google-style positioned time blocks, all-day rows, overlapping-event columns, and each calendar's Google color.
- Create, edit and delete Google Calendar events directly from Quest Log, including quick-creating events by tapping empty Day/Week time slots.\n- Keep the existing countdown system as a first-class planning module.\n- Configure the e-ink feed to show agenda, weather, tasks, goals, countdowns and/or markets.
- Add current conditions and forecasts from Open-Meteo, with daily, weekly and monthly e-ink planner layouts.
- Search for a weather location by city/town, save its coordinates automatically, and show the current conditions plus a 7-day forecast on the Today dashboard.
- Manage weather location and units in Settings, then place Weather as a resizable e-ink dashboard widget with Compact, Current conditions, or Forecast strip styles.
- Customize Dashboard, Daily, Weekly, Monthly, and Countdowns modes independently. Each mode stores its own widget positions/sizes and per-widget visibility, style, and item limit settings.
- The e-ink editor now uses a 24 × 16 grid for finer placement/resizing, migrates existing 12 × 8 layouts automatically, and uses a compact live date/mode/time header so more of the screen is available for widgets.
- Keep colour e-ink and monochrome output modes; weather and calendar accents are quantized to the supported e-ink palette.
- Build custom e-ink layouts with a drag-and-resize section editor on a resolution-independent 24 × 16 grid, including Agenda, Weather, Tasks, Goals, Countdowns, and Markets widgets.\n- Install the web app as a standalone PWA.\n

- Create and edit multiple countdowns with per-countdown accent colors.
- Choose days-only, days + hours, days + hours + minutes, live seconds, weeks + days, or target-date countdown displays.
- Choose short, medium, long, or numeric date formats.
- Add solid, segmented, or thin progress bars using time elapsed or manual goals.
- Pin important countdowns and independently hide them from e-ink.
- Store countdowns persistently on the server instead of only in one browser.
- Connect multiple Google accounts using OAuth and choose calendars independently from each account.
- Sync selected Google Task lists two ways: Google-created tasks appear in Quest Log, and linked Quest Log tasks write title, notes, due date, completion, edits, and deletes back to Google.
- Select which Google calendars are included.
- Show an upcoming agenda from those calendars.
- Publish a private JSON feed for FrameOS or another e-ink client.
- Publish a rendered SVG endpoint so FrameOS can show the exact dashboard design.
- Provide a dedicated `/frame` preview that uses that same SVG renderer.
- Render landscape or portrait layouts with split-flap/plain date headers and six-color or monochrome palettes.
- Run on amd64 or arm64 from the existing GHCR/CasaOS deployment flow.


## Hybrid weather

Quest Log uses a hybrid weather pipeline. **Open-Meteo** remains the global forecast source and fallback. For Canadian locations, Quest Log also queries Environment and Climate Change Canada's experimental **City Page Weather** GeoMet collection and uses the nearest official city page when it is close enough to the selected location.

When Environment Canada data is available, current temperature, humidity, wind, gusts, condition, station details, official forecast text, and active city-page warnings can be surfaced from ECCC. The multi-day forecast tiles continue to use Open-Meteo so the dashboard and e-ink layouts retain a consistent 10-day forecast. If ECCC is unavailable, Quest Log falls back to Open-Meteo automatically instead of breaking the weather widget.

The web dashboard uses custom inline SVG weather icons instead of platform-dependent emoji. The e-ink renderer continues to use its own e-ink-safe SVG weather symbols and palette.

## Alpha Vantage market setup

Quest Log can show an automatic market watchlist on the Today dashboard, a dedicated Markets page, and a configurable e-ink Markets widget. Market prices are fetched server-side from Alpha Vantage and cached aggressively to protect the free API quota.

1. Create a Alpha Vantage account and copy the API key from the Alpha Vantage dashboard.
2. Add this environment variable to the CasaOS app: `ALPHA_VANTAGE_API_KEY`.
3. Recreate/restart the container after adding the variable.
4. Open **Markets** in Quest Log and search for the stocks or ETFs you want to follow. Canadian Toronto/TSX Venture results are stored using Alpha Vantage's provider-qualified symbol.

The API key is never sent to the browser. The watchlist is capped at eight symbols. Alpha Vantage's standard free allowance is small, so Quest Log automatically enforces a quota-safe cache interval based on watchlist size (and never less than the configured 4–24 hour cache). Canadian symbols should be added through the in-app search so the correct Alpha Vantage symbol is preserved.

## CasaOS updater behavior

Quest Log keeps the one-click **Install update** experience without renaming or replacing CasaOS-managed containers behind CasaOS's back. Quest Log pulls the newest GHCR image, launches a short-lived helper, and hands the existing compose configuration back to CasaOS App Management so CasaOS performs the recreate itself. The helper waits for the new container to become healthy, updates the Maintenance progress state, and then removes itself automatically.

If an older build previously left CasaOS pointing at a deleted container, back up `/DATA/AppData/countdownapp/data`, remove/recreate only the app container once, and re-import the current CasaOS compose without deleting that data directory.

## Appearance

Quest Log supports **System**, **Light**, and **Dark** appearance modes plus five interface themes: **Quest**, **Moss**, **Ember**, **Arcane**, and **Slate**. Appearance settings are stored server-side so they follow the user across devices, while a small local cache applies the last theme before the app finishes loading to avoid a flash of the wrong theme. **Comfortable** and **Compact** interface density options are also available.

Website appearance is independent from the e-ink display palette, so changing the Quest Log theme does not alter Spectra 6 or monochrome FrameOS output.

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

Quest Log requests Google's `calendar.events`, `calendar.calendarlist.readonly`, and `tasks` scopes. Calendar events and selected Google Task lists can sync both ways while calendar-subscription management remains read-only. OAuth tokens are stored server-side and encrypted with `APP_SECRET`.

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
4. Select the calendars you want Quest Log to display.
5. Choose which Google Task lists should sync and select a default task list for new linked Quest Log tasks.
6. Quest Log only enables event editing on calendars where Google reports `writer` or `owner` access.

If an account was connected before Calendar writeback or Google Tasks sync was enabled, reconnect that account once so Google can issue a token containing the current scopes.

Google Tasks only stores a due **date** through the API, not a due time. Quest Log keeps the local time component while syncing the date to Google.

## FrameOS

Open **Display** in Quest Log. It shows private tokenized display URLs:

- **Rendered SVG**: `/api/frameos/svg?token=...&w=800&h=480`
- **JSON feed**: `/api/frameos/feed?token=...`
- **Browser preview**: `/frame?token=...&w=800&h=480`

Use the rendered SVG when you want FrameOS to match Quest Log exactly. Set `w` and `h` to the panel's native resolution. The renderer automatically supports portrait and landscape sizing and deliberately limits itself to e-ink-safe colors.

The JSON feed contains:

- generation timestamp,
- next calendar event,
- upcoming selected-calendar events,
- active manual countdowns,
- days/seconds remaining.

Treat the display token like a password. Use **Rotate display token** if a URL is exposed.

For FrameOS, use the rendered SVG endpoint for the built-in Quest Log layout, or point a custom app at the JSON feed if you want to build your own scene.

Per-countdown display controls include accent color, time/date format, progress source/style, pinning, and e-ink visibility. Display-wide controls include palette, layout, date-header style, refresh interval, and row limits.

Quest Log display modes now include **Daily**, **Weekly**, and **Monthly**. When Weather is enabled and a latitude/longitude is configured, Daily shows current conditions and today's high/low, Weekly adds a compact forecast per day, and Monthly adds weather markers for forecast days. Weather data is fetched from Open-Meteo server-side and cached for 15 minutes. No weather API key, billing account, or extra OAuth scope is required.

The **Displays → Section editor** can switch between automatic layout and a custom grid. In custom mode, drag sections to reposition them and use the bottom-right handle to resize them. **Arrange for resolution** creates a two-column landscape layout or a stacked portrait layout based on the preview dimensions. Long agenda/task labels are clipped and shortened inside their section so they do not bleed into neighboring content.

## Update Center

Quest Log checks the published GHCR image in the background and shows an **Update** badge on Settings when a newer container is available. The Settings update card shows the installed build, latest build, last check time, and a staged progress bar while an update is being installed.

Update progress survives the brief container restart because it is written to the persistent `/data/update-status.json` file. The UI polls the status endpoint through the restart and reloads Quest Log after the new container reports healthy.

## One-click updates

The CasaOS install runs as one long-lived Quest Log container. **Settings → Application updates → Install update** is a one-click flow with no second CasaOS confirmation step.

When selected, Quest Log:

- pulls the newest `ghcr.io/srfarsquatch/countdownapp:edge` image,
- starts a short-lived helper on the CasaOS host network,
- reads the current compose definition from CasaOS App Management,
- asks CasaOS App Management to apply that same compose definition after the new image has been pulled,
- lets CasaOS recreate the managed Quest Log container so its internal container tracking stays correct,
- waits for the replacement container to be running and healthy,
- records progress in `/DATA/AppData/countdownapp/data/update-status.json`,
- reloads Quest Log when the update finishes,
- removes the helper automatically.

The helper accesses CasaOS App Management only through CasaOS's local runtime address and uses the already-mounted Docker socket to launch the temporary update process. Docker socket access is effectively host-level Docker control, so only expose Quest Log to people you trust.

## Updating the source

Push changes to `main`. The **Publish Countdown container** workflow builds and publishes a fresh multi-architecture image. Once GitHub Actions finishes, an installed Quest Log instance can pull it from its **Update now** button.

## Registry access

If CasaOS reports `unauthorized` while pulling the image, make the `countdownapp` package public in GitHub Packages or authenticate the CasaOS Docker host to `ghcr.io` with a token that has `read:packages`.

## Port

The host web interface remains on **8088**. The container now listens internally on **8080**.
