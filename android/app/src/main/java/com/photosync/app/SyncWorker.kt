package com.photosync.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * One sync pass: if the server is reachable on the current (unmetered)
 * network, take the photos/videos not yet in the local UploadLog, ask the
 * server which of those it's missing, and upload them oldest-first. Every
 * item confirmed on the server (uploaded now, or already there) is recorded
 * in the UploadLog — which is also what the gallery's status badges show.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val prefs = SyncPrefs(applicationContext)

        // These logs are the whole point of the worker being debuggable from the
        // outside: `adb logcat -s PhotoSync` (or forcing a run with
        // `adb shell cmd jobscheduler run -f com.photosync.app <id>`) then shows
        // exactly why a pass did or didn't upload, instead of a silent no-op.
        Log.i(TAG, "sync pass starting (tags=$tags, runAttempt=$runAttemptCount)")

        // Piggyback a (throttled) update check on every pass so a new release is
        // surfaced in the background, not just when the app is opened.
        checkForUpdates(prefs)

        if (prefs.serverUrl.isEmpty()) {
            Log.i(TAG, "no server configured — nothing to do")
            prefs.lastSyncStatus = "No server configured"
            return@withContext Result.success()
        }

        if (prefs.username.isEmpty()) {
            Log.i(TAG, "no account name set — nothing to do")
            prefs.lastSyncStatus = "Set your name in Settings to back up"
            return@withContext Result.success()
        }

        SyncEvents.syncing.value = true
        try {
            val result = runPass(prefs)
            Log.i(TAG, "sync pass finished: ${prefs.lastSyncStatus} -> $result")
            result
        } finally {
            SyncEvents.syncing.value = false
            SyncEvents.uploadingItemId.value = null
        }
    }

    /**
     * Required so the worker can promote itself to a foreground service mid-pass
     * (and for any expedited start). The real progress notification is pushed via
     * setForeground() once we know how many items the pass will upload.
     */
    override suspend fun getForegroundInfo(): ForegroundInfo = foregroundInfo(0, 0)

    /** Pushes/updates the ongoing "Backing up…" notification for this pass. */
    private suspend fun setProgress(done: Int, total: Int) {
        runCatching { setForeground(foregroundInfo(done, total)) }
            .onFailure { Log.w(TAG, "could not run as a foreground service", it) }
    }

    private fun foregroundInfo(done: Int, total: Int): ForegroundInfo {
        ensureChannel()
        val text = if (total > 0) "Backing up $done of $total photos" else "Backing up photos…"
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_status_uploading)
            .setContentTitle("PhotoSync")
            .setContentText(text)
            .setOngoing(true)
            .setProgress(total, done, total == 0)
            .build()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ForegroundInfo(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(NOTIF_ID, notification)
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = applicationContext.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Backup progress", NotificationManager.IMPORTANCE_LOW)
                .apply { description = "Shows while photos are being backed up." }
        )
    }

    /**
     * Refreshes the cached latest.json (at most every few hours) and fires a
     * one-time notification when a newer app build is available. De-spammed via
     * [SyncPrefs.notifiedUpdateVersionCode] so a release notifies once, not on
     * every sync pass.
     */
    private fun checkForUpdates(prefs: SyncPrefs) {
        val sixHours = 6 * 60 * 60 * 1000L
        val stale = prefs.cachedLatest.isEmpty() ||
            System.currentTimeMillis() - prefs.lastUpdateCheckAt >= sixHours
        if (stale) {
            val body = UpdateChecker.fetch() ?: return
            prefs.cachedLatest = body
            prefs.lastUpdateCheckAt = System.currentTimeMillis()
        }
        val update = UpdateChecker.appUpdateFrom(prefs.cachedLatest, BuildConfig.VERSION_CODE) ?: return
        if (prefs.notifiedUpdateVersionCode >= update.versionCode) return
        notifyUpdate(update)
        prefs.notifiedUpdateVersionCode = update.versionCode
    }

    private fun notifyUpdate(update: UpdateChecker.AppUpdate) {
        ensureUpdateChannel()
        val view = Intent(Intent.ACTION_VIEW, Uri.parse(update.url))
        val pending = PendingIntent.getActivity(
            applicationContext, 0, view,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(applicationContext, UPDATE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_status_uploading)
            .setContentTitle(applicationContext.getString(R.string.update_notif_title))
            .setContentText(applicationContext.getString(R.string.update_notif_text, update.versionName))
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        applicationContext.getSystemService(NotificationManager::class.java)
            .notify(UPDATE_NOTIF_ID, notification)
    }

    private fun ensureUpdateChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = applicationContext.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(UPDATE_CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(
                UPDATE_CHANNEL_ID,
                applicationContext.getString(R.string.update_notif_channel),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = applicationContext.getString(R.string.update_notif_channel_desc) }
        )
    }

    private suspend fun runPass(prefs: SyncPrefs): Result {
        val api = ServerApi(prefs.serverUrl, prefs.apiKey, prefs.username)
        val health = api.health()
        if (health == null) {
            // Server not reachable right now (e.g. PC is off). That's normal;
            // the next periodic run will try again.
            Log.i(TAG, "server unreachable at ${prefs.serverUrl} — will retry next pass")
            prefs.lastSyncStatus = "Server offline, will retry"
            return Result.success()
        }
        Log.i(TAG, "server reachable: \"${health.name}\" has ${health.fileCount} files")

        val log = UploadLog.get(applicationContext)
        val done = log.uploadedIds()
        val pending = MediaScanner.itemsForBackup(applicationContext, prefs)
            .filter { it.id !in done }
            .sortedBy { it.dateAddedSec } // oldest first
        Log.i(TAG, "${pending.size} item(s) pending backup")

        if (pending.isEmpty()) {
            prefs.lastSyncTime = System.currentTimeMillis()
            prefs.lastSyncStatus = "Up to date"
            return Result.success()
        }

        val batch = pending.take(MAX_ITEMS_PER_RUN)
        var uploaded = 0
        var skipped = 0
        var errors = 0

        // We have real work to do, so run as a foreground service: this keeps
        // the upload going while the phone is locked / dozing instead of the OS
        // suspending the background worker. (Best effort — see setProgress.)
        setProgress(0, batch.size)

        try {
            // Hash the batch, ask the server what it's missing, upload that.
            val hashes = HashMap<MediaItem, String>(batch.size)
            for (item in batch) {
                MediaScanner.sha256(applicationContext, item)?.let { hashes[item] = it }
            }
            val missing = api.checkMissing(hashes.values.distinct())

            for (item in batch) {
                // Items we couldn't hash (deleted between scan and now) are
                // simply not recorded; they vanish from the next scan.
                val hash = hashes[item] ?: continue

                if (hash !in missing) {
                    // Server already has this content (e.g. uploaded from
                    // another device, or a previous app install).
                    skipped++
                    log.markUploaded(item.id, hash)
                    SyncEvents.notifyChanged()
                    setProgress(uploaded + skipped, batch.size)
                    continue
                }
                try {
                    val stream = applicationContext.contentResolver.openInputStream(item.uri)
                        ?: continue
                    SyncEvents.uploadingItemId.value = item.id
                    stream.use {
                        api.upload(it, item.sizeBytes, item.displayName, item.takenAtMs, hash)
                    }
                    uploaded++
                    prefs.totalUploaded += 1
                    log.markUploaded(item.id, hash)
                    SyncEvents.notifyChanged()
                    setProgress(uploaded + skipped, batch.size)
                    Log.i(TAG, "uploaded ${item.displayName} ($uploaded/${batch.size})")
                } catch (e: Exception) {
                    Log.w(TAG, "upload failed for ${item.displayName}", e)
                    errors++
                    // Stop the pass; this item isn't in the log, so the next
                    // run retries it first.
                    break
                } finally {
                    SyncEvents.uploadingItemId.value = null
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "sync pass failed", e)
            prefs.lastSyncStatus = "Sync error: ${e.message}"
            return Result.retry()
        }

        prefs.lastSyncTime = System.currentTimeMillis()
        val remaining = pending.size - batch.size
        prefs.lastSyncStatus = buildString {
            append("Uploaded $uploaded")
            if (skipped > 0) append(", $skipped already on server")
            if (errors > 0) append(", $errors failed")
            if (remaining > 0) append(", $remaining queued")
        }

        // Large first-time backlogs are processed in chunks; immediately
        // queue the next chunk instead of waiting for the next period.
        if (remaining > 0 && errors == 0) {
            enqueueOneTime(applicationContext)
        }

        return if (errors > 0) Result.retry() else Result.success()
    }

    companion object {
        private const val TAG = "PhotoSync"
        private const val MAX_ITEMS_PER_RUN = 100
        private const val PERIODIC_WORK = "photosync-periodic"
        private const val ONETIME_WORK = "photosync-now"
        private const val CHANNEL_ID = "backup-progress"
        private const val NOTIF_ID = 42
        private const val UPDATE_CHANNEL_ID = "app-updates"
        private const val UPDATE_NOTIF_ID = 43

        private fun wifiConstraints() = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .build()

        /** Called when auto-sync is enabled: run every 15 min while on WiFi. */
        fun schedulePeriodic(context: Context) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(wifiConstraints())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_WORK, ExistingPeriodicWorkPolicy.KEEP, request
            )
        }

        /**
         * Make sure the periodic WiFi sync is registered whenever auto-sync is
         * on. Safe to call on every app start / open (KEEP keeps any existing
         * schedule). This is what lets the phone reconnect and upload on its own
         * — once WiFi/the server come back, WorkManager runs the pending pass as
         * soon as the UNMETERED network constraint is met, without the user
         * having to open the app.
         */
        fun ensureScheduled(context: Context) {
            if (SyncPrefs(context).autoSyncEnabled) schedulePeriodic(context)
            else cancelPeriodic(context)
        }

        fun cancelPeriodic(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(PERIODIC_WORK)
        }

        /**
         * Kick off a sync as soon as the app is opened, without disrupting a pass
         * that's already running (KEEP). Gives the user an immediate "try to
         * upload now" instead of waiting up to 15 min for the next periodic run.
         */
        fun syncOnOpen(context: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(wifiConstraints())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                ONETIME_WORK, ExistingWorkPolicy.KEEP, request
            )
        }

        /** "Sync now" action and backlog chaining. */
        fun enqueueOneTime(context: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(wifiConstraints())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                ONETIME_WORK, ExistingWorkPolicy.REPLACE, request
            )
        }
    }
}
