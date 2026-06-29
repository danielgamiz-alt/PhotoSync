package com.photosync.app

import android.content.ClipData
import com.photosync.app.BuildConfig
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.format.DateUtils
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.addCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Server connection + sync configuration (the gallery is the main screen).
 */
class SettingsActivity : AppCompatActivity() {

    private lateinit var prefs: SyncPrefs

    private lateinit var usernameInput: EditText
    private lateinit var serverUrlInput: EditText
    private lateinit var apiKeyInput: EditText
    private lateinit var connectionStatus: TextView
    private lateinit var connectionHelp: TextView
    private lateinit var connectionHelpButtons: View
    private lateinit var tryAgainButton: Button
    private lateinit var syncStatus: TextView
    private lateinit var autoSyncSwitch: SwitchCompat
    private lateinit var videosOnlySwitch: SwitchCompat
    private lateinit var backupSourceSummary: TextView

    private val statusRefresher = Handler(Looper.getMainLooper())
    private val refreshRunnable = object : Runnable {
        override fun run() {
            updateSyncStatus()
            statusRefresher.postDelayed(this, 3000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        prefs = SyncPrefs(this)

        usernameInput = findViewById(R.id.usernameInput)
        serverUrlInput = findViewById(R.id.serverUrlInput)
        apiKeyInput = findViewById(R.id.apiKeyInput)
        connectionStatus = findViewById(R.id.connectionStatus)
        connectionHelp = findViewById(R.id.connectionHelp)
        connectionHelpButtons = findViewById(R.id.connectionHelpButtons)
        tryAgainButton = findViewById(R.id.tryAgainButton)
        syncStatus = findViewById(R.id.syncStatus)
        autoSyncSwitch = findViewById(R.id.autoSyncSwitch)
        videosOnlySwitch = findViewById(R.id.videosOnlySwitch)
        backupSourceSummary = findViewById(R.id.backupSourceSummary)

        findViewById<Button>(R.id.backupSourceButton).setOnClickListener {
            startActivity(Intent(this, BackupSourceActivity::class.java))
        }

        findViewById<TextView>(R.id.helpLink).setOnClickListener {
            startActivity(Intent(this, HelpActivity::class.java))
        }

        findViewById<TextView>(R.id.appVersionText).text =
            getString(R.string.app_version, BuildConfig.VERSION_NAME)

        usernameInput.setText(prefs.username)
        serverUrlInput.setText(prefs.serverUrl)
        apiKeyInput.setText(prefs.apiKey)

        usernameInput.setOnFocusChangeListener { _, hasFocus ->
            if (!hasFocus) maybeConfirmUsername()
        }

        onBackPressedDispatcher.addCallback(this) {
            checkPendingUsername { finish() }
        }
        autoSyncSwitch.isChecked = prefs.autoSyncEnabled
        videosOnlySwitch.isChecked = prefs.videosOnly

        findViewById<Button>(R.id.discoverButton).setOnClickListener { discoverServers() }
        findViewById<Button>(R.id.testButton).setOnClickListener { testConnection() }
        findViewById<Button>(R.id.syncNowButton).setOnClickListener { syncNow() }
        tryAgainButton.setOnClickListener { discoverServers() }

        // "Set up the computer" instructions live inline (collapsed) rather than
        // on a separate screen. The toggle expands them; the no-server help
        // button expands the panel straight away.
        val setupComputerPanel = findViewById<View>(R.id.setupComputerPanel)
        findViewById<TextView>(R.id.setupUrlText).text = getString(R.string.landing_url)
        findViewById<View>(R.id.setupComputerToggle).setOnClickListener {
            setupComputerPanel.visibility =
                if (setupComputerPanel.visibility == View.GONE) View.VISIBLE else View.GONE
        }
        findViewById<View>(R.id.sendLinkButton).setOnClickListener { sendSetupLink() }
        findViewById<View>(R.id.copyLinkButton).setOnClickListener { copySetupLink() }
        findViewById<Button>(R.id.setupComputerButton).setOnClickListener {
            setupComputerPanel.visibility = View.VISIBLE
        }

        autoSyncSwitch.setOnCheckedChangeListener { _, checked ->
            prefs.autoSyncEnabled = checked
            saveServerSettings()
            if (checked) {
                SyncWorker.schedulePeriodic(this)
                Toast.makeText(this, R.string.auto_sync_on, Toast.LENGTH_SHORT).show()
            } else {
                SyncWorker.cancelPeriodic(this)
            }
        }

        videosOnlySwitch.setOnCheckedChangeListener { _, checked ->
            prefs.videosOnly = checked
        }
    }

    /** Share the landing-page link to yourself, to open on the computer. */
    private fun sendSetupLink() {
        val url = getString(R.string.landing_url)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, getString(R.string.invite_subject))
            putExtra(Intent.EXTRA_TEXT, getString(R.string.invite_text, url))
        }
        startActivity(Intent.createChooser(send, getString(R.string.setup_computer_send_chooser)))
    }

