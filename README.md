# CountdownApp

Self-hosted countdown, Google Calendar, and e-ink dashboard for CasaOS.

## What it does

- Stores multiple countdowns on the server so every browser and display sees the same list.
- Gives each countdown an e-ink-safe accent color: black, red, blue, green, or yellow.
- Supports days, compact, full days/hours/minutes, and target-date countdown formats.
- Supports short, medium, long, and numeric target dates.
- Supports solid, segmented, and thin progress bars.
- Progress can be time-based, a manual goal/value, or disabled.
- Countdowns can be pinned and independently hidden from the e-ink display.
- Connects to Google Calendar with read-only OAuth and selectable calendars.
- Publishes a private JSON feed plus a rendered SVG for FrameOS.
- Renders dedicated portrait and landscape e-ink layouts with a split-flap or plain date header.
- Includes an exact web preview of the SVG sent to the display.
- Migrates existing `countdown-app-v2` browser countdowns into server storage when the upgraded server is empty.

## CasaOS deployment

GitHub Actions publishes:

`ghcr.io/srfarsquatch/countdownapp:edge`

CasaOS pulls that finished image, so the server does not need a Git checkout or local build.

1. In CasaOS open **App Store** -> **Custom Install**.
2. Import `docker-compose.casaos.yml`.
3. Install the app.
4. Open `http://<casaos-server-ip>:8088`.

The compose file maps host port **8088** to container port **8080** and mounts the named volume `countdown-data` at `/data`.

Do not delete that volume if you want to keep countdowns, display settings, the FrameOS token, and Google connection data.

## Google Calendar setup

The application requests only:

`https://www.googleapis.com/auth/calendar.readonly`

Create a Google Cloud OAuth 2.0 **Web application** credential with the Google Calendar API enabled. In CasaOS configure:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `APP_SECRET` - a long random value; keep it unchanged after connecting Google
- `APP_BASE_URL` - the externally reachable HTTPS URL for CountdownApp

Add this authorized redirect URI to the Google OAuth client:

`<APP_BASE_URL>/api/google/callback`

Restart the container, open the **Display** tab, select **Connect Google**, authorize read-only access, and choose the calendars that should appear.

The stored Google token is encrypted using AES-256-GCM derived from `APP_SECRET`. Google credentials and refresh tokens are not included in the FrameOS feed.

## FrameOS / e-ink

The **Display** tab shows the private tokenized URLs for the configured display.

Recommended endpoint:

`GET /api/frameos/svg?token=...&w=800&h=480`

This returns a complete SVG built specifically for e-ink. Change `w` and `h` to the native pixel dimensions of the panel. The renderer supports automatic, portrait, and landscape layouts.

Custom-data endpoint:

`GET /api/frameos/feed?token=...`

This returns JSON if you prefer to build the scene yourself inside FrameOS.

Browser preview:

`GET /frame?token=...&w=800&h=480`

The preview refreshes using the interval selected in Display settings.

Treat the display token like a password. **Rotate token** immediately invalidates previously issued FrameOS URLs.

## E-ink design options

Display-wide:

- 6-color / Spectra-style palette or monochrome
- auto, landscape, or portrait layout
- split-flap or plain date header
- refresh interval
- maximum countdown and agenda rows
- countdown and agenda sections independently enabled

Per countdown:

- accent color
- exact date format
- remaining-time format
- progress source
- progress style
- progress start / manual goal values
- e-ink visibility
- pinning

## Updating

Push changes to `main`. The **Publish Countdown container** GitHub workflow builds amd64 and arm64 images and publishes a new `edge` image.

After the workflow succeeds, update/recreate the Countdown app in CasaOS so `pull_policy: always` pulls the new image.

## Registry access

If CasaOS reports `unauthorized` while pulling the image, make the CountdownApp package public in GitHub Packages or authenticate the CasaOS Docker host to `ghcr.io` with a token that has `read:packages`.

## Ports

- Host: **8088**
- Container: **8080**
