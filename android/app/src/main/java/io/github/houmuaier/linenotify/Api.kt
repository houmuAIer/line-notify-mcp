package io.github.houmuaier.linenotify

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import org.json.JSONArray
import org.json.JSONObject

class HttpStatusException(val status: Int) : IOException("HTTP $status")

data class PairingString(val serverUrl: String, val code: String) {
    companion object {
        /** Parses "https://host#CODE". Only https servers are accepted. */
        fun parse(input: String): PairingString? {
            val trimmed = input.trim()
            val hash = trimmed.indexOf('#')
            if (hash <= 0) return null
            val server = trimmed.substring(0, hash).trim().trimEnd('/')
            val code = trimmed.substring(hash + 1).trim()
            if (!server.startsWith("https://") || code.isEmpty()) return null
            val url = try {
                URL(server)
            } catch (e: Exception) {
                return null
            }
            if (url.host.isNullOrEmpty() || !url.path.isNullOrEmpty() || url.query != null || url.userInfo != null) return null
            return PairingString(server, code)
        }
    }
}

data class PairingResult(val token: String, val exclusions: List<ExclusionEntry>)

/** An image downloaded from LINE's servers: its bytes and type. */
data class Downloaded(val bytes: ByteArray, val mime: String)

/** The server's phone API. Every call blocks; call from a background thread. */
object Api {
    private const val TIMEOUT_MS = 30_000

    fun pair(pairing: PairingString, deviceName: String): PairingResult {
        val body = JSONObject().put("code", pairing.code).put("device_name", deviceName)
        val response = JSONObject(request("POST", "${pairing.serverUrl}/api/pair", null, body.toString()))
        val entries = response.optJSONArray("exclusion_entries")
        val exclusions = if (entries != null) {
            (0 until entries.length()).map { i ->
                val e = entries.getJSONObject(i)
                ExclusionEntry(e.getString("chat"), e.optString("chat_id").takeIf { !e.isNull("chat_id") && it.isNotEmpty() })
            }
        } else {
            val names = response.optJSONArray("exclusions") ?: JSONArray()
            (0 until names.length()).map { ExclusionEntry(names.getString(it), null) }
        }
        return PairingResult(token = response.getString("token"), exclusions = exclusions)
    }

    fun upload(serverUrl: String, token: String, messages: List<QueuedMessage>) {
        val array = JSONArray()
        for (queued in messages) {
            val m = queued.message
            array.put(
                JSONObject()
                    .put("dedup_key", queued.dedupKey)
                    .put("chat", m.chat)
                    .put("chat_id", m.chatId ?: JSONObject.NULL)
                    .put("line_message_id", m.messageId ?: JSONObject.NULL)
                    .put("sticker_id", m.stickerId ?: JSONObject.NULL)
                    .put("sender", m.sender)
                    .put("body", m.body)
                    .put("is_group", m.isGroup)
                    .put("sent_at", m.sentAt)
            )
        }
        request("POST", "$serverUrl/api/messages", token, JSONObject().put("messages", array).toString())
    }

    fun putExclusions(serverUrl: String, token: String, entries: List<ExclusionEntry>) {
        val array = JSONArray()
        for (e in entries) array.put(JSONObject().put("chat", e.chat).put("chat_id", e.chatId ?: JSONObject.NULL))
        request("PUT", "$serverUrl/api/exclusions", token, JSONObject().put("entries", array).toString())
    }

    fun uploadMedia(serverUrl: String, token: String, media: QueuedMedia, mime: String, bytes: ByteArray) {
        val meta = JSONObject()
            .put("dedup_key", media.dedupKey)
            .put("kind", media.kind)
            .put("chat", media.chat)
            .put("chat_id", media.chatId ?: JSONObject.NULL)
            .put("line_message_id", media.lineMessageId ?: JSONObject.NULL)
            .put("width", media.width ?: JSONObject.NULL)
            .put("height", media.height ?: JSONObject.NULL)
            .put("sent_at", media.sentAt)
        val headers = mapOf("X-Media-Meta" to URLEncoder.encode(meta.toString(), "UTF-8").replace("+", "%20"))
        request("POST", "$serverUrl/api/media", token, bytes, mime, headers)
    }

    /** Fetches a sticker image. Only https, at most [MAX_STICKER_BYTES], and only image types. */
    fun downloadImage(url: String): Downloaded {
        require(url.startsWith("https://")) { "not https" }
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.instanceFollowRedirects = true
            val status = connection.responseCode
            if (status !in 200..299) throw HttpStatusException(status)
            val bytes = connection.inputStream.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val buf = ByteArray(16 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    if (out.size() > MAX_STICKER_BYTES) throw IOException("sticker too large")
                }
                out.toByteArray()
            }
            val mime = sniffImageType(bytes) ?: throw IOException("not an image")
            return Downloaded(bytes, mime)
        } finally {
            connection.disconnect()
        }
    }

    private const val MAX_STICKER_BYTES = 2 * 1024 * 1024

    /** Recognises the formats the server accepts from their first bytes. */
    fun sniffImageType(b: ByteArray): String? = when {
        b.size >= 8 && b[0] == 0x89.toByte() && b[1] == 'P'.code.toByte() && b[2] == 'N'.code.toByte() && b[3] == 'G'.code.toByte() -> "image/png"
        b.size >= 3 && b[0] == 0xFF.toByte() && b[1] == 0xD8.toByte() && b[2] == 0xFF.toByte() -> "image/jpeg"
        b.size >= 6 && String(b, 0, 6, Charsets.US_ASCII).let { it == "GIF87a" || it == "GIF89a" } -> "image/gif"
        b.size >= 12 && String(b, 0, 4, Charsets.US_ASCII) == "RIFF" && String(b, 8, 4, Charsets.US_ASCII) == "WEBP" -> "image/webp"
        else -> null
    }

    private fun request(method: String, url: String, token: String?, body: String?): String =
        request(method, url, token, body?.toByteArray(Charsets.UTF_8), "application/json; charset=utf-8", emptyMap())

    private fun request(
        method: String,
        url: String,
        token: String?,
        body: ByteArray?,
        contentType: String,
        headers: Map<String, String>,
    ): String {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Accept", "application/json")
            if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
            for ((name, value) in headers) connection.setRequestProperty(name, value)
            if (body != null) {
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(body.size)
                connection.setRequestProperty("Content-Type", contentType)
                connection.outputStream.use { it.write(body) }
            }
            val status = connection.responseCode
            if (status !in 200..299) throw HttpStatusException(status)
            return connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }
}

/** The image format of a file from its first bytes, including HEIF and AVIF, which are converted before upload. */
fun imageKind(head: ByteArray): String? = Api.sniffImageType(head) ?: when {
    head.size >= 12 && String(head, 4, 4, Charsets.US_ASCII) == "ftyp" &&
        String(head, 8, 4, Charsets.US_ASCII) in setOf("heic", "heix", "mif1", "msf1", "avif") -> "image/heif"
    else -> null
}
