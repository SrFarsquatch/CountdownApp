# Quest Log native app

Quest Log uses Capacitor for Android and iOS while keeping the existing PWA/web deployment.

## Architecture

- The native packages bundle the existing `public/` frontend.
- The Node/Cloudflare deployment remains the backend and web/PWA host.
- Production native builds should not use Capacitor `server.url` to point the WebView at the live website.
- Native API calls will be routed to the hosted Quest Log backend.
- Capacitor's native HTTP and cookie bridges are enabled as the basis for authenticated API access.

## Initial setup

Capacitor 8 requires Node.js 22+ for native tooling.

Install dependencies:

```bash
npm install
```

Create the platform projects once:

```bash
npm run native:add:android
npm run native:add:ios
```

Sync the current web assets and native plugins:

```bash
npm run native:sync
```

Open the platform IDE:

```bash
npm run native:open:android
npm run native:open:ios
```

## Tooling

Android development requires Android Studio and an Android SDK.

iOS development requires macOS and Xcode. Capacitor 8 currently requires Xcode 26 or newer.

## Next implementation steps

1. ✅ Native runtime/API base helper added. Packaged pages route `/api/*` to the hosted Quest Log backend while the web/PWA keeps same-origin requests.
2. Verify HTTP-only session cookie behavior through CapacitorHttp/CapacitorCookies on physical Android/iOS devices and update backend handling only if required.
3. Replace Google and finance-provider browser redirects with native browser/deep-link flows.
4. Add App/Universal Links for `questlog.mattmoonie.ca` and a custom callback scheme as a fallback.
5. Move notification delivery from web-push-only behavior to native push notifications for Android/iOS while keeping web push for the PWA.
6. Generate native splash screens and adaptive/app-store icons from the existing Quest Log branding.
7. Add platform-specific privacy declarations, permissions, and store metadata.
8. Test login, planner, invites, finance connectors, notifications, and offline behavior on physical Android and iOS devices.
