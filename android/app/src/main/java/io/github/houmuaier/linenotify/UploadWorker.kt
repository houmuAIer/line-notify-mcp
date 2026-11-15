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
import java.util.concurrent.TimeUnit

/** Sends the queue to the server. Runs when there is a network, and retries with backoff. */
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
                Api.putExclusions(serverUrl, token, store.excludedChats())
                settings.exclusionsDirty = false
            }
            while (true) {
                val batch = store.nextBatch(BATCH_SIZE)
                if (batch.isEmpty()) break
                Api.upload(serverUrl, token, batch.map { it.message })
                store.removeFromQueue(batch.map { it.rowId })
                settings.lastUploadAt = System.currentTimeMillis()
            }
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

    companion object {
        private const val BATCH_SIZE = 20
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
