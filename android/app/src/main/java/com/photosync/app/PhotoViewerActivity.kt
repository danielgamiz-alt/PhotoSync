package com.photosync.app

import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.view.View
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.ViewPager2
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Full-screen, swipeable photo/video viewer (Google-Photos-style "open" view).
 * Videos play in-app with sound and controls; swiping to another page stops
 * playback. The media list is handed over via [GalleryData] to avoid
 * serializing it through the Intent.
 *
 * Two modes, selected by [EXTRA_DOWNLOADABLE]:
 *  - Local gallery (false): shows a filmstrip of neighbouring photos, a
 *    "Backed up to PC" pill, and a Share / Delete-locally / Delete-everywhere
 *    action bar at the bottom.
 *  - Server gallery (true): items NOT yet on this device show a download
 *    button; items already here show a phone icon. No bottom action bar.
 * Downloads go directly into DCIM/Camera via MediaStore so the photo appears in
 * the camera roll and in PhotoSync's local gallery after a pull-to-refresh.
 */
@OptIn(UnstableApi::class)
class PhotoViewerActivity : AppCompatActivity() {

    private lateinit var prefs: SyncPrefs
    private lateinit var pager: ViewPager2
    private lateinit var topBar: View
    private lateinit var dateText: TextView
    private lateinit var nameText: TextView
    private lateinit var onDeviceIcon: ImageView
    private lateinit var downloadButton: ImageButton
    private lateinit var adapter: ViewerPagerAdapter
    private var player: ExoPlayer? = null

    // Bottom chrome (local gallery only).
    private lateinit var bottomBar: View
    private lateinit var filmstrip: RecyclerView
    private lateinit var filmstripAdapter: ViewerFilmstripAdapter
    private lateinit var actionBar: View
    private lateinit var backedUpPill: View
    private lateinit var deleteEverywhereButton: View

    /** Mutable so a delete can drop the page from both the pager and filmstrip. */
    private var items: MutableList<MediaItem> = mutableListOf()
    private var chromeVisible = true
    private var downloadable = false

    /** MediaStore ids confirmed on the server; drives the pill + delete-everywhere. */
    private var backedUpIds: Set<Long> = emptySet()

    /** Hashes of files the user already has locally; populated async on start. */
    private var localHashes: Set<String> = emptySet()

    // Carried across the system delete-confirmation dialog (API 30+).
    private var pendingDeleteItem: MediaItem? = null
    private var pendingDeleteAlsoServer = false

    private val headerFormat = SimpleDateFormat("EEE, MMM d, yyyy", Locale.getDefault())

