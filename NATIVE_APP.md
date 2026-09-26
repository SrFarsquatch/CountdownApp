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

## Native push notifications

Quest Log keeps Web Push for the PWA and uses native push inside the installed apps.

### Android

1. Create a Firebase project for the Android app ID `ca.mattmoonie.questlog`.
2. Download `google-services.json` and place it at `android/app/google-services.json` after running `npm run native:add:android`.
3. Create a Firebase service account with permission to send FCM messages.
4. Configure these Cloudflare Worker secrets/variables:
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_CLIENT_EMAIL`
   - `FIREBASE_PRIVATE_KEY`

The Worker sends Android notifications through Firebase Cloud Messaging HTTP v1.

### iOS

1. Run `npm run native:add:ios`.
2. Open the project in Xcode and enable the **Push Notifications** capability for the App target.
3. Create an APNs authentication key in the Apple Developer portal.
4. Configure these Cloudflare Worker secrets/variables:
   - `APNS_TEAM_ID`
   - `APNS_KEY_ID`
   - `APNS_PRIVATE_KEY`
   - `APNS_BUNDLE_ID=ca.mattmoonie.questlog`
   - `APNS_SANDBOX=true` for development builds; use `false` for production/TestFlight.

The native setup script automatically adds Capacitor's required AppDelegate notification-registration hooks.

## Current implementation status

1. ✅ Native runtime/API base helper added. Packaged pages route `/api/*` to the hosted Quest Log backend while the web/PWA keeps same-origin requests.
2. ⏳ Physical-device verification of the secure HTTP-only session cookie remains.
3. ✅ Google Calendar OAuth uses the native system browser and `questlog://oauth/google` deep-link return flow.
4. ✅ Custom `questlog://` callback registration is automated for Android and iOS. Universal/App Links are still optional future hardening.
5. ✅ Native notification registration, FCM delivery, APNs delivery, notification taps, and PWA Web Push coexist in one notification pipeline.
6. ⏳ Generate final splash screens and adaptive/App Store icons from Quest Log branding.
7. ⏳ Add final privacy declarations, permissions, signing configuration, and store metadata.
8. ⏳ Adapt Plaid/Flinks/Yodlee handoffs for the native browser where required.
9. ⏳ Test login, planner, invites, finance connectors, notifications, and offline behavior on physical Android and iOS devices.
