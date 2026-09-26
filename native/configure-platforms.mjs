import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

async function exists(path) {
  try { await access(path, constants.F_OK); return true; }
  catch { return false; }
}

async function configureAndroid() {
  const file = resolve(root, 'android/app/src/main/AndroidManifest.xml');
  if (!await exists(file)) return { platform: 'android', status: 'not-created' };

  let xml = await readFile(file, 'utf8');
  const drawableDir = resolve(root, 'android/app/src/main/res/drawable');
  await mkdir(drawableDir, { recursive: true });
  const pushIcon = resolve(drawableDir, 'ic_stat_questlog.xml');
  await writeFile(pushIcon, `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="1024"
    android:viewportHeight="1024">
    <path android:fillColor="#FFFFFFFF" android:pathData="M218,652Q356,614 500,720V844Q356,742 218,770Z"/>
    <path android:fillColor="#FFFFFFFF" android:pathData="M806,652Q668,614 524,720V844Q668,742 806,770Z"/>
    <path android:fillColor="#FFFFFFFF" android:pathData="M512,142C370,142 256,256 256,398C256,554 386,654 512,778C638,654 768,554 768,398C768,256 654,142 512,142ZM512,260L545,365L650,398L545,431L512,536L479,431L374,398L479,365Z"/>
</vector>
`);

  if (!xml.includes('com.google.firebase.messaging.default_notification_icon')) {
    const applicationEnd = xml.indexOf('</application>');
    if (applicationEnd < 0) throw new Error('Could not locate Android application element.');
    const pushMetadata = `
        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_stat_questlog" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="questlog-updates" />
    `;
    xml = xml.slice(0, applicationEnd) + pushMetadata + xml.slice(applicationEnd);
  }

  const legacyQuestLogScheme = '<data android:scheme="questlog" android:host="oauth" />';
  if (xml.includes(legacyQuestLogScheme)) {
    xml = xml.replace(legacyQuestLogScheme, '<data android:scheme="questlog" />');
  } else if (!xml.includes('<data android:scheme="questlog" />')) {
    const filter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="questlog" />
            </intent-filter>`;
    const activityEnd = xml.indexOf('</activity>');
    if (activityEnd < 0) throw new Error('Could not locate Android MainActivity in AndroidManifest.xml.');
    xml = xml.slice(0, activityEnd) + filter + '\n        ' + xml.slice(activityEnd);
  }

  if (!xml.includes('android:host="questlog.mattmoonie.ca"')) {
    const filter = `
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="questlog.mattmoonie.ca" android:path="/" />
            </intent-filter>`;
    const activityEnd = xml.indexOf('</activity>');
    if (activityEnd < 0) throw new Error('Could not locate Android MainActivity in AndroidManifest.xml.');
    xml = xml.slice(0, activityEnd) + filter + '\n        ' + xml.slice(activityEnd);
    await writeFile(file, xml);
  }
  await writeFile(file, xml);

  const gradle = resolve(root, 'android/app/build.gradle');
  if (await exists(gradle)) {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const versionName = String(pkg.version || '0.1.0');
    const parts = versionName.split('.').map(value => Number.parseInt(value, 10) || 0);
    const derivedVersionCode = Math.max(1, (parts[0] || 0) * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0));
    const requestedVersionCode = Number.parseInt(process.env.NATIVE_BUILD_NUMBER || '', 10);
    const versionCode = Number.isFinite(requestedVersionCode) && requestedVersionCode > 0 ? requestedVersionCode : derivedVersionCode;
    let buildFile = await readFile(gradle, 'utf8');
    buildFile = buildFile.replace(/versionCode\s+\d+/, 'versionCode ' + versionCode);
    buildFile = buildFile.replace(/versionName\s+"[^"]+"/, 'versionName "' + versionName + '"');
    await writeFile(gradle, buildFile);
  }

  return { platform: 'android', status: 'configured' };
}

async function configureIos() {
  const file = resolve(root, 'ios/App/App/Info.plist');
  if (!await exists(file)) return { platform: 'ios', status: 'not-created' };

  let plist = await readFile(file, 'utf8');
  if (!plist.includes('<string>questlog</string>')) {
    const block = `
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeRole</key>
			<string>Editor</string>
			<key>CFBundleURLName</key>
			<string>ca.mattmoonie.questlog</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>questlog</string>
			</array>
		</dict>
	</array>`;
    const dictEnd = plist.lastIndexOf('</dict>');
    if (dictEnd < 0) throw new Error('Could not locate root dictionary in iOS Info.plist.');
    plist = plist.slice(0, dictEnd) + block + '\n' + plist.slice(dictEnd);
    await writeFile(file, plist);
  }

  if (!plist.includes('<string>questlog.mattmoonie.ca</string>')) {
    const domains = `
	<key>WKAppBoundDomains</key>
	<array>
		<string>questlog.mattmoonie.ca</string>
	</array>`;
    const dictEnd = plist.lastIndexOf('</dict>');
    if (dictEnd < 0) throw new Error('Could not locate root dictionary in iOS Info.plist.');
    plist = plist.slice(0, dictEnd) + domains + '\n' + plist.slice(dictEnd);
  }

  if (!plist.includes('<key>UIViewControllerBasedStatusBarAppearance</key>')) {
    const statusBar = `
	<key>UIViewControllerBasedStatusBarAppearance</key>
	<true/>`;
    const dictEnd = plist.lastIndexOf('</dict>');
    if (dictEnd < 0) throw new Error('Could not locate root dictionary in iOS Info.plist.');
    plist = plist.slice(0, dictEnd) + statusBar + '\n' + plist.slice(dictEnd);
  }

  await writeFile(file, plist);

  const entitlements = resolve(root, 'ios/App/App/App.entitlements');
  await writeFile(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.developer.associated-domains</key>
	<array>
		<string>applinks:questlog.mattmoonie.ca</string>
	</array>
</dict>
</plist>
`);

  const projectFile = resolve(root, 'ios/App/App.xcodeproj/project.pbxproj');
  if (await exists(projectFile)) {
    let project = await readFile(projectFile, 'utf8');
    if (!project.includes('CODE_SIGN_ENTITLEMENTS = App/App.entitlements;')) {
      project = project.replace(/(PRODUCT_BUNDLE_IDENTIFIER = ca\.mattmoonie\.questlog;)/g, 'CODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n\t\t\t\t$1');
      await writeFile(projectFile, project);
    }
  }

  const appDelegate = resolve(root, 'ios/App/App/AppDelegate.swift');
  if (await exists(appDelegate)) {
    let swift = await readFile(appDelegate, 'utf8');
    if (!swift.includes('capacitorDidRegisterForRemoteNotifications')) {
      const methods = `

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
`;
      const classEnd = swift.lastIndexOf('}');
      if (classEnd < 0) throw new Error('Could not locate AppDelegate class end.');
      swift = swift.slice(0, classEnd) + methods + swift.slice(classEnd);
      await writeFile(appDelegate, swift);
    }
  }

  return { platform: 'ios', status: 'configured' };
}

const results = await Promise.all([configureAndroid(), configureIos()]);
for (const result of results) console.log(`${result.platform}: ${result.status}`);
