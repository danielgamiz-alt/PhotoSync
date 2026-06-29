package com.photosync.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.google.android.material.button.MaterialButton
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Shows all photos and videos stored on the PhotoSync server for the current
 * user. Thumbnails stream directly from the server via Glide (authenticated).
 * Items already on this device show a phone-icon badge so the user knows
 * a download isn't needed. Tapping opens the full-screen viewer; the download
 * button in the viewer is hidden for items that are already local.
 */
class ServerGalleryActivity : AppCompatActivity() {

    private val SPAN_COUNT = 3

    private lateinit var prefs: SyncPrefs
    private lateinit var adapter: ServerGalleryAdapter
    private lateinit var grid: RecyclerView
    private lateinit var layoutManager: GridLayoutManager
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var emptyText: TextView
    private lateinit var datePill: TextView
    private lateinit var errorView: LinearLayout
    private lateinit var errorDetail: TextView

    private var items: List<MediaItem> = emptyList()
    private var rows: List<GalleryRow> = emptyList()

    private val pillHandler = Handler(Looper.getMainLooper())
    private val hidePill = Runnable {
        datePill.animate().alpha(0f).setDuration(400).start()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_server_gallery)
        prefs = SyncPrefs(this)

        val toolbar = findViewById<com.google.android.material.appbar.MaterialToolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)
        toolbar.setNavigationOnClickListener { finish() }

        emptyText = findViewById(R.id.emptyText)
        errorView = findViewById(R.id.errorView)
        errorDetail = findViewById(R.id.errorDetail)
        swipe = findViewById(R.id.swipeRefresh)
        datePill = findViewById(R.id.datePill)
        grid = findViewById(R.id.photoGrid)

        findViewById<MaterialButton>(R.id.retryButton).setOnClickListener { load() }

        adapter = ServerGalleryAdapter(
            apiKey = prefs.apiKey,
            username = prefs.username,
            onItemClick = ::openViewer,
        )
        layoutManager = GridLayoutManager(this, SPAN_COUNT).apply {
            spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
                override fun getSpanSize(position: Int): Int =
                    if (adapter.isHeader(position)) SPAN_COUNT else 1
            }
        }
        grid.layoutManager = layoutManager
        grid.adapter = adapter
        grid.addOnScrollListener(scrollListener)

        swipe.setOnRefreshListener { reindexAndLoad() }

        load()
    }

    /** Scans for manually-added files, then refreshes the gallery. */
    private fun reindexAndLoad() {
        lifecycleScope.launch {
            try {
                val api = ServerApi(prefs.serverUrl, prefs.apiKey, prefs.username)
                val added = withContext(Dispatchers.IO) { api.reindex() }
                if (added > 0) {
                    Toast.makeText(
                        this@ServerGalleryActivity,
                        getString(R.string.reindex_done_new, added),
                        Toast.LENGTH_LONG,
                    ).show()
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                // Reindex failure is non-fatal — still refresh the list.
            }
            load()
        }
    }

    override fun onResume() {
        super.onResume()
        // Refresh local-hashes when returning from the viewer (user may have
        // downloaded something and the UploadLog may now contain the hash).
        refreshLocalHashes()
    }

    private fun load() {
        if (prefs.serverUrl.isEmpty()) {
            swipe.isRefreshing = false
            errorDetail.text = getString(R.string.server_not_configured)
            errorView.visibility = View.VISIBLE
            return
        }
        swipe.isRefreshing = true
        errorView.visibility = View.GONE
        lifecycleScope.launch {
            try {
                val api = ServerApi(prefs.serverUrl, prefs.apiKey, prefs.username)

                // Fetch server list and local hashes concurrently.
                val serverDeferred = async(Dispatchers.IO) { api.listGallery() }
                val hashesDeferred = async(Dispatchers.IO) {
                    UploadLog.get(this@ServerGalleryActivity).uploadedHashes()
                }

                val serverItems = try {
                    serverDeferred.await()
                } catch (e: Exception) {
                    hashesDeferred.cancel()
                    throw e
                }
                val localHashes = hashesDeferred.await()

                val mediaItems = serverItems.map { item ->
                    MediaItem(
                        id = item.hash.hashCode().toLong(),
                        uri = Uri.parse(api.fileUrl(item.hash)),
                        displayName = item.name,
                        sizeBytes = item.size,
                        dateAddedSec = item.takenAt / 1000,
                        takenAtMs = item.takenAt,
                        isVideo = item.type == "video",
                    )
                }
                items = mediaItems
                val entries = mediaItems.map { GalleryEntry(it, SyncStatus.DONE) }
                rows = withContext(Dispatchers.Default) { GallerySections.build(entries) }
                adapter.submitList(rows)
                adapter.setLocalHashes(localHashes)
                emptyText.visibility = if (mediaItems.isEmpty()) View.VISIBLE else View.GONE
                rows.firstOrNull()?.sectionLabel?.let { flashDatePill(it) }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                emptyText.visibility = View.GONE
                errorDetail.text = getString(R.string.server_gallery_offline_detail)
                errorView.visibility = View.VISIBLE
            } finally {
                swipe.isRefreshing = false
            }
        }
    }

    /** Re-reads local hashes from the UploadLog (e.g. after returning from viewer). */
    private fun refreshLocalHashes() {
        lifecycleScope.launch {
            val hashes = withContext(Dispatchers.IO) {
                UploadLog.get(this@ServerGalleryActivity).uploadedHashes()
            }
            adapter.setLocalHashes(hashes)
        }
    }

    private fun openViewer(mediaIndex: Int) {
        GalleryData.items = items
        startActivity(Intent(this, PhotoViewerActivity::class.java).apply {
            putExtra(PhotoViewerActivity.EXTRA_INDEX, mediaIndex)
            putExtra(PhotoViewerActivity.EXTRA_DOWNLOADABLE, true)
        })
    }

    private fun flashDatePill(label: String) {
        if (datePill.text != label) datePill.text = label
        datePill.animate().alpha(1f).setDuration(120).start()
        pillHandler.removeCallbacks(hidePill)
        pillHandler.postDelayed(hidePill, 1200)
    }

    private val scrollListener = object : RecyclerView.OnScrollListener() {
        override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
            val pos = layoutManager.findFirstVisibleItemPosition()
            val label = rows.getOrNull(pos)?.sectionLabel ?: return
            flashDatePill(label)
        }
    }
}
