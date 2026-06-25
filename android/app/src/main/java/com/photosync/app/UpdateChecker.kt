package com.photosync.app

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Lightweight "is there a newer app version?" check. No Google/Play dependency,
 * no extra libraries — it just fetches a small latest.json published alongside
 * each GitHub release and compares the version against this build.
 *
 * latest.json (see .github/workflows/release.yml) looks like:
 *   { "app": { "versionCode": 7, "versionName": "0.2.0",
 *              "url": "…/releases/latest/download/PhotoSync.apk",
 *              "notesUrl": "…/releases/latest",
 *              "notes": ["Easier sharing", "Bug fixes"] }, … }
 */
object UpdateChecker {

    /** Where the release pipeline publishes the manifest (stable "latest" URL). */
    private const val LATEST_URL =
        "https://github.com/danielgamiz-alt/PhotoServer/releases/latest/download/latest.json"

    /** A newer app build, parsed from latest.json. */
    data class AppUpdate(
        val versionCode: Int,
        val versionName: String,
        val url: String,
        val notesUrl: String,
        val notes: List<String>,
    )

    /**
     * Fetches latest.json and returns its raw body, or null on any failure
     * (offline, 404 before the first release with the manifest, malformed).
     * Blocking — call from Dispatchers.IO.
     */
    fun fetch(): String? = try {
        val conn = (URL(LATEST_URL).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 5000
            readTimeout = 5000
            instanceFollowRedirects = true   // releases/latest/download/* redirects
        }
        if (conn.responseCode in 200..299) {
            conn.inputStream.use { it.readBytes().decodeToString() }
        } else {
            null
        }
    } catch (e: Exception) {
        null
    }

    /**
     * Parses the "app" section of a latest.json body into an [AppUpdate] *only
     * if* it's newer than [currentVersionCode]. Returns null when the body is
     * empty/malformed or this build is already current.
     */
    fun appUpdateFrom(body: String?, currentVersionCode: Int): AppUpdate? {
        if (body.isNullOrBlank()) return null
        return try {
            val app = JSONObject(body).optJSONObject("app") ?: return null
            val code = app.optInt("versionCode", 0)
            if (code <= currentVersionCode) return null
            val url = app.optString("url")
            if (url.isEmpty()) return null
            val notesArray = app.optJSONArray("notes")
            val notes = buildList {
                if (notesArray != null) {
                    for (i in 0 until notesArray.length()) {
                        notesArray.optString(i).takeIf { it.isNotBlank() }?.let { add(it) }
                    }
                }
            }
            AppUpdate(
                versionCode = code,
                versionName = app.optString("versionName"),
                url = url,
                notesUrl = app.optString("notesUrl"),
                notes = notes,
            )
        } catch (e: Exception) {
            null
        }
    }
}
