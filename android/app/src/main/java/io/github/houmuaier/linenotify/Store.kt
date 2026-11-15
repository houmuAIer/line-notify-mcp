package io.github.houmuaier.linenotify

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/** [dedupKey] is the key stored with the row: rows queued by earlier versions carry a content hash. */
data class QueuedMessage(val rowId: Long, val message: Captured, val dedupKey: String)

/** A chat seen in notifications. [key] is LINE's chat id, or "name:<name>" when there is none. */
data class Chat(val key: String, val chatId: String?, val name: String, val excluded: Boolean, val isGroup: Boolean)

data class ExclusionEntry(val chat: String, val chatId: String?)

data class RecentEntry(val chat: String, val sender: String, val body: String, val sentAt: Long)

/** An image waiting to be uploaded: a file on this phone, or a sticker to fetch from [sourceUrl]. */
data class QueuedMedia(
    val rowId: Long,
    val dedupKey: String,
    val kind: String,
    val chat: String,
    val chatId: String?,
    val lineMessageId: String?,
    val filePath: String?,
    val sourceUrl: String?,
    val mime: String?,
    val width: Int?,
    val height: Int?,
    val sentAt: Long,
)

/** Local state: the upload queues, the chats seen so far, and what was already captured. */
class Store private constructor(context: Context) :
    SQLiteOpenHelper(context.applicationContext, "capture.db", null, 3) {

    companion object {
        private const val SEEN_KEEP_MS = 14L * 24 * 60 * 60 * 1000
        private const val RECENT_KEEP = 30

        @Volatile
        private var instance: Store? = null
        fun get(context: Context): Store =
            instance ?: synchronized(this) { instance ?: Store(context).also { instance = it } }
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE outbox (
                 id INTEGER PRIMARY KEY AUTOINCREMENT, dedup_key TEXT NOT NULL UNIQUE,
                 chat TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL,
                 is_group INTEGER NOT NULL, sent_at INTEGER NOT NULL,
                 chat_id TEXT, line_message_id TEXT, sticker_id TEXT)"""
        )
        db.execSQL("CREATE TABLE seen (dedup_key TEXT PRIMARY KEY, at INTEGER NOT NULL)")
        createChats(db)
        db.execSQL(
            """CREATE TABLE recent (
                 id INTEGER PRIMARY KEY AUTOINCREMENT, chat TEXT NOT NULL, sender TEXT NOT NULL,
                 body TEXT NOT NULL, sent_at INTEGER NOT NULL)"""
        )
        createDiagnostics(db)
        createMediaOutbox(db)
    }

    private fun createChats(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE chats (
                 key TEXT PRIMARY KEY, chat_id TEXT, name TEXT NOT NULL,
                 excluded INTEGER NOT NULL DEFAULT 0, is_group INTEGER NOT NULL DEFAULT 0,
                 last_seen INTEGER NOT NULL DEFAULT 0)"""
        )
    }

    private fun createDiagnostics(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS diagnostics (id INTEGER PRIMARY KEY AUTOINCREMENT, report TEXT NOT NULL)")
    }

    private fun createMediaOutbox(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE IF NOT EXISTS media_outbox (
                 id INTEGER PRIMARY KEY AUTOINCREMENT, dedup_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
                 chat TEXT NOT NULL, chat_id TEXT, line_message_id TEXT,
                 file_path TEXT, source_url TEXT, mime TEXT, width INTEGER, height INTEGER,
                 sent_at INTEGER NOT NULL)"""
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) createDiagnostics(db)
        if (oldVersion < 3) {
            db.execSQL("ALTER TABLE outbox ADD COLUMN chat_id TEXT")
            db.execSQL("ALTER TABLE outbox ADD COLUMN line_message_id TEXT")
            db.execSQL("ALTER TABLE outbox ADD COLUMN sticker_id TEXT")
            // Chats were keyed by name; they become keyed by LINE's chat id once one is seen.
            db.execSQL("ALTER TABLE chats RENAME TO chats_v2")
            createChats(db)
            db.execSQL(
                """INSERT INTO chats (key, chat_id, name, excluded, is_group, last_seen)
                   SELECT 'name:' || name, NULL, name, excluded, is_group, last_seen FROM chats_v2"""
            )
            db.execSQL("DROP TABLE chats_v2")
            createMediaOutbox(db)
        }
    }

    // ------------------------------------------------------------ diagnostics

    @Synchronized
    fun addDiagnostic(report: String) {
        val db = writableDatabase
        db.insert("diagnostics", null, ContentValues().apply { put("report", report) })
        db.execSQL("DELETE FROM diagnostics WHERE id <= (SELECT MAX(id) FROM diagnostics) - 20")
    }

    /** Newest first. */
    @Synchronized
    fun diagnostics(): List<String> =
        readableDatabase.rawQuery("SELECT report FROM diagnostics ORDER BY id DESC", null).use { cursor ->
            buildList { while (cursor.moveToNext()) add(cursor.getString(0)) }
        }

    @Synchronized
    fun clearDiagnostics() {
        writableDatabase.execSQL("DELETE FROM diagnostics")
    }

    // ------------------------------------------------------------------ chats

    /**
     * Records that a chat was seen. A chat first seen by name (before ids were
     * read, or added by hand) is taken over by its id, keeping its exclusion.
     */
    private fun touchChat(db: SQLiteDatabase, name: String, chatId: String?, isGroup: Boolean, now: Long) {
        val group = if (isGroup) 1 else 0
        val key = chatKeyOf(chatId, name)
        if (chatId != null) {
            val byId = db.rawQuery("SELECT 1 FROM chats WHERE key = ?", arrayOf(key)).use { it.moveToFirst() }
            if (!byId) {
                val adopted = db.compileStatement("UPDATE chats SET key = ?, chat_id = ? WHERE key = ?").apply {
                    bindString(1, key)
                    bindString(2, chatId)
                    bindString(3, "name:$name")
                }.executeUpdateDelete()
                if (adopted == 0) db.execSQL("INSERT INTO chats (key, chat_id, name) VALUES (?, ?, ?)", arrayOf(key, chatId, name))
            }
        } else {
            db.execSQL("INSERT OR IGNORE INTO chats (key, chat_id, name) VALUES (?, NULL, ?)", arrayOf(key, name))
        }
        db.execSQL(
            "UPDATE chats SET name = ?, last_seen = ?, is_group = MAX(is_group, ?) WHERE key = ?",
            arrayOf<Any>(name, now, group, key)
        )
    }

    private fun isExcluded(db: SQLiteDatabase, name: String, chatId: String?): Boolean =
        db.rawQuery(
            "SELECT 1 FROM chats WHERE excluded = 1 AND (key = ? OR key = ? OR (chat_id IS NULL AND name = ?))",
            arrayOf(chatKeyOf(chatId, name), "name:$name", name)
        ).use { it.moveToFirst() }

    @Synchronized
    fun isExcluded(name: String, chatId: String?): Boolean = isExcluded(readableDatabase, name, chatId)

    private fun Cursor.toChat() = Chat(getString(0), getString(1), getString(2), getInt(3) == 1, getInt(4) == 1)

    /** Excluded chats first, then the most recently seen. */
    @Synchronized
    fun chats(): List<Chat> =
        readableDatabase.rawQuery(
            "SELECT key, chat_id, name, excluded, is_group FROM chats ORDER BY excluded DESC, last_seen DESC, name",
            null
        ).use { cursor -> buildList { while (cursor.moveToNext()) add(cursor.toChat()) } }

    /** Chats that are captured, most recently seen first. */
    @Synchronized
    fun includedChats(limit: Int): List<Chat> =
        readableDatabase.rawQuery(
            "SELECT key, chat_id, name, excluded, is_group FROM chats WHERE excluded = 0 ORDER BY last_seen DESC, name LIMIT ?",
            arrayOf(limit.toString())
        ).use { cursor -> buildList { while (cursor.moveToNext()) add(cursor.toChat()) } }

    @Synchronized
    fun excludedEntries(): List<ExclusionEntry> =
        chats().filter { it.excluded }.map { ExclusionEntry(it.name, it.chatId) }

    /** Turns capture of a chat on or off. Turning it off also drops what is still waiting to be sent. */
    @Synchronized
    fun setExcluded(key: String, excluded: Boolean) {
        val db = writableDatabase
        db.execSQL("UPDATE chats SET excluded = ? WHERE key = ?", arrayOf<Any>(if (excluded) 1 else 0, key))
        if (!excluded) return
        val chat = db.rawQuery("SELECT chat_id, name FROM chats WHERE key = ?", arrayOf(key)).use {
            if (it.moveToFirst()) it.getString(0) to it.getString(1) else null
        } ?: return
        val (chatId, name) = chat
        db.execSQL("DELETE FROM outbox WHERE chat = ? OR (chat_id IS NOT NULL AND chat_id = ?)", arrayOf(name, chatId ?: ""))
        db.execSQL("DELETE FROM media_outbox WHERE chat = ? OR (chat_id IS NOT NULL AND chat_id = ?)", arrayOf(name, chatId ?: ""))
    }

    /** Excludes a chat by name before it has been seen. */
    @Synchronized
    fun excludeByName(name: String) {
        val db = writableDatabase
        val existing = db.rawQuery("SELECT key FROM chats WHERE name = ?", arrayOf(name)).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0)) }
        }
        if (existing.isEmpty()) {
            db.execSQL("INSERT OR IGNORE INTO chats (key, chat_id, name) VALUES (?, NULL, ?)", arrayOf("name:$name", name))
            setExcluded("name:$name", true)
        } else {
            existing.forEach { setExcluded(it, true) }
        }
    }

    /** Applies the exclusions a newly paired phone receives from the server. */
    @Synchronized
    fun applyExclusions(entries: List<ExclusionEntry>) {
        val db = writableDatabase
        for (entry in entries) {
            val key = chatKeyOf(entry.chatId, entry.chat)
            db.insertWithOnConflict("chats", null, ContentValues().apply {
                put("key", key)
                put("chat_id", entry.chatId)
                put("name", entry.chat)
            }, SQLiteDatabase.CONFLICT_IGNORE)
            setExcluded(key, true)
        }
    }

    // --------------------------------------------------------------- messages

    /**
     * Records a captured message. Returns true when something was queued for
     * upload: false for one seen before, or one from an excluded chat. A sticker
     * also queues its image.
     */
    @Synchronized
    fun capture(message: Captured, now: Long = System.currentTimeMillis()): Boolean {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val seen = ContentValues().apply {
                put("dedup_key", message.dedupKey)
                put("at", now)
            }
            if (db.insertWithOnConflict("seen", null, seen, SQLiteDatabase.CONFLICT_IGNORE) == -1L) {
                db.setTransactionSuccessful()
                return false
            }

            touchChat(db, message.chat, message.chatId, message.isGroup, now)
            if (isExcluded(db, message.chat, message.chatId)) {
                db.setTransactionSuccessful()
                return false
            }

            db.insertWithOnConflict("outbox", null, ContentValues().apply {
                put("dedup_key", message.dedupKey)
                put("chat", message.chat)
                put("chat_id", message.chatId)
                put("line_message_id", message.messageId)
                put("sticker_id", message.stickerId)
                put("sender", message.sender)
                put("body", message.body)
                put("is_group", if (message.isGroup) 1 else 0)
                put("sent_at", message.sentAt)
            }, SQLiteDatabase.CONFLICT_IGNORE)
            if (message.stickerUrl != null) {
                db.insertWithOnConflict("media_outbox", null, ContentValues().apply {
                    put("dedup_key", "sticker:${message.dedupKey}")
                    put("kind", "sticker")
                    put("chat", message.chat)
                    put("chat_id", message.chatId)
                    put("line_message_id", message.messageId)
                    put("source_url", message.stickerUrl)
                    put("sent_at", message.sentAt)
                }, SQLiteDatabase.CONFLICT_IGNORE)
            }
            db.insert("recent", null, ContentValues().apply {
                put("chat", message.chat)
                put("sender", message.sender)
                put("body", message.body.take(200))
                put("sent_at", message.sentAt)
            })
            db.execSQL("DELETE FROM recent WHERE id <= (SELECT MAX(id) FROM recent) - $RECENT_KEEP")
            db.execSQL("DELETE FROM seen WHERE at < ?", arrayOf<Any>(now - SEEN_KEEP_MS))
            db.setTransactionSuccessful()
            return true
        } finally {
            db.endTransaction()
        }
    }

    private fun Cursor.stringOrNull(index: Int): String? = if (isNull(index)) null else getString(index)
    private fun Cursor.intOrNull(index: Int): Int? = if (isNull(index)) null else getInt(index)

    @Synchronized
    fun nextBatch(limit: Int): List<QueuedMessage> =
        readableDatabase.rawQuery(
            """SELECT id, chat, sender, body, is_group, sent_at, chat_id, line_message_id, sticker_id, dedup_key
               FROM outbox ORDER BY id LIMIT ?""",
            arrayOf(limit.toString())
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    val message = Captured(
                        chat = cursor.getString(1),
                        sender = cursor.getString(2),
                        body = cursor.getString(3),
                        isGroup = cursor.getInt(4) == 1,
                        sentAt = cursor.getLong(5),
                        chatId = cursor.stringOrNull(6),
                        messageId = cursor.stringOrNull(7),
                        stickerId = cursor.stringOrNull(8),
                    )
                    add(QueuedMessage(cursor.getLong(0), message, cursor.getString(9)))
                }
            }
        }

    @Synchronized
    fun removeFromQueue(rowIds: List<Long>) {
        if (rowIds.isEmpty()) return
        writableDatabase.execSQL("DELETE FROM outbox WHERE id IN (${rowIds.joinToString(",")})")
    }

    @Synchronized
    fun queueSize(): Int =
        readableDatabase.rawQuery("SELECT COUNT(*) FROM outbox", null).use { it.moveToFirst(); it.getInt(0) }

    // ------------------------------------------------------------------ media

    /** Queues a photo saved at [filePath]. Returns false if the same photo was already queued. */
    @Synchronized
    fun queuePhoto(
        dedupKey: String, chat: Chat, filePath: String, mime: String, width: Int, height: Int, sentAt: Long,
    ): Boolean =
        writableDatabase.insertWithOnConflict("media_outbox", null, ContentValues().apply {
            put("dedup_key", dedupKey)
            put("kind", "photo")
            put("chat", chat.name)
            put("chat_id", chat.chatId)
            put("file_path", filePath)
            put("mime", mime)
            put("width", width)
            put("height", height)
            put("sent_at", sentAt)
        }, SQLiteDatabase.CONFLICT_IGNORE) != -1L

    @Synchronized
    fun nextMedia(limit: Int): List<QueuedMedia> =
        readableDatabase.rawQuery(
            """SELECT id, dedup_key, kind, chat, chat_id, line_message_id, file_path, source_url, mime, width, height, sent_at
               FROM media_outbox ORDER BY id LIMIT ?""",
            arrayOf(limit.toString())
        ).use { c ->
            buildList {
                while (c.moveToNext()) {
                    add(
                        QueuedMedia(
                            c.getLong(0), c.getString(1), c.getString(2), c.getString(3), c.stringOrNull(4),
                            c.stringOrNull(5), c.stringOrNull(6), c.stringOrNull(7), c.stringOrNull(8),
                            c.intOrNull(9), c.intOrNull(10), c.getLong(11),
                        )
                    )
                }
            }
        }

    @Synchronized
    fun removeMedia(rowId: Long) {
        writableDatabase.execSQL("DELETE FROM media_outbox WHERE id = ?", arrayOf<Any>(rowId))
    }

    @Synchronized
    fun mediaQueueSize(): Int =
        readableDatabase.rawQuery("SELECT COUNT(*) FROM media_outbox", null).use { it.moveToFirst(); it.getInt(0) }

    // ----------------------------------------------------------------- recent

    @Synchronized
    fun recent(): List<RecentEntry> =
        readableDatabase.rawQuery("SELECT chat, sender, body, sent_at FROM recent ORDER BY id DESC LIMIT 10", null)
            .use { cursor ->
                buildList {
                    while (cursor.moveToNext()) {
                        add(RecentEntry(cursor.getString(0), cursor.getString(1), cursor.getString(2), cursor.getLong(3)))
                    }
                }
            }
}
