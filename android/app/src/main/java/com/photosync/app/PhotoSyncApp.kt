package com.photosync.app

import android.app.Application

/**
 * Process-wide setup. Re-asserts the periodic WiFi sync on every launch so
 * background auto-upload (and automatic reconnection when WiFi or the server
 * come back) is active without the user opening Settings — the schedule is also
 * what survives reboots via WorkManager's persisted store.
 */
class PhotoSyncApp : Application() {
    override fun onCreate() {
        super.onCreate()
        SyncWorker.ensureScheduled(this)
    }
}
