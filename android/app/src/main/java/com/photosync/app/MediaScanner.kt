package com.photosync.app

import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import java.io.InputStream
import java.security.MessageDigest
import java.util.Locale

data class MediaItem(
    val id: Long,
    val uri: Uri,
    val displayName: String,
    val sizeBytes: Long,
    val dateAddedSec: Long,
    /** Best-known capture time in epoch ms (DATE_TAKEN, falling back to DATE_ADDED). */
    val takenAtMs: Long,
    val isVideo: Boolean,
    /** Video length in ms (0 for photos). */
    val durationMs: Long = 0,
    /** MediaStore bucket (folder) id this item lives in. */
    val bucketId: String = "",
    /** Human folder name, e.g. "Camera", "Screenshots". */
    val bucketName: String = "",
    /** True if the item lives in the device camera folder (DCIM). */
    val isCameraRoll: Boolean = false,
)

/** A device folder (MediaStore bucket) with a cover thumbnail and item count. */
data class MediaFolder(
    val bucketId: String,
    val name: String,
    val count: Int,
    val coverUri: Uri,
    val isCameraRoll: Boolean,
)

/**
 * Lists the device's photos/videos from MediaStore, newest first, and groups
 * them into folders. The set actually backed up is decided by the user's
 * chosen source (see [itemsForBackup] and [SyncPrefs.backupMode]).
 */
object MediaScanner {

    fun allItems(context: Context, includeVideos: Boolean): List<MediaItem> {
        val items = mutableListOf<MediaItem>()
        items += query(context, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, isVideo = false)
        if (includeVideos) {
            items += query(context, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, isVideo = true)
        }
        items.sortByDescending { it.dateAddedSec }
        return items
    }

    /**
     * The items to show / back up given the chosen source: the camera roll
     * (default), the whole gallery, or hand-picked folders.
     */
    fun itemsForBackup(context: Context, prefs: SyncPrefs): List<MediaItem> {
        // Videos-only backup still needs videos fetched even if "Include videos" is off.
        val all = allItems(context, prefs.includeVideos || prefs.videosOnly)
        val fromSource = when (prefs.backupMode) {
            SyncPrefs.MODE_ALL -> all
            SyncPrefs.MODE_CUSTOM -> {
                val selected = prefs.selectedFolderIds
                all.filter { it.bucketId in selected }
            }
            else -> all.filter { it.isCameraRoll } // MODE_CAMERA
        }
        return if (prefs.videosOnly) fromSource.filter { it.isVideo } else fromSource
    }

    /** All device folders, camera roll first, then alphabetical. */
    fun listFolders(context: Context, includeVideos: Boolean): List<MediaFolder> {
        val byBucket = LinkedHashMap<String, MutableList<MediaItem>>()
        for (item in allItems(context, includeVideos)) {
            byBucket.getOrPut(item.bucketId) { mutableListOf() }.add(item)
        }
        return byBucket.map { (bucketId, items) ->
            MediaFolder(
                bucketId = bucketId,
                name = items.first().bucketName.ifEmpty { "Unknown folder" },
                count = items.size,
                coverUri = items.first().uri, // newest item (list is date-desc)
                isCameraRoll = items.any { it.isCameraRoll },
            )
        }.sortedWith(
            compareByDescending<MediaFolder> { it.isCameraRoll }.thenBy { it.name.lowercase(Locale.ROOT) }
        )
    }

    @Suppress("DEPRECATION") // MediaColumns.DATA: deprecated but the most portable
    private fun query(context: Context, collection: Uri, isVideo: Boolean): List<MediaItem> {
        val projection = buildList {
            add(MediaStore.MediaColumns._ID)
            add(MediaStore.MediaColumns.DISPLAY_NAME)
            add(MediaStore.MediaColumns.SIZE)
            add(MediaStore.MediaColumns.DATE_ADDED)
            add(MediaStore.MediaColumns.DATE_TAKEN)
            // BUCKET_* have existed in ImageColumns/VideoColumns since API 1.
            add(MediaStore.Images.Media.BUCKET_ID)
            add(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)
            add(MediaStore.MediaColumns.DATA)
            // DURATION lives in VideoColumns and is valid back to API 26.
            if (isVideo) add(MediaStore.Video.Media.DURATION)
        }.toTypedArray()

        val result = mutableListOf<MediaItem>()
        context.contentResolver.query(
            collection,
            projection,
            null,
            null,
            "${MediaStore.MediaColumns.DATE_ADDED} DESC",
        )?.use { cursor ->
            val idCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
            val nameCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
            val sizeCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
            val addedCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_ADDED)
            val takenCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_TAKEN)
            val bucketIdCol = cursor.getColumnIndex(MediaStore.Images.Media.BUCKET_ID)
            val bucketNameCol = cursor.getColumnIndex(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)
            val dataCol = cursor.getColumnIndex(MediaStore.MediaColumns.DATA)
            val durationCol = if (isVideo) {
                cursor.getColumnIndex(MediaStore.Video.Media.DURATION)
            } else {
                -1
            }

            while (cursor.moveToNext()) {
                val id = cursor.getLong(idCol)
                val dateAdded = cursor.getLong(addedCol)
                val dateTaken = cursor.getLong(takenCol)
                val bucketName = if (bucketNameCol >= 0) cursor.getString(bucketNameCol) ?: "" else ""
                val data = if (dataCol >= 0) cursor.getString(dataCol) else null
                result += MediaItem(
                    id = id,
                    uri = Uri.withAppendedPath(collection, id.toString()),
                    displayName = cursor.getString(nameCol) ?: "unnamed",
                    sizeBytes = cursor.getLong(sizeCol),
                    dateAddedSec = dateAdded,
                    takenAtMs = if (dateTaken > 0) dateTaken else dateAdded * 1000,
                    isVideo = isVideo,
                    durationMs = if (durationCol >= 0) cursor.getLong(durationCol) else 0,
                    bucketId = if (bucketIdCol >= 0) cursor.getString(bucketIdCol) ?: "" else "",
                    bucketName = bucketName,
                    isCameraRoll = isCameraRoll(bucketName, data),
                )
            }
        }
        return result
    }

    /**
     * Camera roll = the standard "Camera" folder, or anything under a DCIM
     * path. We check the folder name first (works even when the raw file path
     * is unavailable) and fall back to the path.
     */
    private fun isCameraRoll(bucketName: String, data: String?): Boolean {
        if (bucketName.equals("Camera", ignoreCase = true)) return true
        val path = data?.lowercase(Locale.ROOT) ?: return false
        return path.contains("/dcim/")
    }

    /** Streams the item's content and returns its sha256 as lowercase hex. */
    fun sha256(context: Context, item: MediaItem): String? {
        val stream: InputStream = context.contentResolver.openInputStream(item.uri) ?: return null
        val digest = MessageDigest.getInstance("SHA-256")
        stream.use {
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = it.read(buf)
                if (n < 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { b -> "%02x".format(b) }
    }
}

/** Formats a video length like Google Photos: "0:42", "12:05", "1:03:20". */
fun formatVideoDuration(durationMs: Long): String {
    val totalSeconds = (durationMs / 1000).coerceAtLeast(0)
    val hours = totalSeconds / 3600
    val minutes = (totalSeconds % 3600) / 60
    val seconds = totalSeconds % 60
    return if (hours > 0) {
        String.format(Locale.getDefault(), "%d:%02d:%02d", hours, minutes, seconds)
    } else {
        String.format(Locale.getDefault(), "%d:%02d", minutes, seconds)
    }
}
