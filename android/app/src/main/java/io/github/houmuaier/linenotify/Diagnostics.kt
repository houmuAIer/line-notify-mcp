package io.github.houmuaier.linenotify

import android.app.Notification
import android.app.Person
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Bundle
import android.service.notification.StatusBarNotification
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Describes the structure of a LINE notification without its content: key
 * names, value types, text lengths, image sizes, and whether an image a
 * notification points to can be opened by this app. Used to find out how
 * LINE attaches photos to notifications. Message text, names and image
 * data are never recorded.
 */
object Diagnostics {
    private const val MAX_DEPTH = 4
    private const val MAX_READ_BYTES = 30L * 1024 * 1024

    // Values that describe the format, not the conversation, are shown as they are.
    private val SHOWN_AS_IS = setOf("android.template", "type", "android.mimeType")

    fun describe(context: Context, sbn: StatusBarNotification): String {
        val n = sbn.notification
        val out = StringBuilder()
        out.append("== ").append(SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(Date(sbn.postTime))).append('\n')
        out.append("category=").append(n.category)
            .append(" channel=").append(n.channelId)
            .append(" groupSummary=").append(n.flags and Notification.FLAG_GROUP_SUMMARY != 0)
            .append('\n')
        n.getLargeIcon()?.let { out.append("largeIcon=").append(icon(context, it)).append('\n') }
        bundle(context, n.extras, out, 0)
        return out.toString()
    }

    private fun bundle(context: Context, b: Bundle, out: StringBuilder, depth: Int) {
        val indent = "  ".repeat(depth)
        for (key in b.keySet().sorted()) {
            @Suppress("DEPRECATION")
            val value = try {
                b.get(key)
            } catch (e: Exception) {
                "unreadable(${e.javaClass.simpleName})"
            }
            out.append(indent).append(key).append(" = ")
            if (key in SHOWN_AS_IS && value is CharSequence) {
                out.append('"').append(value).append('"').append('\n')
                continue
            }
            value(context, value, out, depth)
        }
    }

    private fun value(context: Context, v: Any?, out: StringBuilder, depth: Int) {
        val indent = "  ".repeat(depth + 1)
        when (v) {
            null -> out.append("null\n")
            is Boolean, is Int, is Long -> out.append(v.javaClass.simpleName).append('\n')
            is CharSequence -> out.append("Text(len=").append(v.length).append(")\n")
            is Bitmap -> out.append("Bitmap ").append(v.width).append('x').append(v.height).append('\n')
            is Icon -> out.append(icon(context, v)).append('\n')
            is Uri -> out.append(uri(context, v)).append('\n')
            is Person -> {
                out.append("Person(name len=").append(v.name?.length ?: 0)
                v.icon?.let { out.append(", icon=").append(icon(context, it)) }
                if (v.uri != null) out.append(", uri=yes")
                out.append(")\n")
            }
            is Bundle -> {
                if (depth >= MAX_DEPTH) out.append("Bundle(…)\n") else {
                    out.append("Bundle\n")
                    bundle(context, v, out, depth + 1)
                }
            }
            is Array<*> -> {
                out.append("Array[").append(v.size).append("]\n")
                if (depth < MAX_DEPTH) v.forEachIndexed { i, item ->
                    out.append(indent).append('[').append(i).append("] ")
                    value(context, item, out, depth + 1)
                }
            }
            is List<*> -> {
                out.append("List[").append(v.size).append("]\n")
                if (depth < MAX_DEPTH) v.forEachIndexed { i, item ->
                    out.append(indent).append('[').append(i).append("] ")
                    value(context, item, out, depth + 1)
                }
            }
            else -> out.append(v.javaClass.name).append('\n')
        }
    }

    private fun icon(context: Context, icon: Icon): String = when (icon.type) {
        Icon.TYPE_BITMAP, Icon.TYPE_ADAPTIVE_BITMAP -> {
            val d = try {
                icon.loadDrawable(context)
            } catch (e: Exception) {
                null
            }
            "Icon(bitmap ${d?.intrinsicWidth}x${d?.intrinsicHeight})"
        }
        Icon.TYPE_URI, Icon.TYPE_URI_ADAPTIVE_BITMAP -> "Icon(${uri(context, icon.uri)})"
        Icon.TYPE_RESOURCE -> "Icon(resource)"
        Icon.TYPE_DATA -> "Icon(data)"
        else -> "Icon(type=${icon.type})"
    }

    /** Scheme and authority only, plus whether this app can open it and the image size. */
    private fun uri(context: Context, uri: Uri): String {
        val where = "${uri.scheme}://${uri.authority}"
        val bytes = try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                val buf = ByteArray(64 * 1024)
                var total = 0L
                while (total < MAX_READ_BYTES) {
                    val n = input.read(buf)
                    if (n < 0) break
                    total += n
                }
                total
            } ?: return "Uri $where open=null"
        } catch (e: Exception) {
            return "Uri $where open=FAILED(${e.javaClass.simpleName})"
        }
        val size = try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeStream(input, null, o)
                if (o.outWidth > 0) " image=${o.outWidth}x${o.outHeight} ${o.outMimeType}" else " (not an image)"
            } ?: ""
        } catch (e: Exception) {
            ""
        }
        return "Uri $where open=OK bytes=$bytes$size"
    }
}
