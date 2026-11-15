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
) {
    /** Identifies the message across re-posts of the same notification, and on the server. */
    val dedupKey: String by lazy {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("$chat\u0000$sender\u0000$sentAt\u0000$body".toByteArray(Charsets.UTF_8))
        digest.joinToString("") { "%02x".format(it) }
    }
}

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
)

data class StyleMessage(val text: String?, val senderName: String?, val time: Long)

object Extractor {
    const val LINE_PACKAGE = "jp.naver.line.android"
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
            return fields.messages.mapNotNull { message ->
                val body = message.text?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                // A message without a sender is the user's own, sent from the notification's reply box.
                val sender = message.senderName?.trim()?.takeIf { it.isNotEmpty() }
                    ?: fields.selfName?.trim()?.takeIf { it.isNotEmpty() }
                    ?: SELF_FALLBACK
                Captured(chat, sender, body, isGroup, message.time.takeIf { it > 0 } ?: fields.time)
            }
        }

        val body = (fields.bigText ?: fields.text)?.takeIf { it.isNotBlank() } ?: return emptyList()
        val chat = conversation ?: title ?: return emptyList()
        val sender = title ?: chat
        return listOf(Captured(chat, sender, body, conversation != null && conversation != title, fields.time))
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
        )
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
            )
        }
    }
}