    /** Copy the landing-page link so it can be pasted on the computer. */
    private fun copySetupLink() {
        val url = getString(R.string.landing_url)
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("PhotoSync", url))
        Toast.makeText(this, R.string.setup_computer_link_copied, Toast.LENGTH_SHORT).show()
    }

    override fun onSupportNavigateUp(): Boolean {
        checkPendingUsername { finish() }
        return true
    }

    override fun onResume() {
        super.onResume()
        statusRefresher.post(refreshRunnable)
        updateBackupSummary()
    }

    private fun updateBackupSummary() {
        backupSourceSummary.text = when (prefs.backupMode) {
            SyncPrefs.MODE_ALL -> getString(R.string.backup_all_summary)
            SyncPrefs.MODE_CUSTOM -> resources.getQuantityString(
                R.plurals.backup_custom_summary,
                prefs.selectedFolderIds.size,
                prefs.selectedFolderIds.size,
            )
            else -> getString(R.string.backup_camera_summary)
        }
    }

    override fun onPause() {
        super.onPause()
        statusRefresher.removeCallbacks(refreshRunnable)
        saveServerSettings()
    }

    private fun saveServerSettings() {
        prefs.serverUrl = serverUrlInput.text.toString().trim()
        prefs.apiKey = apiKeyInput.text.toString().trim()
        saveAccount()
    }

    private fun saveAccount() {
        // Username is committed only through the confirmation dialog (maybeConfirmUsername).
        // Nothing to do here.
    }

    private fun maybeConfirmUsername() {
        val newName = usernameInput.text.toString().trim()
        if (newName == prefs.username) return
        AlertDialog.Builder(this)
            .setTitle(R.string.username_confirm_title)
            .setMessage(getString(R.string.username_confirm_message, newName))
            .setPositiveButton(R.string.username_confirm_save) { _, _ ->
                prefs.username = newName
                UploadLog.get(this).clear()
                SyncEvents.notifyChanged()
            }
            .setNegativeButton(R.string.username_confirm_cancel) { _, _ ->
                usernameInput.setText(prefs.username)
            }
            .show()
    }

    private fun checkPendingUsername(onReady: () -> Unit) {
        val newName = usernameInput.text.toString().trim()
        if (newName == prefs.username) {
            onReady()
            return
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.username_confirm_title)
            .setMessage(getString(R.string.username_confirm_message, newName))
            .setPositiveButton(R.string.username_confirm_save) { _, _ ->
                prefs.username = newName
                UploadLog.get(this).clear()
                SyncEvents.notifyChanged()
                onReady()
            }
            .setNegativeButton(R.string.username_confirm_cancel) { _, _ ->
                usernameInput.setText(prefs.username)
                onReady()
            }
            .show()
    }

    private fun discoverServers() {
        connectionStatus.setText(R.string.searching)
        hideConnectionHelp()
        lifecycleScope.launch {
            val servers = withContext(Dispatchers.IO) { ServerDiscovery.discover(this@SettingsActivity) }
            if (servers.isEmpty()) {
                connectionStatus.setText(R.string.no_servers_found)
                showConnectionHelp()
                return@launch
            }
            if (servers.size == 1) {
                applyServer(servers[0])
                return@launch
            }
            val labels = servers.map { "${it.name} (${it.address})" }.toTypedArray()
            AlertDialog.Builder(this@SettingsActivity)
                .setTitle(R.string.pick_server)
                .setItems(labels) { _, which -> applyServer(servers[which]) }
                .show()
        }
    }

    private fun showConnectionHelp() {
        connectionHelp.visibility = View.VISIBLE
        connectionHelpButtons.visibility = View.VISIBLE
        // Keep the URL field focused so the user can type the address from
        // the PC app's Settings without an extra tap.
        serverUrlInput.requestFocus()
    }

    private fun hideConnectionHelp() {
        connectionHelp.visibility = View.GONE
        connectionHelpButtons.visibility = View.GONE
    }

    private fun applyServer(server: DiscoveredServer) {
        hideConnectionHelp()
        serverUrlInput.setText(server.baseUrl)
        prefs.serverUrl = server.baseUrl
        prefs.serverName = server.name
        connectionStatus.text = getString(R.string.found_server, server.name, server.address)
        if (server.requiresApiKey && prefs.apiKey.isEmpty()) {
            Toast.makeText(this, R.string.api_key_required, Toast.LENGTH_LONG).show()
        }
    }

    private fun testConnection() {
        saveServerSettings()
        if (prefs.serverUrl.isEmpty()) {
            connectionStatus.setText(R.string.enter_url_first)
            return
        }
        connectionStatus.setText(R.string.testing)
        lifecycleScope.launch {
            val health = withContext(Dispatchers.IO) {
                ServerApi(prefs.serverUrl, prefs.apiKey).health()
            }
            connectionStatus.text = if (health != null) {
                getString(R.string.server_online, health.name, health.fileCount)
            } else {
                getString(R.string.server_unreachable)
            }
        }
    }

    private fun syncNow() {
        saveServerSettings()
        if (prefs.serverUrl.isEmpty()) {
            Toast.makeText(this, R.string.enter_url_first, Toast.LENGTH_SHORT).show()
            return
        }
        if (prefs.username.isEmpty()) {
            Toast.makeText(this, R.string.set_name_first, Toast.LENGTH_SHORT).show()
            usernameInput.requestFocus()
            return
        }
        SyncWorker.enqueueOneTime(this)
        Toast.makeText(this, R.string.sync_queued, Toast.LENGTH_SHORT).show()
    }

    private fun updateSyncStatus() {
        val status = prefs.lastSyncStatus.ifEmpty { getString(R.string.never_synced) }
        val whenText = if (prefs.lastSyncTime > 0) {
            DateUtils.getRelativeTimeSpanString(prefs.lastSyncTime).toString()
        } else {
            ""
        }
        syncStatus.text = buildString {
            append(status)
            if (whenText.isNotEmpty()) append("\n").append(getString(R.string.last_sync, whenText))
            append("\n").append(getString(R.string.total_uploaded, prefs.totalUploaded))
        }
    }
}
