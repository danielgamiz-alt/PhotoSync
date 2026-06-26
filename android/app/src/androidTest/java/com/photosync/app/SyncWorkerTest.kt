package com.photosync.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Fast, deterministic checks of the background sync decision — does the worker
 * detect the server and run, and does it report "offline" when it can't? — by
 * driving [SyncWorker] directly against a tiny in-process HTTP server.
 *
 * This is the answer to "I don't want to wait 15 minutes with thousands of
 * photos to find out it isn't uploading": it runs in milliseconds, needs no
 * real backup library, and never touches Doze. (Doze/constraint behaviour is an
 * OS concern, exercised separately with `adb shell dumpsys deviceidle`.)
 *
 * Run from Android Studio: right-click the class → Run, or
 * `gradlew connectedAndroidTest` against an emulator/device.
 */
@RunWith(AndroidJUnit4::class)
class SyncWorkerTest {

    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val prefs = SyncPrefs(context)
    private var server: HttpServer? = null
    private val healthHit = AtomicBoolean(false)

    // Saved so the test doesn't clobber a configured device's real settings.
    private var savedUrl = ""
    private var savedUser = ""

    @Before
    fun setUp() {
        savedUrl = prefs.serverUrl
        savedUser = prefs.username
        prefs.username = "tester"
        // Skip the piggybacked GitHub update check so the worker stays offline-only
        // and deterministic (non-empty + fresh cache => no network fetch).
        prefs.cachedLatest = "{}"
        prefs.lastUpdateCheckAt = System.currentTimeMillis()
    }

    @After
    fun tearDown() {
        server?.stop(0)
        server = null
        prefs.serverUrl = savedUrl
        prefs.username = savedUser
    }

    /** Spins up a fake PhotoServer that claims to already have every photo, so
     *  a pass completes cleanly regardless of what's in the device gallery. */
    private fun startFakeServer(): Int {
        val srv = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        srv.createContext("/api/health") { ex ->
            healthHit.set(true)
            val body = """{"app":"photoserver","serverId":"test","name":"Test","requiresApiKey":false,"fileCount":0}"""
            respond(ex, 200, body)
        }
        srv.createContext("/api/check") { ex -> respond(ex, 200, """{"missing":[]}""") }
        srv.createContext("/api/upload") { ex -> respond(ex, 201, """{"stored":true,"path":"x"}""") }
        srv.start()
        server = srv
        return srv.address.port
    }

    private fun respond(ex: com.sun.net.httpserver.HttpExchange, status: Int, body: String) {
        val bytes = body.toByteArray()
        ex.sendResponseHeaders(status, bytes.size.toLong())
        ex.responseBody.use { it.write(bytes) }
    }

    private fun runWorker(): ListenableWorker.Result {
        val worker = TestListenableWorkerBuilder<SyncWorker>(context).build()
        return runBlocking { worker.doWork() }
    }

    @Test
    fun reachableServer_runsAndSucceeds() {
        val port = startFakeServer()
        prefs.serverUrl = "http://127.0.0.1:$port"

        val result = runWorker()

        assertTrue("worker should succeed", result is ListenableWorker.Result.Success)
        assertTrue("worker should have probed /api/health", healthHit.get())
        assertTrue(
            "status should not report offline, was: ${prefs.lastSyncStatus}",
            prefs.lastSyncStatus != "Server offline, will retry"
        )
    }

    @Test
    fun unreachableServer_reportsOffline() {
        // A port nothing listens on → connection refused → health() returns null.
        val deadPort = ServerSocket(0).use { it.localPort }
        prefs.serverUrl = "http://127.0.0.1:$deadPort"

        val result = runWorker()

        assertTrue("worker should still succeed (retry later)", result is ListenableWorker.Result.Success)
        assertEquals("Server offline, will retry", prefs.lastSyncStatus)
    }
}
