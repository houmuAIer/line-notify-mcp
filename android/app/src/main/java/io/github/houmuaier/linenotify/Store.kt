package io.github.houmuaier.linenotify

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class QueuedMessage(val rowId: Long, val message: Captured)
data class Chat(val name: String, val excluded: Boolean, val isGroup: Boolean)
data class RecentEntry(val chat: String, val sender: String, val body: String, val sentAt: Long)

/** Local state: the upload queue, the chats seen so far, and what was already captured. */
class Store private constructor(context: Context) :
    SQLiteOpenHelper(context.applicationContext, "capture.db", null, 1) {

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
                 is_group INTEGER NOT NULL, sent_at INTEGER NOT NULL)"""
        )
        db.execSQL("CREATE TABLE seen (dedup_key TEXT PRIMARY KEY, at INTEGER NOT NULL)")
        db.execSQL(
            """CREATE TABLE chats (
                 name TEXT PRIMARY KEY, excluded INTEGER NOT NULL DEFAULT 0,
                 is_group INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0)"""
        )
        db.execSQL(
            """CREATE TABLE recent (
                 id INTEGER PRIMARY KEY AUTOINCREMENT, chat TEXT NOT NULL, sender TEXT NOT NULL,
                 body TEXT NOT NULL, sent_at INTEGER NOT NULL)"""
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    /**
     * Records a captured message. Returns true when it was queued for upload:
     * false for one seen before, or one from an excluded chat.
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

            // Two statements rather than an upsert: Android 10 ships an SQLite without ON CONFLICT DO UPDATE.
            val group = if (message.isGroup) 1 else 0
            db.execSQL("INSERT OR IGNORE INTO chats (name) VALUES (?)", arrayOf<Any>(message.chat))
            db.execSQL(
                "UPDATE chats SET last_seen = ?, is_group = MAX(is_group, ?) WHERE name = ?",
                arrayOf<Any>(now, group, message.chat)
            )
            if (isExcluded(db, message.chat)) {
                db.setTransactionSuccessful()
                return false
            }

            db.insertWithOnConflict("outbox", null, ContentValues().apply {
                put("dedup_key", message.dedupKey)
                put("chat", message.chat)
                put("sender", message.sender)
                put("body", message.body)
                put("is_group", if (message.isGroup) 1 else 0)
                put("sent_at", message.sentAt)
            }, SQLiteDatabase.CONFLICT_IGNORE)
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

    private fun isExcluded(db: SQLiteDatabase, chat: String): Boolean =
        db.rawQuery("SELECT 1 FROM chats WHERE name = ? AND excluded = 1", arrayOf(chat)).use { it.moveToFirst() }

    @Synchronized
    fun nextBatch(limit: Int): List<QueuedMessage> =
        readableDatabase.rawQuery(
            "SELECT id, chat, sender, body, is_group, sent_at FROM outbox ORDER BY id LIMIT ?",
            arrayOf(limit.toString())
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    add(
                        QueuedMessage(
                            cursor.getLong(0),
                            Captured(
                                chat = cursor.getString(1),
                                sender = cursor.getString(2),
                                body = cursor.getString(3),
                                isGroup = cursor.getInt(4) == 1,
                                sentAt = cursor.getLong(5),
                            )
                        )
                    )
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

    @Synchronized
    fun chats(): List<Chat> =
        readableDatabase.rawQuery(
            "SELECT name, excluded, is_group FROM chats ORDER BY excluded DESC, last_seen DESC, name", null
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(Chat(cursor.getString(0), cursor.getInt(1) == 1, cursor.getInt(2) == 1))
            }
        }

    @Synchronized
    fun excludedChats(): List<String> = chats().filter { it.excluded }.map { it.name }

    /** Turns capture of a chat on or off. Turning it off also drops what is still waiting to be sent. */
    @Synchronized
    fun setExcluded(chat: String, excluded: Boolean) {
        val db = writableDatabase
        db.execSQL("INSERT OR IGNORE INTO chats (name) VALUES (?)", arrayOf<Any>(chat))
        db.execSQL("UPDATE chats SET excluded = ? WHERE name = ?", arrayOf<Any>(if (excluded) 1 else 0, chat))
        if (excluded) db.execSQL("DELETE FROM outbox WHERE chat = ?", arrayOf<Any>(chat))
    }

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
