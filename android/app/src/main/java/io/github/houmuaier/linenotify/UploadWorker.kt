package io.github.houmuaier.linenotify

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Sends the queues to the server: exclusions, then messages, then images.
 * Runs when there is a network, and retries with backoff.
 */
class UploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val settings = Settings(applicationContext)
        val store = Store.get(applicationContext)
        val serverUrl = settings.serverUrl ?: return Result.success()
        if (settings.revoked) return Result.success()
        val token = settings.token ?: run {
            // The stored token cannot be read on this phone (restored data): pair again.
            settings.revoked = true
            return Result.success()
        }

        try {
            if (settings.exclusionsDirty) {
                Api.putExclusions(serverUrl, token, store.excludedEntries())
                settings.exclusionsDirty = false
            }
            while (true) {
                val batch = store.nextBatch(BATCH_SIZE)
                if (batch.isEmpty()) break
                Api.upload(serverUrl, token, batch)
                store.removeFromQueue(batch.map { it.rowId })
                settings.lastUploadAt = System.currentTimeMillis()
            }
            uploadMedia(store, settings, serverUrl, token)
            settings.lastError = null
            return Result.success()
        } catch (e: HttpStatusException) {
            if (e.status == 401) {
                // Another phone was paired, or this one was revoked. Stop until it is paired again.
                settings.revoked = true
                return Result.success()
            }
            settings.lastError = "HTTP ${e.status}"
            // A 4xx will not fix itself by retrying; a 5xx might.
            return if (e.status in 400..499) Result.failure() else Result.retry()
        } catch (e: Exception) {
            settings.lastError = e.javaClass.simpleName + (e.message?.let { ": $it" } ?: "")
            return Result.retry()
        }
    }

    /**
     * Uploads queued images one at a time. An image the server refuses, or a
     * sticker LINE's server will not hand out, is dropped with a note in
     * lastError rather than blocking the queue. Network failures propagate,
     * so the run is retried.
     */
    private fun uploadMedia(store: Store, settings: Settings, serverUrl: String, token: String) {
        while (true) {
            val batch = store.nextMedia(MEDIA_BATCH)
            if (batch.isEmpty()) return
            for (media in batch) {
                val content = try {
                    load(media)
                } catch (e: HttpStatusException) {
                    if (e.status in 400..499) null else throw e
                } catch (e: NotAnImage) {
                    null
                }
                if (content == null) {
                    settings.lastError = "画像を取得できなかったため送信をやめました（${media.kind}）"
                    finish(store, media)
                    continue
                }
                try {
                    Api.uploadMedia(serverUrl, token, media, content.mime, content.bytes)
                } catch (e: HttpStatusException) {
                    if (e.status == 401 || e.status !in 400..499) throw e
                    settings.lastError = "サーバーが画像を受け付けませんでした（HTTP ${e.status}）"
                }
                finish(store, media)
                settings.lastUploadAt = System.currentTimeMillis()
            }
        }
    }

    private class NotAnImage : IOException("not an image")

    private fun load(media: QueuedMedia): Downloaded? {
        media.filePath?.let { path ->
            val file = File(path)
            if (!file.exists()) return null
            return Downloaded(file.readBytes(), media.mime ?: "image/jpeg")
        }
        val url = media.sourceUrl ?: return null
        return try {
            Api.downloadImage(url)
        } catch (e: IOException) {
            if (e.message == "not an image" || e.message == "sticker too large") throw NotAnImage()
            throw e
        }
    }

    private fun finish(store: Store, media: QueuedMedia) {
        store.removeMedia(media.rowId)
        media.filePath?.let { File(it).delete() }
    }

    companion object {
        private const val BATCH_SIZE = 20
        private const val MEDIA_BATCH = 5
        private const val WORK_NAME = "upload"

        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<UploadWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            // Appended, not dropped, when a run is in progress: a message queued
            // just as that run finishes is still picked up by the next one.
            WorkManager.getInstance(context)
                .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        }
    }
}
