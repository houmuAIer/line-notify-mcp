package io.github.houmuaier.linenotify

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
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

data class PairingResult(val token: String, val exclusions: List<String>)

/** The server's phone API. Every call blocks; call from a background thread. */
object Api {
    private const val TIMEOUT_MS = 20_000

    fun pair(pairing: PairingString, deviceName: String): PairingResult {
        val body = JSONObject().put("code", pairing.code).put("device_name", deviceName)
        val response = JSONObject(request("POST", "${pairing.serverUrl}/api/pair", null, body.toString()))
        val exclusions = response.optJSONArray("exclusions") ?: JSONArray()
        return PairingResult(
            token = response.getString("token"),
            exclusions = (0 until exclusions.length()).map { exclusions.getString(it) },
        )
    }

    fun upload(serverUrl: String, token: String, messages: List<Captured>) {
        val array = JSONArray()
        for (m in messages) {
            array.put(
                JSONObject()
                    .put("dedup_key", m.dedupKey)
                    .put("chat", m.chat)
                    .put("sender", m.sender)
                    .put("body", m.body)
                    .put("is_group", m.isGroup)
                    .put("sent_at", m.sentAt)
            )
        }
        request("POST", "$serverUrl/api/messages", token, JSONObject().put("messages", array).toString())
    }

    fun putExclusions(serverUrl: String, token: String, chats: List<String>) {
        request("PUT", "$serverUrl/api/exclusions", token, JSONObject().put("chats", JSONArray(chats)).toString())
    }

    private fun request(method: String, url: String, token: String?, body: String?): String {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Accept", "application/json")
            if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            if (status !in 200..299) throw HttpStatusException(status)
            return connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }
}
