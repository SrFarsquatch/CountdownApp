import { readFile, writeFile, access } from 'node:fs/promises';
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
  if (!xml.includes('android:scheme="questlog"')) {
    const filter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="questlog" android:host="oauth" />
            </intent-filter>`;
    const activityEnd = xml.indexOf('</activity>');
    if (activityEnd < 0) throw new Error('Could not locate Android MainActivity in AndroidManifest.xml.');
    xml = xml.slice(0, activityEnd) + filter + '\n        ' + xml.slice(activityEnd);
    await writeFile(file, xml);
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
  return { platform: 'ios', status: 'configured' };
}

const results = await Promise.all([configureAndroid(), configureIos()]);
for (const result of results) console.log(`${result.platform}: ${result.status}`);
