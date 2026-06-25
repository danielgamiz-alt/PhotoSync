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

GitHub Actions then builds the downloads and attaches them to one Release:

- `PhotoSync-v0.2.0.apk` — the signed Android app (the `build` job). A copy is
  also attached as a fixed-named `PhotoSync.apk` so the landing page and the
  in-app updater can link to a stable `…/releases/latest/download/PhotoSync.apk`.
- `PhotoSync-Server-Windows-v0.2.0.zip` — the portable Windows server: a
  self-contained folder (bundled Node + `PhotoServer.exe`) that family extract
  and double-click, no install or Node needed (the `windows-server` job). Also
  attached fixed-named as `PhotoSync-Server-Windows.zip`.
- `latest.json` — a small manifest (version, download URL, and a "what's new"
  list built from the commits since the previous tag) that the phone app reads
  to power its in-app update banner + notification. Generated automatically; no
  action needed.

Watch it under the repo's **Actions** tab; both files appear under **Releases**.

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

The landing page at **`docs/index.html`** (GitHub Pages) already walks through
both halves with steps and a QR code — sending that link is the easiest option.
PhotoSync needs **two** things set up, and the computer comes first:

**1. The home computer (do this once):**
1. On the household Windows PC, open the release page and download
   `PhotoSync-Server-Windows-….zip`.
2. Right-click the zip → **Extract All**, keep the folder together (e.g. in
   Documents), and double-click **PhotoServer**.
3. If Windows shows *"Windows protected your PC"*, click **More info → Run
   anyway** (normal for free apps outside the Store).
4. In the dashboard that opens, click **Browse…** and pick where photos are
   stored. Done — it now **starts automatically on every restart** and runs in
   the background (a green icon by the clock).

**2. Each phone:**
1. Open the release page → download the `PhotoSync-….apk`.
2. Android says *"unknown source"* → **Settings** → enable **Allow from this
   source** → back.
3. If **Play Protect** warns, tap **More details → Install anyway**.
4. Open **PhotoSync**, grant photo access, and on the same home Wi-Fi tap
   **Find server** — it discovers the computer automatically.

---

## Updating later

When you publish a new release, friends install the new APK the same way — it
upgrades in place (same signing key) and keeps their data.

They don't have to check manually: the app compares its own version against the
`latest.json` published with each release (fetched over Wi-Fi, no Play Store
needed) and shows a **dismissible "Update available" banner** on the main screen
plus a **one-time notification**, each listing what's new and opening the APK
download. So bumping the tag is all you do — existing users get told.

> First switch only: anyone still on a **debug** APK (signed with a per-machine
> key) must uninstall once and install a release APK before in-place updates and
> the update prompts work. After that, every future release updates in place.
