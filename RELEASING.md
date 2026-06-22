# Releasing PhotoSync (GitHub APK, for friends & family)

This is the no-Play-Store way to share the phone app: build a **signed** APK and
attach it to a **GitHub Release**, then send people a link (or QR code). Because
every release is signed with the **same keystore**, updates install on top of
the old version — your friends keep their photos and settings.

---

## One-time setup

### 1. Create the signing keystore (do this once, keep it forever)

From the `android/` folder, using the JDK that ships with Android Studio:

```
"C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -genkeypair -v ^
  -keystore photosync-release.jks -alias photosync ^
  -keyalg RSA -keysize 2048 -validity 10000
```

It asks for a password and a few name fields (any answers are fine). This makes
`android/photosync-release.jks`.

> **Back this file (and its passwords) up somewhere safe.** If you lose it you
> can never again ship an update that installs over an existing install —
> everyone would have to uninstall (losing their upload history) and reinstall.

### 2. Point the build at it

Copy `android/keystore.properties.example` to `android/keystore.properties` and
fill in the password you chose:

```
storeFile=photosync-release.jks
storePassword=your-password
keyAlias=photosync
keyPassword=your-password
```

Both `keystore.properties` and `*.jks` are git-ignored, so these secrets never
leave your machine.

### 3. Put the code on GitHub

Create a new repository on github.com (e.g. `PhotoServer`), then from the
project root:

```
git remote add origin https://github.com/danielgamiz-alt/PhotoServer.git
git push -u origin master
```

### 4. Add the signing secrets to GitHub (for the automated build)

The workflow at `.github/workflows/release.yml` builds and signs the APK on
GitHub's servers, so you never have to build locally. It needs your keystore as
four repository secrets. In your repo: **Settings → Secrets and variables →
Actions → New repository secret**, and add:

| Secret name | Value |
|---|---|
| `KEYSTORE_BASE64` | the keystore file, base64-encoded (see below) |
| `KEYSTORE_PASSWORD` | the store password you chose |
| `KEY_ALIAS` | `photosync` |
| `KEY_PASSWORD` | the key password you chose |

To get the base64 of your keystore, run this in PowerShell from `android/` and
paste the file's contents into the `KEYSTORE_BASE64` secret:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("photosync-release.jks")) | Set-Content -NoNewline keystore.b64.txt
```

(Delete `keystore.b64.txt` afterwards — it's just as secret as the keystore.)

---

## Each release (automated — just push a tag)

Once the secrets above are set, releasing is one step: **push a version tag.**

```
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions then builds the signed APK, names it `PhotoSync-v0.2.0.apk`, and
publishes a Release with auto-generated notes. Watch it under the repo's
**Actions** tab; the finished APK appears under **Releases**.

Notes:
- The tag *is* the version — `v0.2.0` becomes versionName `0.2.0`. You don't
  edit `build.gradle.kts` each time.
- `versionCode` is set automatically from the build number, so it always
  increases (Android requires that for in-place updates).
- Use a higher number each release (`v0.2.0` → `v0.3.0` …).

### Manual release (fallback, no Actions)

If you'd rather build locally: in Android Studio build the **release** variant
(*Build → Build APK(s)*; it picks up `keystore.properties` automatically),
then on the repo do *Releases → Draft a new release*, create the tag, and
attach `android/app/build/outputs/apk/release/app-release.apk`.

---

## What you send friends & family

Send them the **release page** (e.g. `https://github.com/<you>/PhotoServer/releases/latest`)
or a QR code that points to it. On their phone:

1. Tap the link → tap the `app-release.apk` to download it.
2. Open the downloaded file. Android says *"can't install from unknown
   source"* → tap **Settings** → enable **Allow from this source** → back.
3. If **Play Protect** warns ("unsafe app"), tap **More details → Install
   anyway**. (This is normal for any app not distributed through the Play Store.)
4. Open **PhotoSync**, grant photo access, and follow the in-app setup.

> Tip: a one-page install guide with screenshots of steps 2–3 removes almost all
> the confusion. Once your repo exists, ask me to generate a QR code and a small
> GitHub Pages landing page ("Download for Android" + those screenshots).

---

## Updating later

When you publish a new release, friends install the new APK the same way — it
upgrades in place (same signing key) and keeps their data. The in-app update
banner / notification (planned) will point them to the latest release page
automatically.
