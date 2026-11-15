package io.github.houmuaier.linenotify

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Receives photos shared from LINE (or any app), asks which chat they belong
 * to, shrinks them and queues them for upload. Only images: videos are out of scope.
 */
class ShareActivity : Activity() {
    private val background = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var chats: List<Chat>
    private lateinit var images: List<Uri>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_share)

        val settings = Settings(this)
        val status = findViewById<TextView>(R.id.share_status)
        val send = findViewById<Button>(R.id.share_send)
        findViewById<Button>(R.id.share_cancel).setOnClickListener { finish() }
        send.visibility = View.GONE

        if (!settings.isPaired || settings.revoked) {
            status.setText(R.string.share_not_paired)
            return
        }
        status.setText(R.string.share_checking)
        val shared = sharedUris(intent)
        background.execute {
            // Reading the files to tell images apart can take a moment; the
            // permission to read them lasts as long as this activity.
            val found = shared.filter(::isImage)
            val store = Store.get(this)
            store.addDiagnostic(describeShare(intent, shared, found.size))
            val list = store.includedChats(CHAT_CHOICES)
            main.post {
                images = found
                if (found.isEmpty()) {
                    status.text = getString(R.string.share_no_images, intent.type ?: "?")
                    return@post
                }
                status.text = getString(R.string.share_count, found.size)
                showChats(list)
                send.visibility = View.VISIBLE
                send.setOnClickListener { submit() }
            }
        }
    }

    private fun sharedUris(intent: Intent): List<Uri> {
        @Suppress("DEPRECATION")
        return when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
            else -> emptyList()
        }
    }

    /** Decides by the file's first bytes, since the declared type may be generic or absent. Videos are left out. */
    private fun isImage(uri: Uri): Boolean = try {
        contentResolver.openInputStream(uri)?.use { input ->
            val head = ByteArray(16)
            val n = input.read(head)
            n > 0 && imageKind(head.copyOf(n)) != null
        } ?: false
    } catch (e: Exception) {
        false
    }

    /** Structure only, for the diagnostics panel: what was shared and with which declared types. */
    private fun describeShare(intent: Intent, uris: List<Uri>, images: Int): String = buildString {
        append("== share ").append(java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.ROOT).format(java.util.Date())).append('\n')
        append("action=").append(intent.action).append(" intentType=").append(intent.type)
            .append(" items=").append(uris.size).append(" images=").append(images).append('\n')
        uris.forEach { uri ->
            append("  ").append(uri.scheme).append("://").append(uri.authority)
                .append(" type=").append(runCatching { contentResolver.getType(uri) }.getOrNull()).append('\n')
        }
    }

    private fun showChats(list: List<Chat>) {
        chats = list
        val group = findViewById<RadioGroup>(R.id.share_chats)
        list.forEachIndexed { index, chat ->
            group.addView(RadioButton(this).apply {
                id = View.generateViewId()
                tag = index
                text = chat.name
                minHeight = (48 * resources.displayMetrics.density).toInt()
            })
        }
        group.addView(RadioButton(this).apply {
            id = View.generateViewId()
            tag = OTHER
            setText(R.string.share_other_chat)
            minHeight = (48 * resources.displayMetrics.density).toInt()
        })
        // The chat a notification came from most recently is the likeliest source.
        (group.getChildAt(0) as RadioButton).isChecked = true
        val other = findViewById<EditText>(R.id.share_other_name)
        group.setOnCheckedChangeListener { g, checkedId ->
            other.visibility = if (g.findViewById<View>(checkedId)?.tag == OTHER) View.VISIBLE else View.GONE
        }
        if (list.isEmpty()) other.visibility = View.VISIBLE
    }

    private fun selectedChat(): Chat? {
        val group = findViewById<RadioGroup>(R.id.share_chats)
        val tag = group.findViewById<View>(group.checkedRadioButtonId)?.tag
        if (tag is Int) return chats[tag]
        val name = findViewById<EditText>(R.id.share_other_name).text.toString().trim()
        if (name.isEmpty()) return null
        return Chat(key = chatKeyOf(null, name), chatId = null, name = name, excluded = false, isGroup = false)
    }

    private fun submit() {
        val chat = selectedChat()
        val status = findViewById<TextView>(R.id.share_status)
        if (chat == null) {
            status.setText(R.string.share_pick_chat)
            return
        }
        findViewById<Button>(R.id.share_send).isEnabled = false
        status.setText(R.string.share_preparing)
        background.execute {
            val store = Store.get(this)
            if (store.isExcluded(chat.name, chat.chatId)) {
                main.post { done(getString(R.string.share_excluded)) }
                return@execute
            }
            var queued = 0
            var failed = 0
            for (uri in images) {
                try {
                    if (queuePhoto(store, chat, uri)) queued++
                } catch (e: Exception) {
                    failed++
                }
            }
            if (queued > 0) UploadWorker.enqueue(this)
            val message = if (failed == 0) getString(R.string.share_queued, queued)
            else getString(R.string.share_queued_with_failures, queued, failed)
            main.post { done(message) }
        }
    }

    /** Decodes, shrinks to [MAX_EDGE] on the long side, saves as JPEG and queues it. */
    private fun queuePhoto(store: Store, chat: Chat, uri: Uri): Boolean {
        val source = ImageDecoder.createSource(contentResolver, uri)
        val bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
            val w = info.size.width
            val h = info.size.height
            val scale = minOf(1.0, MAX_EDGE.toDouble() / maxOf(w, h))
            decoder.setTargetSize(maxOf(1, (w * scale).toInt()), maxOf(1, (h * scale).toInt()))
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        val jpeg = ByteArrayOutputStream().use { out ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
            out.toByteArray()
        }
        val width = bitmap.width
        val height = bitmap.height
        bitmap.recycle()

        val dir = File(filesDir, "outbox").apply { mkdirs() }
        val file = File(dir, "${UUID.randomUUID()}.jpg")
        file.writeBytes(jpeg)
        // The same photo shared twice to the same chat is stored once.
        val dedupKey = "photo:" + sha256Hex(chat.key.toByteArray() + jpeg)
        val added = store.queuePhoto(dedupKey, chat, file.path, "image/jpeg", width, height, System.currentTimeMillis())
        if (!added) file.delete()
        return added
    }

    private fun done(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        finish()
    }

    private companion object {
        const val CHAT_CHOICES = 12
        const val OTHER = "other"
        // Claude reads images up to about this size on the long side; larger only costs bytes.
        const val MAX_EDGE = 1568
        const val JPEG_QUALITY = 85
    }
}
