package io.github.houmuaier.linenotify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExtractorTest {
    private fun fields(
        title: String? = null,
        text: String? = null,
        bigText: String? = null,
        conversationTitle: String? = null,
        isGroupConversation: Boolean = false,
        selfName: String? = null,
        messages: List<StyleMessage> = emptyList(),
        isGroupSummary: Boolean = false,
        category: String? = "msg",
        time: Long = 1000L,
    ) = NotificationFields(
        isGroupSummary, category, title, text, bigText, conversationTitle, isGroupConversation, selfName, messages, time
    )

    @Test
    fun plainNotificationInDirectChat() {
        val result = Extractor.extract(fields(title = "田中", text = "こんにちは"))
        assertEquals(listOf(Captured("田中", "田中", "こんにちは", false, 1000L)), result)
    }

    @Test
    fun bigTextWinsOverTruncatedText() {
        val result = Extractor.extract(fields(title = "田中", text = "長い…", bigText = "長いメッセージの全文"))
        assertEquals("長いメッセージの全文", result.single().body)
    }

    @Test
    fun messagingStyleInDirectChat() {
        val result = Extractor.extract(
            fields(
                title = "田中",
                messages = listOf(StyleMessage("一通目", "田中", 10L), StyleMessage("二通目", "田中", 20L)),
            )
        )
        assertEquals(
            listOf(Captured("田中", "田中", "一通目", false, 10L), Captured("田中", "田中", "二通目", false, 20L)),
            result
        )
    }

    @Test
    fun messagingStyleInGroup() {
        val result = Extractor.extract(
            fields(
                title = "家族",
                conversationTitle = "家族",
                isGroupConversation = true,
                messages = listOf(StyleMessage("夕飯は？", "母", 10L), StyleMessage("寿司", "父", 20L)),
            )
        )
        assertEquals(
            listOf(Captured("家族", "母", "夕飯は？", true, 10L), Captured("家族", "父", "寿司", true, 20L)),
            result
        )
    }

    @Test
    fun groupDetectedFromConversationTitleAlone() {
        val result = Extractor.extract(
            fields(title = "母", conversationTitle = "家族", messages = listOf(StyleMessage("夕飯は？", "母", 10L)))
        )
        assertEquals(Captured("家族", "母", "夕飯は？", true, 10L), result.single())
    }

    @Test
    fun ownReplyHasNoSender() {
        val result = Extractor.extract(
            fields(
                title = "田中",
                selfName = "山田",
                messages = listOf(StyleMessage("元気？", "田中", 10L), StyleMessage("元気です", null, 20L)),
            )
        )
        assertEquals(listOf("田中", "山田"), result.map { it.sender })
        assertEquals(listOf("田中", "田中"), result.map { it.chat })
    }

    @Test
    fun messageWithoutTimeUsesNotificationTime() {
        val result = Extractor.extract(fields(title = "田中", time = 555L, messages = listOf(StyleMessage("やあ", "田中", 0L))))
        assertEquals(555L, result.single().sentAt)
    }

    @Test
    fun skipsSummariesCallsAndEmptyText() {
        assertTrue(Extractor.extract(fields(title = "LINE", text = "新着メッセージ 3件", isGroupSummary = true)).isEmpty())
        assertTrue(Extractor.extract(fields(title = "田中", text = "音声通話", category = "call")).isEmpty())
        assertTrue(Extractor.extract(fields(title = "田中", text = "  ")).isEmpty())
        assertTrue(Extractor.extract(fields(text = "タイトルなし")).isEmpty())
        assertTrue(Extractor.extract(fields(title = "田中", messages = listOf(StyleMessage(null, "田中", 1L)))).isEmpty())
    }

    @Test
    fun dedupKeyIsStableAndSensitiveToEveryField() {
        val base = Captured("家族", "母", "夕飯は？", true, 10L)
        assertEquals(base.dedupKey, base.copy().dedupKey)
        assertEquals(64, base.dedupKey.length)
        assertNotEquals(base.dedupKey, base.copy(chat = "家族2").dedupKey)
        assertNotEquals(base.dedupKey, base.copy(sender = "父").dedupKey)
        assertNotEquals(base.dedupKey, base.copy(body = "夕飯は").dedupKey)
        assertNotEquals(base.dedupKey, base.copy(sentAt = 11L).dedupKey)
        // Fields are delimited, so text cannot shift between them and collide.
        assertNotEquals(Captured("ab", "c", "x", false, 1L).dedupKey, Captured("a", "bc", "x", false, 1L).dedupKey)
    }

    @Test
    fun pairingStringParsing() {
        assertEquals(
            PairingString("https://line.example.workers.dev", "ABCDE-FGHJK"),
            PairingString.parse("  https://line.example.workers.dev#ABCDE-FGHJK \n")
        )
        assertEquals(
            PairingString("https://line.example.workers.dev", "ABCDE-FGHJK"),
            PairingString.parse("https://line.example.workers.dev/#ABCDE-FGHJK")
        )
        assertNull(PairingString.parse("http://line.example.workers.dev#ABCDE-FGHJK")) // not https
        assertNull(PairingString.parse("https://line.example.workers.dev"))
        assertNull(PairingString.parse("https://line.example.workers.dev#"))
        assertNull(PairingString.parse("ABCDE-FGHJK"))
        assertNull(PairingString.parse("https://user@evil.example#ABCDE-FGHJK"))
        assertNull(PairingString.parse("https://line.example.workers.dev/path#ABCDE-FGHJK"))
    }
}
