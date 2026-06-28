package com.photosync.app

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Main screen: the device's photos as a Google-Photos-style date-sectioned
 * grid. A floating pill shows the date of the photos currently in view, video
 * tiles show their duration and preview while scrolling, each tile carries a
 * backup-status badge, and tapping opens the full-screen viewer.
 */
class MainActivity : AppCompatActivity() {

    private val SPAN_COUNT = 3

    private lateinit var prefs: SyncPrefs
    private lateinit var adapter: GalleryAdapter
    private lateinit var grid: RecyclerView
    private lateinit var layoutManager: GridLayoutManager
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var summaryText: TextView
    private lateinit var summaryProgress: ProgressBar
    private lateinit var emptyText: TextView
    private lateinit var datePill: TextView
    private lateinit var filterPhotos: TextView
    private lateinit var filterVideos: TextView
    private lateinit var setupButton: View
    private lateinit var setupCard: View
    private lateinit var setupStep1: TextView
    private lateinit var setupStep2: TextView
    private lateinit var setupStep3: TextView
    private lateinit var inviteCard: View
    private lateinit var updateBanner: View
    private lateinit var updateVersionText: TextView
    private lateinit var updateNotesText: TextView
    private var pendingUpdate: UpdateChecker.AppUpdate? = null
    private lateinit var previewController: VideoPreviewController

    /** All scanned items (the chosen backup source). */
    private var allItems: List<MediaItem> = emptyList()
    /** The subset currently shown (after the bottom Photos/Videos filter). */
    private var items: List<MediaItem> = emptyList()
    private var rows: List<GalleryRow> = emptyList()

    /** Bottom filter: false = Photos (photos + videos), true = videos only. */
    private var videosOnly = false

    /** Last-seen "name + server are both set" state; null until first checked. */
    private var wasConfigured: Boolean? = null

    private val pillHandler = Handler(Looper.getMainLooper())
    private val hidePill = Runnable {
        datePill.animate().alpha(0f).setDuration(400).start()
    }

