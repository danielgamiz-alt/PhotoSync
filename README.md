# PhotoServer

A free, self-hosted alternative to Google Photos backup. Your phone automatically
uploads new photos and videos to your own computer whenever it's on the same WiFi
and the server is online. Your photos stay on hardware you own — a PC drive, an
external SSD, whatever you point it at.

```
┌──────────┐   WiFi    ┌─────────────────────┐
│  Phone    │ ────────► │   Home computer      │
│ PhotoSync │  uploads  │  PhotoServer (Node)  │──► E:\PhotoBackup\2026\06\IMG_001.jpg
└──────────┘           └─────────────────────┘
```

**Two parts:**

| Part | What it is | Where it runs |
|---|---|---|
| [`server/`](server/) | The backend: receives and stores photos. Zero dependencies. | Windows PC (anything with Node.js 18+) |
| [`desktop/`](desktop/) | A Windows **tray app + dashboard** that runs the backend for you (no terminal). | Windows |
| [`android/`](android/) | The **PhotoSync** phone app | Android 8.0+ |

## Download & install — the easy way

**👉 [danielgamiz-alt.github.io/PhotoServer](https://danielgamiz-alt.github.io/PhotoServer/)** — the download page with both apps and picture-by-picture instructions. Or scan:

<img src="docs/qr-download.png" alt="QR code to the PhotoSync download page" width="180">

No terminal, no Node.js, no install wizard. Two double-clicks and you're done:

**On the home PC (set up once, ~1 minute):**

1. Download **PhotoSync Server for Windows** (the `.zip`) from the page above and **Extract All**.
2. Double-click **`PhotoServer.exe`**. (First time, Windows SmartScreen → *More info → Run anyway* — normal for free apps outside the Store.)
3. A dashboard opens and a green tray icon appears by the clock. Click **Browse…** and pick where photos should go (an external drive is ideal).

That's it — it then **starts on its own every time the PC turns on**. No terminal stays open.

**On each phone:** install the **PhotoSync** app from the same page, allow photo access, and tap **Find server** while on home Wi‑Fi. Backups begin automatically.

> The rest of this README is for **developers** who want to run from source, change
> settings by hand, or build their own client. Everyday users don't need any of it.

## How it works

- The phone app wakes up every ~15 minutes **only while on unmetered WiFi**
  (Android's WorkManager handles this — no battery-draining background service).
- It checks if the server is reachable. If your PC is off, nothing happens;
  it just tries again later.
- It finds photos/videos that aren't backed up yet, sends their SHA-256 hashes
  to the server, and uploads only the ones the server doesn't already have.
  Re-uploads, renamed copies, and interrupted syncs never create duplicates.
- The server verifies each upload's hash (corrupted transfers are rejected) and
  files it under `<storage>/<year>/<month>/` using the photo's capture date.

---

# Part 1 — The server (backend)

> Everyday users should use the [one-click Windows app](#download--install--the-easy-way)
> above instead — it runs everything below for you. This section is for running the
> raw backend from source.

## Start it

Requires [Node.js](https://nodejs.org) 18 or newer. No `npm install` needed — zero dependencies.

```
cd server
node src/index.js
```

On Windows you can instead just double-click [`server/start-server.bat`](server/start-server.bat).

When it starts it prints something like:

```
PhotoServer v0.1.0 "Living room PC"
Storing photos in: E:\PhotoBackup (0 files indexed)
API key required: no
Listening on:
  http://192.168.0.170:8420
```

That `http://192.168.0.170:8420` line is the address you'll type into the phone
app if auto-discovery doesn't find it. Leave this window open while you want
backups to run (see [Run automatically on boot](#run-automatically-on-boot-windows)
to make it permanent).

## Where your photos are stored — and how to change it

The first run creates a config file at **[`server/config.json`](server/config.json)**:

```json
{
  "port": 8420,
  "discoveryPort": 38899,
  "storagePath": "E:/PhotoBackup",
  "serverName": "Living room PC",
  "apiKey": ""
}
```

`storagePath` is the folder where every photo is saved. To back up to a
different place — say an **external SSD** instead of your C: drive:

1. **Plug in the drive** and note its letter in File Explorer (e.g. `E:`).
   The drive must be connected *before* you start the server.
2. **Stop the server** if it's running (close the window, or press `Ctrl+C`).
3. Open `server/config.json` in any text editor (Notepad is fine) and change
   `storagePath`. Use **forward slashes** — they're the easiest and work on
   Windows too:

   ```json
   "storagePath": "E:/PhotoBackup"
   ```

   (If you prefer backslashes, you must double them: `"E:\\PhotoBackup"`.)
4. **Save the file and start the server again.** It will print
   `Storing photos in: E:\PhotoBackup` and create the folder if it doesn't exist.

Examples of valid paths:

| Goal | `storagePath` value |
|---|---|
| External SSD, drive E: (Windows) | `"E:/PhotoBackup"` |
| A folder in your user directory | `"C:/Users/You/Pictures/Backup"` |
| A network/NAS share (Windows) | `"//NAS/photos"` |

> **Moving photos you've already backed up:** changing `storagePath` only affects
> *new* uploads — the server doesn't move existing files for you. If you want your
> current backup to come along, first move the **entire** old `PhotoBackup` folder
> (including the hidden `index.json` inside it) to the new drive, *then* point
> `storagePath` at its new location. Keeping `index.json` preserves the
> de-duplication history so nothing gets re-uploaded.

**One-off override** (without editing the file):

```
node src/index.js --storage "E:/PhotoBackup"
```

## Other settings

All live in the same `server/config.json`:

| Setting | What it does |
|---|---|
| `serverName` | The name phones show when they discover this server (e.g. "Living room PC"). |
| `port` | The HTTP port. Default `8420`. Change only if something else uses it. |
| `apiKey` | Optional password. Leave `""` for none. If set, every phone must enter the **same** key in the app's Settings. Recommended if other people share your WiFi. |
| `discoveryPort` | UDP port used for "Find server". Rarely needs changing. |

Restart the server after editing `config.json` for changes to take effect.

## Windows Firewall (important)

The first time you run the server, Windows asks whether to allow Node.js network
access — **check "Private networks" and click Allow**. If you missed the prompt,
phones won't find the server; allow it manually under
*Windows Security → Firewall & network protection → Allow an app through firewall → Node.js*
(tick the **Private** box).

## Run automatically on boot (Windows)

> The [desktop app](desktop/) does this for you — "Start automatically when I log in"
> is on by default after its first run. The manual method below is only needed if
> you're running the raw backend without the desktop app.

Press `Win+R`, type `shell:startup`, and put a shortcut to
[`server/start-server.bat`](server/start-server.bat) in the folder that opens.
The server will then start whenever you log in.

## Tests

```
cd server
npm test
```

---

# Part 2 — The phone app (PhotoSync)

## Install

> Everyday users just install the APK from the
> [download page](#download--install--the-easy-way) — no build needed. The steps
> below are for building it yourself.

Open `android/` in Android Studio and **Build → Build App Bundle(s)/APK(s) →
Build APK(s)** (or run `gradlew assembleDebug`). The APK appears in
`android/app/build/outputs/apk/debug/app-debug.apk`. Copy it to the phone and
open it to install (you'll need to allow "install from unknown sources"). The
same APK can be shared with friends and family for free.

## Connect it to your server (first time)

1. Open **PhotoSync** and grant photo access when asked.
2. Open the menu (**⋮**, top-right) → **Settings**.
3. With the phone on the **same WiFi** as the server, tap **Find server** —
   it discovers your server and fills in the address automatically.
   - If nothing is found, type the address the server printed at startup into
     the **Server URL** box, e.g. `http://192.168.0.170:8420`.
   - If you set an `apiKey` on the server, enter the same key in the **API key** box.
4. Tap **Test** — it should say the server is online.
5. Turn on **Auto-upload when on WiFi**. (Optionally turn off **Include videos**
   if you only want photos.)

That's it — go back to the main screen and your photos start backing up.

## Using the app

The **main screen is your photo gallery** (newest first). Each thumbnail has a
small badge in the corner showing its backup status:

| Badge | Meaning |
|---|---|
| ☁️ gray cloud with an up-arrow | Not backed up yet |
| 🔄 spinning blue arrows | Uploading right now |
| ✅ green cloud with a check | Safely on your server |

The header shows an overall count like **"42 of 50 backed up"**.

- **Pull down** on the grid to rescan and sync immediately (and watch gray badges
  turn green).
- **⋮ menu → Sync now** does the same from the menu.
- **⋮ menu → Settings** is where the server connection and the auto-upload /
  include-videos toggles live.

When auto-upload is on, new photos you take get backed up on their own within
~15 minutes whenever you're on WiFi and the server is reachable — no need to
open the app.

## Backing up a big existing library

The first backup of a large photo library is processed in chunks of 100 files
per pass and continues automatically until everything is done. If a sync is
interrupted (you leave WiFi, the PC sleeps), it resumes exactly where it left
off — duplicates are impossible by design, because files are matched by content
hash, not by name.

---

## API (for building your own clients)

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Server identity + file count. Unauthenticated, used as the "is it online?" probe. |
| `POST /api/check` | Body `{"hashes": ["<sha256>", ...]}` → `{"missing": [...]}` |
| `PUT /api/upload` | Raw file bytes. Headers: `x-filename` (URL-encoded), `x-taken-at` (epoch ms), `x-hash` (sha256). Returns 201 if stored, 200 if it was a duplicate. |
| `GET /api/stats` | File count and storage path. |

Discovery: broadcast `PHOTOSERVER_DISCOVER_V1` over UDP to port 38899; the server
replies with JSON containing its name, HTTP port, and id.

If `apiKey` is set in the config, all endpoints except `/api/health` require the
`x-api-key` header.

## Roadmap ideas

- Web gallery to browse photos by timeline (the server already indexes everything)
- Multiple users with separate libraries
- "Free up space" — delete phone-local copies of safely backed-up photos
- iOS app
- Access from outside home via [Tailscale](https://tailscale.com)

## Security notes for v1

Traffic is plain HTTP on your local network — fine for a home WiFi you trust,
not suitable for exposure to the internet. Don't port-forward this. If you want
remote upload later, put it behind Tailscale or a reverse proxy with HTTPS.
