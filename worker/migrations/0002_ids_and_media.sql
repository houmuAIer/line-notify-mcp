-- LINE's own identifiers, read from the notification. NULL for messages
-- captured before the app sent them.
ALTER TABLE messages ADD COLUMN chat_id TEXT;
ALTER TABLE messages ADD COLUMN line_message_id TEXT;
ALTER TABLE messages ADD COLUMN sticker_id TEXT;
CREATE INDEX idx_messages_chat_id_sent_at ON messages (chat_id, sent_at DESC);
CREATE INDEX idx_messages_line_message_id ON messages (line_message_id);

-- A chat is excluded when its name or its id matches.
ALTER TABLE exclusions ADD COLUMN chat_id TEXT;

-- Images kept in R2 (bucket binding MEDIA, key media/<id>): photos shared
-- from LINE to the app, and sticker images.
CREATE TABLE media (
  id              TEXT PRIMARY KEY,
  dedup_key       TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,           -- 'photo' | 'sticker'
  chat_id         TEXT,
  chat            TEXT NOT NULL,
  line_message_id TEXT,                    -- for stickers: the message it belongs to
  mime            TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  width           INTEGER,
  height          INTEGER,
  sent_at         INTEGER NOT NULL,        -- epoch ms: sticker sent, or photo shared to the app
  received_at     INTEGER NOT NULL,
  device_id       TEXT NOT NULL
);
CREATE INDEX idx_media_sent_at ON media (sent_at DESC);
CREATE INDEX idx_media_chat_sent_at ON media (chat, sent_at DESC);
CREATE INDEX idx_media_chat_id_sent_at ON media (chat_id, sent_at DESC);
CREATE INDEX idx_media_line_message_id ON media (line_message_id);
