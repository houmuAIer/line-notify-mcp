package io.github.houmuaier.linenotify

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings as SystemSettings
import android.text.format.DateFormat
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import java.net.URL
import java.util.Date
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val background = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var settings: Settings
    private lateinit var store: Store

    private val refresher = object : Runnable {
        override fun run() {
            refresh()
            main.postDelayed(this, 3000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        settings = Settings(this)
        store = Store.get(this)

        findViewById<Button>(R.id.pair_button).setOnClickListener { pair() }
        findViewById<Button>(R.id.notification_access_button).setOnClickListener { openNotificationAccess() }
        findViewById<Button>(R.id.battery_button).setOnClickListener { openBatterySettings() }
        findViewById<Button>(R.id.app_info_button).setOnClickListener {
            startActivity(Intent(SystemSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }
        findViewById<Button>(R.id.send_now_button).setOnClickListener { UploadWorker.enqueue(this) }
        findViewById<Button>(R.id.exclude_button).setOnClickListener {
            val input = findViewById<EditText>(R.id.exclude_input)
            val name = input.text.toString().trim()
            if (name.isNotEmpty()) {
                input.text.clear()
                setExcluded(name, true)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        main.post(refresher)
    }

    override fun onPause() {
        super.onPause()
        main.removeCallbacks(refresher)
    }

    // ------------------------------------------------------------ pairing

    private fun pair() {
        val message = findViewById<TextView>(R.id.pairing_message)
        val input = findViewById<EditText>(R.id.pairing_input)
        val pairing = PairingString.parse(input.text.toString())
        if (pairing == null) {
            message.setText(R.string.pairing_bad_format)
            return
        }
        message.setText(R.string.pairing_in_progress)
        background.execute {
            val text = try {
                val result = Api.pair(pairing, "${Build.MANUFACTURER} ${Build.MODEL}")
                settings.savePairing(pairing.serverUrl, result.token)
                // The server's list is what the previous phone had excluded.
                result.exclusions.forEach { store.setExcluded(it, true) }
                // Anything excluded here before pairing goes up with the next upload.
                settings.exclusionsDirty = true
                UploadWorker.enqueue(this)
                getString(R.string.pairing_done)
            } catch (e: HttpStatusException) {
                if (e.status == 400) getString(R.string.pairing_bad_code)
                else getString(R.string.pairing_failed, "HTTP ${e.status}")
            } catch (e: Exception) {
                getString(R.string.pairing_failed, e.message ?: e.javaClass.simpleName)
            }
            main.post {
                message.text = text
                if (text == getString(R.string.pairing_done)) input.text.clear()
                refresh()
            }
        }
    }

    // ----------------------------------------------------------- settings

    private fun listenerComponent() = ComponentName(this, LineListenerService::class.java)

    private fun hasNotificationAccess(): Boolean {
        val enabled = SystemSettings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        return enabled.split(":").any { ComponentName.unflattenFromString(it) == listenerComponent() }
    }

    private fun openNotificationAccess() {
        val detail = Intent(SystemSettings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
            .putExtra(SystemSettings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, listenerComponent().flattenToString())
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) startActivity(detail)
            else startActivity(Intent(SystemSettings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        } catch (e: Exception) {
            startActivity(Intent(SystemSettings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
    }

    private fun ignoresBatteryOptimizations(): Boolean =
        getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

    private fun openBatterySettings() {
        try {
            if (ignoresBatteryOptimizations()) {
                startActivity(Intent(SystemSettings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } else {
                startActivity(
                    Intent(SystemSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                )
            }
        } catch (e: Exception) {
            startActivity(Intent(SystemSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }
    }

    // -------------------------------------------------------------- chats

    private fun setExcluded(chat: String, excluded: Boolean) {
        background.execute {
            store.setExcluded(chat, excluded)
            settings.exclusionsDirty = true
            if (settings.isPaired) UploadWorker.enqueue(this)
            main.post { refresh() }
        }
    }

    // ------------------------------------------------------------ display

    private fun formatTime(epochMs: Long): String =
        if (epochMs <= 0) getString(R.string.none) else DateFormat.format("yyyy-MM-dd HH:mm", Date(epochMs)).toString()

    private fun refresh() {
        background.execute {
            val queue = store.queueSize()
            val chats = store.chats()
            val recent = store.recent()
            val paired = settings.isPaired
            val revoked = settings.revoked
            val host = settings.serverUrl?.let { runCatching { URL(it).host }.getOrNull() } ?: ""
            val lastUpload = settings.lastUploadAt
            val lastError = settings.lastError
            main.post {
                if (isFinishing || isDestroyed) return@post
                findViewById<TextView>(R.id.connection_status).text = when {
                    !paired -> getString(R.string.status_unpaired)
                    revoked -> getString(R.string.status_revoked)
                    else -> getString(R.string.status_paired, host)
                }
                findViewById<TextView>(R.id.notification_access_status).setText(
                    if (hasNotificationAccess()) R.string.notification_access_on else R.string.notification_access_off
                )
                findViewById<TextView>(R.id.battery_status).setText(
                    if (ignoresBatteryOptimizations()) R.string.battery_ok else R.string.battery_not_ok
                )
                findViewById<TextView>(R.id.upload_status).text =
                    getString(R.string.upload_status, queue, formatTime(lastUpload), lastError ?: getString(R.string.none))
                findViewById<TextView>(R.id.recent_list).text =
                    if (recent.isEmpty()) getString(R.string.no_recent)
                    else recent.joinToString("\n\n") {
                        getString(R.string.recent_line, formatTime(it.sentAt), it.chat, it.sender, it.body.take(60))
                    }
                showChats(chats)
            }
        }
    }

    private var shownChats: List<Chat>? = null

    private fun showChats(chats: List<Chat>) {
        if (chats == shownChats) return // rebuilding would reset a switch mid-tap
        shownChats = chats
        val list = findViewById<LinearLayout>(R.id.chat_list)
        list.removeAllViews()
        if (chats.isEmpty()) {
            list.addView(TextView(this).apply { setText(R.string.no_chats) })
            return
        }
        for (chat in chats) {
            list.addView(
                Switch(this).apply {
                    text = chat.name
                    isChecked = !chat.excluded
                    minHeight = (48 * resources.displayMetrics.density).toInt()
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
                    )
                    setOnCheckedChangeListener { _, checked -> setExcluded(chat.name, !checked) }
                }
            )
        }
    }
}
