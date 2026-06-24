package com.photosync.app

import android.os.Bundle
import android.view.View
import android.widget.RadioGroup
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Lets the user choose what to back up: the camera roll (default), the entire
 * gallery, or hand-picked folders (each shown with a cover thumbnail + count).
 */
class BackupSourceActivity : AppCompatActivity() {

    private lateinit var prefs: SyncPrefs
    private lateinit var modeGroup: RadioGroup
    private lateinit var folderAdapter: FolderAdapter
    private lateinit var foldersHint: TextView
    private lateinit var foldersEmpty: TextView

    private val selected = mutableSetOf<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_backup_source)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        title = getString(R.string.backup_source_title)
        prefs = SyncPrefs(this)

        modeGroup = findViewById(R.id.modeGroup)
        foldersHint = findViewById(R.id.foldersHint)
        foldersEmpty = findViewById(R.id.foldersEmpty)
        selected += prefs.selectedFolderIds

        modeGroup.check(
            when (prefs.backupMode) {
                SyncPrefs.MODE_ALL -> R.id.modeAll
                SyncPrefs.MODE_CUSTOM -> R.id.modeCustom
                else -> R.id.modeCamera
            }
        )

        folderAdapter = FolderAdapter(selected) { _, _ ->
            // Picking a folder implies "Selected folders" mode.
            if (modeGroup.checkedRadioButtonId != R.id.modeCustom) {
                modeGroup.check(R.id.modeCustom)
            }
        }
        findViewById<RecyclerView>(R.id.folderList).apply {
            layoutManager = LinearLayoutManager(this@BackupSourceActivity)
            adapter = folderAdapter
        }

        modeGroup.setOnCheckedChangeListener { _, _ -> updateFoldersEnabled() }

        loadFolders()
    }

    private fun updateFoldersEnabled() {
        val custom = modeGroup.checkedRadioButtonId == R.id.modeCustom
        foldersHint.setText(
            if (custom) R.string.folders_pick_hint else R.string.folders_reference_hint
        )
        folderAdapter.setEnabled(custom)
    }

    private fun loadFolders() {
        lifecycleScope.launch {
            val folders = withContext(Dispatchers.IO) {
                MediaScanner.listFolders(this@BackupSourceActivity, prefs.includeVideos || prefs.videosOnly)
            }
            foldersEmpty.visibility = if (folders.isEmpty()) View.VISIBLE else View.GONE
            folderAdapter.submit(folders)
            updateFoldersEnabled()
        }
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }

    override fun onPause() {
        super.onPause()
        // Persist the choice when leaving the screen.
        prefs.backupMode = when (modeGroup.checkedRadioButtonId) {
            R.id.modeAll -> SyncPrefs.MODE_ALL
            R.id.modeCustom -> SyncPrefs.MODE_CUSTOM
            else -> SyncPrefs.MODE_CAMERA
        }
        prefs.selectedFolderIds = selected.toSet()
    }
}
