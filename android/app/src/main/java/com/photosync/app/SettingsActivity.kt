package com.photosync.app

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.format.DateUtils
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
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
    private lateinit var syncStatus: TextView
    private lateinit var autoSyncSwitch: SwitchCompat
    private lateinit var videosSwitch: SwitchCompat
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
        syncStatus = findViewById(R.id.syncStatus)
        autoSyncSwitch = findViewById(R.id.autoSyncSwitch)
        videosSwitch = findViewById(R.id.videosSwitch)
        videosOnlySwitch = findViewById(R.id.videosOnlySwitch)
        backupSourceSummary = findViewById(R.id.backupSourceSummary)

        findViewById<Button>(R.id.backupSourceButton).setOnClickListener {
            startActivity(Intent(this, BackupSourceActivity::class.java))
        }

        usernameInput.setText(prefs.username)
        serverUrlInput.setText(prefs.serverUrl)
        apiKeyInput.setText(prefs.apiKey)
        autoSyncSwitch.isChecked = prefs.autoSyncEnabled
        videosSwitch.isChecked = prefs.includeVideos
        videosOnlySwitch.isChecked = prefs.videosOnly
        updateVideoSwitchState()

        findViewById<Button>(R.id.discoverButton).setOnClickListener { discoverServers() }
        findViewById<Button>(R.id.testButton).setOnClickListener { testConnection() }
        findViewById<Button>(R.id.syncNowButton).setOnClickListener { syncNow() }

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

        videosSwitch.setOnCheckedChangeListener { _, checked -> prefs.includeVideos = checked }

        videosOnlySwitch.setOnCheckedChangeListener { _, checked ->
            prefs.videosOnly = checked
            updateVideoSwitchState()
        }
    }

    /** "Include videos" is moot while backing up videos only, so lock it on. */
    private fun updateVideoSwitchState() {
        videosSwitch.isEnabled = !prefs.videosOnly
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
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

    /**
     * Persists the account name. Switching accounts forgets the local
     * backup log, since "uploaded" is tracked per server folder — the new
     * account's folder starts empty, so everything is pending again.
     */
    private fun saveAccount() {
        val newName = usernameInput.text.toString().trim()
        if (newName != prefs.username) {
            prefs.username = newName
            UploadLog.get(this).clear()
            SyncEvents.notifyChanged()
        }
    }

    private fun discoverServers() {
        connectionStatus.setText(R.string.searching)
        lifecycleScope.launch {
            val servers = withContext(Dispatchers.IO) { ServerDiscovery.discover(this@SettingsActivity) }
            if (servers.isEmpty()) {
                connectionStatus.setText(R.string.no_servers_found)
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

    private fun applyServer(server: DiscoveredServer) {
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
