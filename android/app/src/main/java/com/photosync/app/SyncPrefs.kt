package com.photosync.app

import android.content.Context
import android.content.SharedPreferences

/**
 * Persistent settings and last-sync summary. (Which photos are uploaded
 * lives in [UploadLog], not here.)
 */
class SyncPrefs(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("photosync", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("serverUrl", "") ?: ""
        set(value) = prefs.edit().putString("serverUrl", value.trimEnd('/')).apply()

    var serverName: String
        get() = prefs.getString("serverName", "") ?: ""
        set(value) = prefs.edit().putString("serverName", value).apply()

    var apiKey: String
        get() = prefs.getString("apiKey", "") ?: ""
        set(value) = prefs.edit().putString("apiKey", value).apply()

    /** Account name; identifies this person so their photos get their own
     *  folder on the server. Empty until the user sets it. */
    var username: String
        get() = prefs.getString("username", "") ?: ""
        set(value) = prefs.edit().putString("username", value.trim()).apply()

    var autoSyncEnabled: Boolean
        get() = prefs.getBoolean("autoSyncEnabled", false)
        set(value) = prefs.edit().putBoolean("autoSyncEnabled", value).apply()

    var includeVideos: Boolean
        get() = prefs.getBoolean("includeVideos", true)
        set(value) = prefs.edit().putBoolean("includeVideos", value).apply()

    /** Back up only videos, skipping photos. Overrides [includeVideos]. */
    var videosOnly: Boolean
        get() = prefs.getBoolean("videosOnly", false)
        set(value) = prefs.edit().putBoolean("videosOnly", value).apply()

    /** What to back up: [MODE_CAMERA] (default), [MODE_ALL], or [MODE_CUSTOM]. */
    var backupMode: String
        get() = prefs.getString("backupMode", MODE_CAMERA) ?: MODE_CAMERA
        set(value) = prefs.edit().putString("backupMode", value).apply()

    /** Bucket ids to back up when [backupMode] is [MODE_CUSTOM]. */
    var selectedFolderIds: Set<String>
        get() = prefs.getStringSet("selectedFolderIds", emptySet())?.toSet() ?: emptySet()
        set(value) = prefs.edit().putStringSet("selectedFolderIds", value).apply()

    var lastSyncTime: Long
        get() = prefs.getLong("lastSyncTime", 0L)
        set(value) = prefs.edit().putLong("lastSyncTime", value).apply()

    var lastSyncStatus: String
        get() = prefs.getString("lastSyncStatus", "") ?: ""
        set(value) = prefs.edit().putString("lastSyncStatus", value).apply()

    var totalUploaded: Long
        get() = prefs.getLong("totalUploaded", 0L)
        set(value) = prefs.edit().putLong("totalUploaded", value).apply()

    companion object {
        /** Back up only the device camera folder (DCIM). The default. */
        const val MODE_CAMERA = "camera"
        /** Back up every photo/video folder on the device. */
        const val MODE_ALL = "all"
        /** Back up only the folders listed in [selectedFolderIds]. */
        const val MODE_CUSTOM = "custom"
    }
}