    /** Result of the system delete request (API 30+): finish the bookkeeping on OK. */
    private val deleteLauncher = registerForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            lifecycleScope.launch { finalizeDelete() }
        } else {
            pendingDeleteItem = null  // user declined the system prompt
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_photo_viewer)

        items = GalleryData.items.toMutableList()
        if (items.isEmpty()) {
            finish()
            return
        }
        val startIndex = intent.getIntExtra(EXTRA_INDEX, 0).coerceIn(0, items.size - 1)
        downloadable = intent.getBooleanExtra(EXTRA_DOWNLOADABLE, false)

        prefs = SyncPrefs(this)
        pager = findViewById(R.id.viewerPager)
        topBar = findViewById(R.id.viewerTopBar)
        dateText = findViewById(R.id.viewerDate)
        nameText = findViewById(R.id.viewerName)
        onDeviceIcon = findViewById(R.id.viewerOnDevice)
        downloadButton = findViewById(R.id.viewerDownload)
        bottomBar = findViewById(R.id.viewerBottomBar)
        filmstrip = findViewById(R.id.viewerFilmstrip)
        actionBar = findViewById(R.id.viewerActionBar)
        backedUpPill = findViewById(R.id.viewerBackedUpPill)
        deleteEverywhereButton = findViewById(R.id.viewerDeleteEverywhere)

        findViewById<View>(R.id.viewerBack).setOnClickListener { finish() }
        downloadButton.setOnClickListener { downloadCurrent() }

        // When items are server URLs (http://), use a data source factory that
        // adds auth headers; local content (content://) is handled transparently.
        val httpFactory = DefaultHttpDataSource.Factory().apply {
            val props = buildMap {
                if (prefs.apiKey.isNotEmpty()) put("x-api-key", prefs.apiKey)
                if (prefs.username.isNotEmpty()) put("x-user", URLEncoder.encode(prefs.username, "UTF-8"))
            }
            if (props.isNotEmpty()) setDefaultRequestProperties(props)
        }
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(
                DefaultMediaSourceFactory(DefaultDataSource.Factory(this, httpFactory))
            )
            .build()
        adapter = ViewerPagerAdapter(items = items, player = player!!, onTap = ::toggleChrome)
        pager.adapter = adapter
        pager.setCurrentItem(startIndex, false)
        pager.registerOnPageChangeCallback(object : ViewPager2.OnPageChangeCallback() {
            override fun onPageSelected(position: Int) {
                adapter.stopPlayback()
                updateChrome(position)
            }
        })

        if (downloadable) {
            // Server viewer: no bottom action bar / filmstrip / pill.
            bottomBar.visibility = View.GONE
            lifecycleScope.launch {
                localHashes = withContext(Dispatchers.IO) {
                    UploadLog.get(this@PhotoViewerActivity).uploadedHashes()
                }
                updateDownloadButton(pager.currentItem)
            }
        } else {
            // Local viewer: wire up the filmstrip and action bar.
            bottomBar.visibility = View.VISIBLE
            actionBar.visibility = View.VISIBLE
            filmstrip.layoutManager = LinearLayoutManager(this, LinearLayoutManager.HORIZONTAL, false)
            filmstripAdapter = ViewerFilmstripAdapter(items) { index ->
                pager.setCurrentItem(index, true)
            }
            filmstrip.adapter = filmstripAdapter
            findViewById<View>(R.id.viewerShare).setOnClickListener { shareCurrent() }
            findViewById<View>(R.id.viewerDeleteLocal).setOnClickListener { promptDelete(alsoServer = false) }
            deleteEverywhereButton.setOnClickListener { promptDelete(alsoServer = true) }
            lifecycleScope.launch {
                backedUpIds = withContext(Dispatchers.IO) {
                    UploadLog.get(this@PhotoViewerActivity).uploadedIds()
                }
                updateChrome(pager.currentItem)
            }
        }

        updateChrome(startIndex)
    }

    private fun updateChrome(position: Int) {
        val item = items.getOrNull(position) ?: return
        dateText.text = headerFormat.format(Date(item.takenAtMs))
        nameText.text = item.displayName
        updateDownloadButton(position)

        if (!downloadable) {
            filmstripAdapter.setSelected(position)
            filmstrip.smoothScrollToPosition(position)
            val backed = item.id in backedUpIds
            backedUpPill.visibility = if (backed) View.VISIBLE else View.GONE
            // The server copy can only be removed for a photo that's actually on
            // the server and with a server configured.
            val canDeleteEverywhere = backed && prefs.serverUrl.isNotEmpty()
            deleteEverywhereButton.isEnabled = canDeleteEverywhere
            deleteEverywhereButton.alpha = if (canDeleteEverywhere) 1f else 0.4f
        }
    }

    private fun updateDownloadButton(position: Int) {
        if (!downloadable) {
            onDeviceIcon.visibility = View.GONE
            downloadButton.visibility = View.GONE
            return
        }
        val item = items.getOrNull(position) ?: return
        val hash = extractFileHash(item.uri.toString())
        val alreadyLocal = hash != null && hash in localHashes
        onDeviceIcon.visibility = if (alreadyLocal) View.VISIBLE else View.GONE
        downloadButton.visibility = if (alreadyLocal) View.GONE else View.VISIBLE
    }

    private fun toggleChrome() {
        chromeVisible = !chromeVisible
        val target = if (chromeVisible) 1f else 0f
        topBar.animate().alpha(target).setDuration(150).start()
        if (!downloadable) bottomBar.animate().alpha(target).setDuration(150).start()
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (chromeVisible) {
            controller.show(WindowInsetsCompat.Type.statusBars())
        } else {
            controller.hide(WindowInsetsCompat.Type.statusBars())
        }
    }

    /** Shares the current local photo/video through the system share sheet. */
    private fun shareCurrent() {
        val item = items.getOrNull(pager.currentItem) ?: return
        val share = Intent(Intent.ACTION_SEND).apply {
            type = if (item.isVideo) "video/*" else "image/*"
            putExtra(Intent.EXTRA_STREAM, item.uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(share, getString(R.string.share_chooser)))
    }

    /** Confirms, then deletes the current photo from the device (and optionally the server). */
    private fun promptDelete(alsoServer: Boolean) {
        val item = items.getOrNull(pager.currentItem) ?: return
        val title = if (alsoServer) R.string.delete_everywhere_confirm_title
                    else R.string.delete_device_confirm_title
        val msg   = if (alsoServer) R.string.delete_everywhere_confirm_msg
                    else R.string.delete_device_confirm_msg
        AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(msg)
            .setPositiveButton(R.string.delete_confirm_ok) { _, _ -> executeDelete(item, alsoServer) }
            .setNegativeButton(R.string.delete_confirm_cancel, null)
            .show()
    }

    private fun executeDelete(item: MediaItem, alsoServer: Boolean) {
        pendingDeleteItem = item
        pendingDeleteAlsoServer = alsoServer
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val sender = MediaStore.createDeleteRequest(contentResolver, listOf(item.uri))
            deleteLauncher.launch(IntentSenderRequest.Builder(sender).build())
        } else {
            lifecycleScope.launch {
                withContext(Dispatchers.IO) {
                    try { contentResolver.delete(item.uri, null, null) }
                    catch (_: Exception) { /* best-effort */ }
                }
                finalizeDelete()
            }
        }
    }

    /**
     * After the device copy is gone: clean up the upload log, optionally tell the
     * server to drop its copy (best-effort), then remove the page from the pager
     * and filmstrip. The gallery itself re-scans on resume, so backing out shows
     * the change.
     */
    private suspend fun finalizeDelete() {
        val item = pendingDeleteItem ?: return
        val alsoServer = pendingDeleteAlsoServer
        pendingDeleteItem = null

        val log = UploadLog.get(this)
        val hash = if (alsoServer) withContext(Dispatchers.IO) { log.hashForMediaId(item.id) } else null
        withContext(Dispatchers.IO) { log.deleteByMediaId(item.id) }

        if (alsoServer && hash != null && prefs.serverUrl.isNotEmpty()) {
            val api = ServerApi(prefs.serverUrl, prefs.apiKey, prefs.username)
            val serverError = withContext(Dispatchers.IO) {
                try { api.deleteFile(hash); null } catch (e: Exception) { e.message }
            }
            if (serverError != null) {
                Toast.makeText(this, getString(R.string.delete_server_error, serverError), Toast.LENGTH_LONG).show()
            }
        }

        val idx = items.indexOfFirst { it.id == item.id }
        if (idx >= 0) {
            items.removeAt(idx)
            GalleryData.items = items.toList()
            backedUpIds = backedUpIds - item.id
            adapter.notifyItemRemoved(idx)
            if (::filmstripAdapter.isInitialized) filmstripAdapter.notifyItemRemoved(idx)
        }
        Toast.makeText(this, getString(R.string.delete_done, 1), Toast.LENGTH_SHORT).show()
        if (items.isEmpty()) {
            finish()
            return
        }
        updateChrome(pager.currentItem)
    }

    /**
     * Downloads the current server photo/video directly into DCIM/Camera via
     * MediaStore (API 29+) or a direct file write with a media scanner trigger
     * (API 26-28). Either way the photo appears in the camera roll and in
     * PhotoSync's local gallery after a pull-to-refresh.
     */
    private fun downloadCurrent() {
        val item = items.getOrNull(pager.currentItem) ?: return
        val urlString = item.uri.toString()
        if (!urlString.startsWith("http")) return

        Toast.makeText(this, R.string.downloading, Toast.LENGTH_SHORT).show()
        downloadButton.visibility = View.GONE  // optimistic hide

        lifecycleScope.launch {
            try {
                val hash = extractFileHash(urlString)
                withContext(Dispatchers.IO) {
                    val conn = (URL(urlString).openConnection() as HttpURLConnection).apply {
                        if (prefs.apiKey.isNotEmpty()) setRequestProperty("x-api-key", prefs.apiKey)
                        if (prefs.username.isNotEmpty()) setRequestProperty(
                            "x-user", URLEncoder.encode(prefs.username, "UTF-8")
                        )
                        connectTimeout = 10_000
                        readTimeout = 120_000
                    }
                    val mimeType = conn.contentType
                        ?: if (item.isVideo) "video/mp4" else "image/jpeg"
                    conn.inputStream.use { saveToGallery(item.displayName, mimeType, item.isVideo, it) }
                }
                // Update state so phone icon appears immediately for this item.
                if (hash != null) localHashes = localHashes + hash
                updateDownloadButton(pager.currentItem)
                Toast.makeText(this@PhotoViewerActivity, R.string.download_complete, Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                updateDownloadButton(pager.currentItem)  // restore button on failure
                Toast.makeText(
                    this@PhotoViewerActivity,
                    getString(R.string.download_failed, e.message ?: "unknown error"),
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
    }

    private fun saveToGallery(name: String, mimeType: String, isVideo: Boolean, input: InputStream) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val collection = if (isVideo)
                MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            else
                MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)

            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                put(MediaStore.MediaColumns.RELATIVE_PATH, "DCIM/Camera")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = contentResolver.insert(collection, values)
                ?: throw IOException("Could not create MediaStore entry")
            try {
                contentResolver.openOutputStream(uri)!!.use { out -> input.copyTo(out) }
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                contentResolver.update(uri, values, null, null)
            } catch (e: Exception) {
                contentResolver.delete(uri, null, null)
                throw e
            }
        } else {
            // API 26-28: write directly to DCIM/Camera and trigger media scan.
            val dir = File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM),
                "Camera"
            )
            dir.mkdirs()
            val file = File(dir, name)
            file.outputStream().use { out -> input.copyTo(out) }
            android.media.MediaScannerConnection.scanFile(
                this, arrayOf(file.absolutePath), arrayOf(mimeType), null
            )
        }
    }

    override fun onStop() {
        super.onStop()
        if (::adapter.isInitialized) adapter.stopPlayback()
    }

    override fun onDestroy() {
        super.onDestroy()
        player?.release()
        player = null
    }

    companion object {
        const val EXTRA_INDEX = "index"
        /** Pass true when viewing server photos to show the download / on-device indicator. */
        const val EXTRA_DOWNLOADABLE = "downloadable"

        /** Extracts the 64-char hex hash from a server file URL, or null. */
        fun extractFileHash(url: String): String? {
            val prefix = "/api/file/"
            val idx = url.lastIndexOf(prefix)
            if (idx < 0) return null
            val candidate = url.substring(idx + prefix.length)
            return if (candidate.length == 64 && candidate.all { it in '0'..'9' || it in 'a'..'f' })
                candidate else null
        }
    }
}
