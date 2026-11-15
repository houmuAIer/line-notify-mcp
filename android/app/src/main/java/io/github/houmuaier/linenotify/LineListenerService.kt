package io.github.houmuaier.linenotify

import android.content.ComponentName
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.util.concurrent.Executors

/** Reads LINE's notifications as they are posted and queues their messages for upload. */
class LineListenerService : NotificationListenerService() {
    private val worker = Executors.newSingleThreadExecutor()

    override fun onListenerConnected() {
        // Catch up on what arrived while the listener was not running.
        val active = try {
            activeNotifications ?: return
        } catch (e: SecurityException) {
            return
        }
        active.forEach(::handle)
    }

    override fun onListenerDisconnected() {
        requestRebind(ComponentName(this, LineListenerService::class.java))
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) = handle(sbn)

    private fun handle(sbn: StatusBarNotification) {
        if (sbn.packageName != Extractor.LINE_PACKAGE) return
        val fields = Extractor.fieldsOf(sbn.notification, sbn.postTime)
        worker.execute {
            val settings = Settings(applicationContext)
            if (!settings.isPaired) return@execute
            val store = Store.get(applicationContext)
            val queued = Extractor.extract(fields).count { store.capture(it) }
            if (queued > 0 && !settings.revoked) UploadWorker.enqueue(applicationContext)
        }
    }
}