    /** Briefly shows the floating date pill with [label], then fades it out. */
    private fun flashDatePill(label: String) {
        if (datePill.text != label) datePill.text = label
        datePill.animate().alpha(1f).setDuration(120).start()
        pillHandler.removeCallbacks(hidePill)
        pillHandler.postDelayed(hidePill, 1200)
    }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
            // Only the media grant gates the gallery; notifications are optional
            // (a denied notification permission shouldn't show "permission needed").
            if (hasMediaPermission()) {
                refresh()
            } else {
                emptyText.setText(R.string.permission_needed)
                emptyText.visibility = View.VISIBLE
            }
        }

    @OptIn(FlowPreview::class, UnstableApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = SyncPrefs(this)

        summaryText = findViewById(R.id.summaryText)
        summaryProgress = findViewById(R.id.summaryProgress)
        emptyText = findViewById(R.id.emptyText)
        swipe = findViewById(R.id.swipeRefresh)
        datePill = findViewById(R.id.datePill)
        grid = findViewById(R.id.photoGrid)

        filterPhotos = findViewById(R.id.filterPhotos)
        filterVideos = findViewById(R.id.filterVideos)
        filterPhotos.setOnClickListener { setVideosOnly(false) }
        filterVideos.setOnClickListener { setVideosOnly(true) }
        updateFilterUi()

        setupButton = findViewById(R.id.setupButton)
        setupCard = findViewById(R.id.setupCard)
        setupStep1 = findViewById(R.id.setupStep1)
        setupStep2 = findViewById(R.id.setupStep2)
        setupStep3 = findViewById(R.id.setupStep3)
        val openSettings = View.OnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        setupButton.setOnClickListener(openSettings)
        setupCard.setOnClickListener(openSettings)

        inviteCard = findViewById(R.id.inviteCard)
        findViewById<View>(R.id.inviteShareButton).setOnClickListener {
            dismissInviteCard()
            shareApp()
        }
        findViewById<View>(R.id.inviteDismissButton).setOnClickListener { dismissInviteCard() }

        updateBanner = findViewById(R.id.updateBanner)
        updateVersionText = findViewById(R.id.updateVersionText)
        updateNotesText = findViewById(R.id.updateNotesText)
        findViewById<View>(R.id.updateActionButton).setOnClickListener {
            pendingUpdate?.let { openUrl(it.url) }
        }
        findViewById<View>(R.id.updateWhatsNewButton).setOnClickListener {
            pendingUpdate?.let { openUrl(it.notesUrl.ifEmpty { it.url }) }
        }
        findViewById<View>(R.id.updateDismissButton).setOnClickListener {
            pendingUpdate?.let { prefs.dismissedUpdateVersionCode = it.versionCode }
            updateBanner.visibility = View.GONE
        }

        val previewPlayer: PlayerView = findViewById(R.id.previewPlayer)
        val previewChipContainer: View = findViewById(R.id.previewChipContainer)
        val previewDurationText: TextView = findViewById(R.id.previewDurationText)
        previewController = VideoPreviewController(
            previewPlayer, previewChipContainer, previewDurationText,
        ) { rows }
        previewController.onPreviewClick = ::openViewer

        adapter = GalleryAdapter(onPhotoClick = ::openViewer)
        layoutManager = GridLayoutManager(this, SPAN_COUNT).apply {
            spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
                override fun getSpanSize(position: Int): Int =
                    if (adapter.isHeader(position)) SPAN_COUNT else 1
            }
        }
        grid.layoutManager = layoutManager
        grid.adapter = adapter
        grid.addOnScrollListener(scrollListener)

        swipe.setOnRefreshListener {
            refresh()
            if (prefs.serverUrl.isNotEmpty()) SyncWorker.enqueueOneTime(this)
        }

        // Live updates while the worker runs: re-read statuses when the
        // upload log changes or the currently-uploading item moves on.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(SyncEvents.revision, SyncEvents.uploadingItemId) { _, uploading -> uploading }
                    .debounce(150)
                    .collect { applyStatuses() }
            }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                SyncEvents.syncing.collect { syncing ->
                    if (!syncing) swipe.isRefreshing = false
                }
            }
        }

        updateSetupState()
        ensureMediaPermission()
    }

    override fun onResume() {
        super.onResume()
        // Reflect any changes made in Settings (name / server) immediately.
        updateSetupState()
        if (hasMediaPermission()) refresh()
        renderUpdateBanner()
        maybeRefreshUpdate()
        // Opening the app should try to sync right away (and make sure the
        // background WiFi schedule is in place) rather than waiting for the next
        // periodic run — so a just-reachable server uploads immediately.
        SyncWorker.ensureScheduled(this)
        if (prefs.serverUrl.isNotEmpty() && prefs.username.isNotEmpty()) {
            SyncWorker.syncOnOpen(this)
        }
    }

    /**
     * Shows the persistent "Set up backup" CTA and the first-run checklist card
     * until both the account name and the server URL are set, then hides them.
     */
    private fun updateSetupState() {
        val nameDone = prefs.username.isNotEmpty()
        val serverDone = prefs.serverUrl.isNotEmpty()
        val configured = nameDone && serverDone
        // null on the very first call so a returning, already-configured user
        // doesn't see the completion flash on every cold start — it only fires
        // on a genuine not-configured -> configured transition in-session.
        val justFinished = wasConfigured == false && configured
        wasConfigured = configured

        if (justFinished) {
            // The user just completed the last setup step. Flash an all-complete
            // checklist (every row a ✓) as a brief "you're all set" beat before
            // the card slides away — otherwise step 3 never earns its ✓.
            setupButton.visibility = View.GONE
            setupCard.visibility = View.VISIBLE
            styleSetupStep(setupStep1, 1, true, R.string.setup_step_name)
            styleSetupStep(setupStep2, 2, true, R.string.setup_step_server)
            styleSetupStep(setupStep3, 3, true, R.string.setup_step_done)
            setupCard.postDelayed({ setupCard.visibility = View.GONE }, 1400)
            return
        }

        setupButton.visibility = if (configured) View.GONE else View.VISIBLE
        setupCard.visibility = if (configured) View.GONE else View.VISIBLE

        styleSetupStep(setupStep1, 1, nameDone, R.string.setup_step_name)
        styleSetupStep(setupStep2, 2, serverDone, R.string.setup_step_server)
        styleSetupStep(setupStep3, 3, configured, R.string.setup_step_done)
    }

    /** Renders one checklist row: a ✓ in accent when done, else its number. */
    private fun styleSetupStep(step: TextView, number: Int, done: Boolean, labelRes: Int) {
        val marker = if (done) "✓" else number.toString()
        step.text = "$marker  ${getString(labelRes)}"
        val color = if (done) R.color.accent else R.color.text_primary
        step.setTextColor(ContextCompat.getColor(this, color))
    }

    override fun onStop() {
        super.onStop()
        previewController.onStop()
    }

    override fun onDestroy() {
        super.onDestroy()
        previewController.release()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.menu_main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_sync_now -> {
                when {
                    prefs.serverUrl.isEmpty() -> {
                        Toast.makeText(this, R.string.configure_server_first, Toast.LENGTH_LONG).show()
                        startActivity(Intent(this, SettingsActivity::class.java))
                    }
                    prefs.username.isEmpty() -> {
                        Toast.makeText(this, R.string.set_name_first, Toast.LENGTH_LONG).show()
                        startActivity(Intent(this, SettingsActivity::class.java))
                    }
                    else -> {
                        SyncWorker.enqueueOneTime(this)
                        Toast.makeText(this, R.string.sync_queued, Toast.LENGTH_SHORT).show()
                    }
                }
                true
            }
            R.id.action_setup_computer -> {
                startActivity(Intent(this, ComputerSetupActivity::class.java))
                true
            }
            R.id.action_invite -> {
                shareApp()
                true
            }
            R.id.action_settings -> {
                startActivity(Intent(this, SettingsActivity::class.java))
                true
            }
            R.id.action_help -> {
                startActivity(Intent(this, HelpActivity::class.java))
                true
            }
            else -> super.onOptionsItemSelected(item)
        }
    }

    /**
     * "Invite a friend": opens the system share sheet (WhatsApp, Messages,
     * email…) with the install link, so people can spread PhotoSync the same
     * way they share everything else.
     */
    private fun shareApp() {
        val share = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, getString(R.string.invite_subject))
            putExtra(Intent.EXTRA_TEXT, getString(R.string.invite_text, getString(R.string.landing_url)))
        }
        startActivity(Intent.createChooser(share, getString(R.string.invite_chooser)))
    }

    /**
     * Shows the one-time invite card the first time everything is backed up —
     * the natural "your photos are safe, tell a friend" moment — unless the user
     * has already dismissed or acted on it.
     */
    private fun maybeShowInviteCard() {
        inviteCard.visibility =
            if (prefs.inviteCardDismissed) View.GONE else View.VISIBLE
    }

    /** Permanently hides the invite card (dismissed or shared). */
    private fun dismissInviteCard() {
        prefs.inviteCardDismissed = true
        inviteCard.visibility = View.GONE
    }

    /**
     * Shows the "update available" banner from the cached latest.json, unless
     * this build is already current or the user dismissed this version. Renders
     * instantly (no network) so the banner is there the moment the app opens.
     */
    private fun renderUpdateBanner() {
        val update = UpdateChecker.appUpdateFrom(prefs.cachedLatest, BuildConfig.VERSION_CODE)
        if (update == null || prefs.dismissedUpdateVersionCode >= update.versionCode) {
            pendingUpdate = null
            updateBanner.visibility = View.GONE
            return
        }
        pendingUpdate = update
        updateVersionText.text = getString(R.string.update_banner_version, update.versionName)
        if (update.notes.isNotEmpty()) {
            updateNotesText.text = update.notes.joinToString("\n") { "•  $it" }
            updateNotesText.visibility = View.VISIBLE
        } else {
            updateNotesText.visibility = View.GONE
        }
        updateBanner.visibility = View.VISIBLE
    }

    /** Refreshes the cached latest.json at most every few hours, then re-renders. */
    private fun maybeRefreshUpdate() {
        val sixHours = 6 * 60 * 60 * 1000L
        val fresh = prefs.cachedLatest.isNotEmpty() &&
            System.currentTimeMillis() - prefs.lastUpdateCheckAt < sixHours
        if (fresh) return
        lifecycleScope.launch {
            val body = withContext(Dispatchers.IO) { UpdateChecker.fetch() } ?: return@launch
            prefs.cachedLatest = body
            prefs.lastUpdateCheckAt = System.currentTimeMillis()
            renderUpdateBanner()
        }
    }

    /** Opens an external link (download / release notes) in the browser. */
    private fun openUrl(url: String) {
        if (url.isEmpty()) return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, url, Toast.LENGTH_LONG).show()
        }
    }

    /** Hands the ordered media list to the viewer and opens it at [mediaIndex]. */
    private fun openViewer(mediaIndex: Int) {
        GalleryData.items = items
        startActivity(Intent(this, PhotoViewerActivity::class.java).apply {
            putExtra(PhotoViewerActivity.EXTRA_INDEX, mediaIndex)
        })
    }

    /** Re-scans MediaStore and the upload log, then rebuilds the grid. */
    private fun refresh() {
        lifecycleScope.launch {
            allItems = withContext(Dispatchers.IO) {
                MediaScanner.itemsForBackup(this@MainActivity, prefs)
                    .sortedByDescending { it.takenAtMs }
            }
            applyStatuses()
        }
    }

    /** Switches the bottom Photos/Videos filter and redraws. */
    private fun setVideosOnly(value: Boolean) {
        if (videosOnly == value) return
        videosOnly = value
        updateFilterUi()
        previewController.pause()
        applyStatuses()
        grid.scrollToPosition(0)
    }

    private fun updateFilterUi() {
        styleSegment(filterPhotos, !videosOnly)
        styleSegment(filterVideos, videosOnly)
    }

    private fun styleSegment(segment: TextView, selected: Boolean) {
        if (selected) {
            segment.setBackgroundResource(R.drawable.pill_selected)
            segment.setTextColor(ContextCompat.getColor(this, R.color.on_accent))
        } else {
            segment.setBackgroundColor(Color.TRANSPARENT)
            segment.setTextColor(ContextCompat.getColor(this, R.color.text_secondary))
        }
    }

    /** Applies the current filter, recomputes badges, and groups into sections. */
    private fun applyStatuses() {
        if (allItems.isEmpty() && !hasMediaPermission()) return
        lifecycleScope.launch {
            val uploaded = withContext(Dispatchers.IO) {
                UploadLog.get(this@MainActivity).uploadedIds()
            }
            val uploadingId = SyncEvents.uploadingItemId.value
            val shown = if (videosOnly) allItems.filter { it.isVideo } else allItems
            items = shown

            if (shown.isEmpty()) {
                emptyText.setText(if (videosOnly) R.string.no_videos else R.string.gallery_empty)
                emptyText.visibility = View.VISIBLE
            } else {
                emptyText.visibility = View.GONE
            }

            val entries = shown.map { item ->
                val status = when {
                    item.id == uploadingId -> SyncStatus.UPLOADING
                    item.id in uploaded -> SyncStatus.DONE
                    else -> SyncStatus.PENDING
                }
                GalleryEntry(item, status)
            }
            rows = withContext(Dispatchers.Default) { GallerySections.build(entries) }
            adapter.submitList(rows)
            // Surface the most-recent date immediately (the inline headers are
            // gone, so without this the pill wouldn't show until the user scrolls).
            rows.firstOrNull()?.sectionLabel?.let { flashDatePill(it) }

            val configured = prefs.username.isNotEmpty() && prefs.serverUrl.isNotEmpty()
            // Default hidden; only the "everything backed up" branch below re-shows it.
            inviteCard.visibility = View.GONE
            if (configured) {
                val doneCount = entries.count { it.status == SyncStatus.DONE }
                val total = entries.size
                if (doneCount >= total) {
                    // Everything is safe — headline number, no progress bar.
                    summaryText.text = getString(R.string.backed_up_all, doneCount)
                    summaryProgress.visibility = View.GONE
                    // The natural "tell a friend" moment (skip an empty library).
                    if (total > 0) maybeShowInviteCard()
                } else if (uploadingId == null && !serverReachable()) {
                    // Configured, but pictures aren't moving and the server can't
                    // be reached (mistyped URL, PC off, wrong WiFi). Say so —
                    // otherwise the bar silently sits and never advances. An
                    // active upload already proves reachability, so we only
                    // probe when nothing is uploading.
                    summaryText.text = getString(R.string.server_unreachable_summary)
                    summaryProgress.visibility = View.GONE
                } else {
                    // Uploads still pending — name how many are left (the count
                    // people actually want) and show progress against the total.
                    summaryText.text = getString(R.string.backed_up_pending, doneCount, total - doneCount)
                    summaryProgress.max = total
                    summaryProgress.progress = doneCount
                    summaryProgress.visibility = View.VISIBLE
                }
            } else {
                summaryText.text = getString(R.string.setup_not_backing_up)
                summaryProgress.visibility = View.GONE
            }
        }
    }

    /** True if the configured server answers a health probe (short timeout). */
    private suspend fun serverReachable(): Boolean = withContext(Dispatchers.IO) {
        ServerApi(prefs.serverUrl, prefs.apiKey).health() != null
    }

    /** Drives the date pill and the video preview together. */
    private val scrollListener = object : RecyclerView.OnScrollListener() {
        override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
            val pos = layoutManager.findFirstVisibleItemPosition()
            val label = rows.getOrNull(pos)?.sectionLabel ?: return
            flashDatePill(label)
        }

        override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
            if (newState == RecyclerView.SCROLL_STATE_IDLE) {
                previewController.update(recyclerView)
            } else {
                previewController.pause()
            }
        }
    }

    private fun hasMediaPermission(): Boolean {
        val perm = if (Build.VERSION.SDK_INT >= 33) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        return ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED
    }

    private fun ensureMediaPermission() {
        val needed = if (Build.VERSION.SDK_INT >= 33) {
            // POST_NOTIFICATIONS lets the backup show its ongoing progress
            // notification (the foreground sync service that keeps uploading
            // while the phone is locked).
            arrayOf(
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO,
                Manifest.permission.POST_NOTIFICATIONS,
            )
        } else {
            arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            permissionLauncher.launch(missing.toTypedArray())
        }
    }
}
