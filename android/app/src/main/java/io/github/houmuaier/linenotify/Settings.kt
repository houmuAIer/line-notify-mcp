package io.github.houmuaier.linenotify

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Pairing and upload state. The device token is encrypted with a key held in
 * the Android Keystore, which never leaves this phone: a copy of the app's
 * data on another phone cannot read it and has to pair again.
 */
class Settings(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE)

    val serverUrl: String? get() = prefs.getString("server_url", null)
    val isPaired: Boolean get() = serverUrl != null && prefs.contains("token")

    /** True after the server refused this phone's token: another phone took over, or it was revoked. */
    var revoked: Boolean
        get() = prefs.getBoolean("revoked", false)
        set(value) = prefs.edit().putBoolean("revoked", value).apply()

    var exclusionsDirty: Boolean
        get() = prefs.getBoolean("exclusions_dirty", false)
        set(value) = prefs.edit().putBoolean("exclusions_dirty", value).apply()

    var lastUploadAt: Long
        get() = prefs.getLong("last_upload_at", 0L)
        set(value) = prefs.edit().putLong("last_upload_at", value).apply()

    var lastError: String?
        get() = prefs.getString("last_error", null)
        set(value) = prefs.edit().putString("last_error", value).apply()

    val token: String?
        get() = prefs.getString("token", null)?.let { stored ->
            try {
                decrypt(stored)
            } catch (e: Exception) {
                null
            }
        }

    fun savePairing(serverUrl: String, token: String) {
        prefs.edit()
            .putString("server_url", serverUrl)
            .putString("token", encrypt(token))
            .putBoolean("revoked", false)
            .remove("last_error")
            .apply()
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encrypted = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String {
        val (iv, data) = stored.split(":", limit = 2).map { Base64.decode(it, Base64.NO_WRAP) }
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)) }
        return String(cipher.doFinal(data), Charsets.UTF_8)
    }

    private companion object {
        const val KEY_ALIAS = "device_token_key"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
