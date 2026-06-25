package com.photosync.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class ServerHealth(
    val serverId: String,
    val name: String,
    val requiresApiKey: Boolean,
    val fileCount: Long,
    /** The PC app's version (e.g. "0.2.0"); "" on older servers. Reserved for a
     *  future "update PhotoSync Server on your computer" nudge. */
    val version: String = "",
)

data class UploadResult(val stored: Boolean, val path: String)

/**
 * Talks to the PhotoServer HTTP API. All methods are blocking; call them
 * from a worker thread or coroutine on Dispatchers.IO.
 *
 * [username] identifies the account; the server files each user's photos in
 * their own folder. Sent as the "x-user" header on check/upload/stats.
 */
class ServerApi(
    private val baseUrl: String,
    private val apiKey: String,
    private val username: String = "",
) {

    /** Returns health info, or null if the server is unreachable / not ours. */
    fun health(timeoutMs: Int = 3000): ServerHealth? {
        return try {
            val conn = open("GET", "/api/health", timeoutMs)
            val body = conn.inputStream.use { it.readBytes().decodeToString() }
            val json = JSONObject(body)
            if (json.optString("app") != "photoserver") return null
            ServerHealth(
                serverId = json.getString("serverId"),
                name = json.optString("name"),
                requiresApiKey = json.optBoolean("requiresApiKey"),
                fileCount = json.optLong("fileCount"),
                version = json.optString("version"),
            )
        } catch (e: Exception) {
            null
        }
    }

    /** Asks the server which of these sha256 hashes it does NOT have yet. */
    fun checkMissing(hashes: List<String>): Set<String> {
        val conn = open("POST", "/api/check")
        conn.setRequestProperty("Content-Type", "application/json")
        conn.doOutput = true
        val payload = JSONObject().put("hashes", JSONArray(hashes))
        conn.outputStream.use { it.write(payload.toString().encodeToByteArray()) }

        val body = readResponse(conn)
        val missing = JSONObject(body).getJSONArray("missing")
        return buildSet { for (i in 0 until missing.length()) add(missing.getString(i)) }
    }

    /**
     * Streams a file to the server. The server verifies the sha256 on its
     * side and skips storage if it already has the content.
     */
    fun upload(
        stream: InputStream,
        sizeBytes: Long,
        filename: String,
        takenAtMs: Long,
        sha256: String,
    ): UploadResult {
        val conn = open("PUT", "/api/upload", readTimeoutMs = 120_000)
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/octet-stream")
        conn.setRequestProperty("x-filename", URLEncoder.encode(filename, "UTF-8"))
        conn.setRequestProperty("x-taken-at", takenAtMs.toString())
        conn.setRequestProperty("x-hash", sha256)
        if (sizeBytes >= 0) {
            conn.setFixedLengthStreamingMode(sizeBytes)
        } else {
            conn.setChunkedStreamingMode(64 * 1024)
        }

        conn.outputStream.use { out -> stream.copyTo(out, bufferSize = 64 * 1024) }

        val body = readResponse(conn)
        val json = JSONObject(body)
        return UploadResult(stored = json.optBoolean("stored"), path = json.optString("path"))
    }

    private fun open(
        method: String,
        path: String,
        connectTimeoutMs: Int = 5000,
        readTimeoutMs: Int = 15000,
    ): HttpURLConnection {
        val conn = URL(baseUrl + path).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = connectTimeoutMs
        conn.readTimeout = readTimeoutMs
        if (apiKey.isNotEmpty()) conn.setRequestProperty("x-api-key", apiKey)
        if (username.isNotEmpty()) conn.setRequestProperty("x-user", URLEncoder.encode(username, "UTF-8"))
        return conn
    }

    private fun open(method: String, path: String, timeoutMs: Int): HttpURLConnection =
        open(method, path, connectTimeoutMs = timeoutMs, readTimeoutMs = timeoutMs)

    private fun readResponse(conn: HttpURLConnection): String {
        val status = conn.responseCode
        val stream = if (status in 200..299) conn.inputStream else conn.errorStream
        val body = stream?.use { it.readBytes().decodeToString() } ?: ""
        if (status !in 200..299) {
            throw ApiException(status, "HTTP $status: $body")
        }
        return body
    }
}

class ApiException(val status: Int, message: String) : Exception(message)
