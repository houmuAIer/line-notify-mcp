package io.github.houmuaier.linenotify

import android.app.Notification
import android.os.Bundle
import android.os.Parcelable
import java.security.MessageDigest

/** One message read out of a notification. */
data class Captured(
    val chat: String,
    val sender: String,
    val body: String,
    val isGroup: Boolean,
    val sentAt: Long,
    /** LINE's own ids, when the notification carries them. */
    val chatId: String? = null,
    val messageId: String? = null,
    val stickerId: String? = null,
    val stickerUrl: String? = null,
) {
    /**
     * Identifies the message across re-posts of the same notification, and on
     * the server: LINE's message id when there is one, else a hash of the content.
     */
    val dedupKey: String by lazy {
        messageId?.let { "line:$it" } ?: sha256Hex("$chat\u0000$sender\u0000$sentAt\u0000$body")
    }

    /** The key a chat is known by on this phone: LINE's chat id, else its name. */
    val chatKey: String get() = chatKeyOf(chatId, chat)
}

fun chatKeyOf(chatId: String?, name: String): String = chatId ?: "name:$name"

fun sha256Hex(text: String): String = sha256Hex(text.toByteArray(Charsets.UTF_8))

fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/** The notification fields the extractor reads, separated from Android classes so it can be unit tested. */
data class NotificationFields(
    val isGroupSummary: Boolean,
    val category: String?,
    val title: String?,
    val text: String?,
    val bigText: String?,
    val conversationTitle: String?,
    val isGroupConversation: Boolean,
    val selfName: String?,
    val messages: List<StyleMessage>,
    val time: Long,
    val chatId: String? = null,
    /** The id of the newest message in the notification. */
    val messageId: String? = null,
    /** Set when the newest message is a sticker. */
    val stickerId: String? = null,
    val stickerUrl: String? = null,
)

data class StyleMessage(val text: String?, val senderName: String?, val time: Long, val messageId: String? = null)

object Extractor {
    const val LINE_PACKAGE = "jp.naver.line.android"

    // Extras LINE adds to its notifications (seen in LINE for Android, November 2026).
    private const val KEY_CHAT_ID = "line.chat.id"
    private const val KEY_MESSAGE_ID = "line.message.id"
    private const val KEY_STICKER_ID = "line.sticker.id"
    private const val KEY_STICKER_URL = "line.sticker.url"
    private const val KEY_STYLE_MESSAGE_ID = "MESSAGE_ID"
    private const val SELF_FALLBACK = "自分"

    fun extract(fields: NotificationFields): List<Captured> {
        // The summary only repeats what the per-chat notifications carry; calls have no message text.
        if (fields.isGroupSummary) return emptyList()
        if (fields.category == Notification.CATEGORY_CALL) return emptyList()

        val title = fields.title?.trim()?.takeIf { it.isNotEmpty() }
        val conversation = fields.conversationTitle?.trim()?.takeIf { it.isNotEmpty() }

        if (fields.messages.isNotEmpty()) {
            val firstSender = fields.messages.firstNotNullOfOrNull { it.senderName?.trim()?.takeIf(String::isNotEmpty) }
            val chat = conversation ?: title ?: firstSender ?: return emptyList()
            val isGroup = fields.isGroupConversation || (conversation != null && conversation != firstSender)
            val newest = fields.messages.lastIndex
            return fields.messages.mapIndexedNotNull { index, message ->
                val body = message.text?.takeIf { it.isNotBlank() } ?: return@mapIndexedNotNull null
                // A message without a sender is the user's own, sent from the notification's reply box.
                val sender = message.senderName?.trim()?.takeIf { it.isNotEmpty() }
                    ?: fields.selfName?.trim()?.takeIf { it.isNotEmpty() }
                    ?: SELF_FALLBACK
                // The notification-level id and sticker belong to its newest message.
                val messageId = message.messageId ?: fields.messageId.takeIf { index == newest }
                val isNewest = if (fields.messageId != null && message.messageId != null) {
                    message.messageId == fields.messageId
                } else {
                    index == newest
                }
                Captured(
                    chat, sender, body, isGroup, message.time.takeIf { it > 0 } ?: fields.time,
                    chatId = fields.chatId,
                    messageId = messageId,
                    stickerId = fields.stickerId.takeIf { isNewest },
                    stickerUrl = fields.stickerUrl.takeIf { isNewest },
                )
            }
        }

        val body = (fields.bigText ?: fields.text)?.takeIf { it.isNotBlank() } ?: return emptyList()
        val chat = conversation ?: title ?: return emptyList()
        val sender = title ?: chat
        return listOf(
            Captured(
                chat, sender, body, conversation != null && conversation != title, fields.time,
                chatId = fields.chatId,
                messageId = fields.messageId,
                stickerId = fields.stickerId,
                stickerUrl = fields.stickerUrl,
            )
        )
    }

    /** Reads the fields from a real notification. */
    fun fieldsOf(notification: Notification, postTime: Long): NotificationFields {
        val extras: Bundle = notification.extras
        val messages = parseMessages(extras.getParcelableArray(Notification.EXTRA_MESSAGES))
        @Suppress("DEPRECATION")
        val selfName = extras.getParcelable<android.app.Person>(Notification.EXTRA_MESSAGING_PERSON)?.name?.toString()
            ?: extras.getCharSequence(Notification.EXTRA_SELF_DISPLAY_NAME)?.toString()
        return NotificationFields(
            isGroupSummary = notification.flags and Notification.FLAG_GROUP_SUMMARY != 0,
            category = notification.category,
            title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
            text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
            bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString(),
            conversationTitle = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString(),
            isGroupConversation = extras.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false),
            selfName = selfName,
            messages = messages,
            time = notification.`when`.takeIf { it > 0 } ?: postTime,
            chatId = textOf(extras, KEY_CHAT_ID),
            messageId = textOf(extras, KEY_MESSAGE_ID),
            stickerId = textOf(extras, KEY_STICKER_ID),
            stickerUrl = textOf(extras, KEY_STICKER_URL)?.takeIf { it.startsWith("https://") },
        )
    }

    /** A string, number or text extra as a non-empty string of reasonable length. */
    private fun textOf(bundle: Bundle?, key: String): String? {
        @Suppress("DEPRECATION")
        val value = bundle?.get(key) ?: return null
        if (value !is CharSequence && value !is Long && value !is Int) return null
        val text = value.toString().trim()
        val maxLength = if (key == KEY_STICKER_URL) 2000 else 100
        return text.takeIf { it.isNotEmpty() && it.length <= maxLength }
    }

    // MessagingStyle stores each message as a Bundle with these keys.
    private fun parseMessages(raw: Array<Parcelable>?): List<StyleMessage> {
        if (raw == null) return emptyList()
        return raw.mapNotNull { item ->
            val bundle = item as? Bundle ?: return@mapNotNull null
            @Suppress("DEPRECATION")
            val person = bundle.getParcelable<android.app.Person>("sender_person")
            val sender = person?.name?.toString() ?: bundle.getCharSequence("sender")?.toString()
            StyleMessage(
                text = bundle.getCharSequence("text")?.toString(),
                senderName = sender,
                time = bundle.getLong("time", 0L),
                messageId = textOf(bundle.getBundle("extras"), KEY_STYLE_MESSAGE_ID),
            )
        }
    }
}
