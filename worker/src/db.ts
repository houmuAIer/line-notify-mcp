import type { Env } from './env';
import { likePattern, randomPairingCode, randomToken, sha256Hex } from './util';

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_BODY_CHARS = 10_000;
export const MAX_NAME_CHARS = 200;
export const MAX_ID_CHARS = 100;

export interface MessageRow {
  id: number;
  chat: string;
  chat_id: string | null;
  sender: string;
  body: string;
  is_group: number;
  sent_at: number;
  sticker_id: string | null;
  media_id: string | null;
}

export interface IncomingMessage {
  dedup_key: string;
  chat: string;
  chat_id: string | null;
  line_message_id: string | null;
  sticker_id: string | null;
  sender: string;
  body: string;
  is_group: boolean;
  sent_at: number;
}

export interface DeviceRow {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

export interface Exclusion {
  chat: string;
  chat_id: string | null;
}

// ---------------------------------------------------------------- devices

export async function createPairingCode(env: Env, now = Date.now()): Promise<{ code: string; expiresAt: number }> {
  const code = randomPairingCode();
  const expiresAt = now + PAIRING_CODE_TTL_MS;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)').bind(
      await sha256Hex(code),
      now,
      expiresAt
    ),
  ]);
  return { code, expiresAt };
}

/**
 * Exchanges a pairing code for a device token. The code works once. Pairing a
 * phone revokes every other phone: there is one LINE account, so a newly paired
 * phone replaces the old one.
 */
export async function pairDevice(
  env: Env,
  code: string,
  deviceName: string,
  now = Date.now()
): Promise<{ deviceId: string; token: string } | null> {
  const claimed = await env.DB.prepare(
    'UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?'
  )
    .bind(now, await sha256Hex(code), now)
    .run();
  if (claimed.meta.changes !== 1) return null;

  const deviceId = crypto.randomUUID();
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL').bind(now),
    env.DB.prepare('INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').bind(
      deviceId,
      deviceName.slice(0, MAX_NAME_CHARS) || 'Android',
      await sha256Hex(token),
      now
    ),
  ]);
  return { deviceId, token };
}

export async function authenticateDevice(env: Env, token: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT id FROM devices WHERE token_hash = ? AND revoked_at IS NULL')
    .bind(await sha256Hex(token))
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function listDevices(env: Env): Promise<DeviceRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, name, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at DESC'
  ).all<DeviceRow>();
  return results;
}

export async function revokeDevice(env: Env, deviceId: string, now = Date.now()): Promise<boolean> {
  const result = await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(now, deviceId)
    .run();
  return result.meta.changes === 1;
}

// ------------------------------------------------------------- exclusions

export async function getExclusions(env: Env): Promise<Exclusion[]> {
  const { results } = await env.DB.prepare('SELECT chat, chat_id FROM exclusions ORDER BY chat').all<Exclusion>();
  return results;
}

export async function replaceExclusions(env: Env, entries: Exclusion[], now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM exclusions'),
    env.DB.prepare(
      `INSERT OR REPLACE INTO exclusions (chat, chat_id, created_at)
       SELECT json_extract(value, '$.chat'), json_extract(value, '$.chat_id'), ? FROM json_each(?)`
    ).bind(now, JSON.stringify(entries)),
  ]);
}

/** SQL that is true when the chat named by the two expressions is excluded. */
function excludedSql(chatExpr: string, chatIdExpr: string): string {
  return `EXISTS (SELECT 1 FROM exclusions e WHERE e.chat = ${chatExpr}
            OR (e.chat_id IS NOT NULL AND e.chat_id = ${chatIdExpr}))`;
}

export async function isExcluded(env: Env, chat: string, chatId: string | null): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT ${excludedSql('?1', '?2')} AS x`).bind(chat, chatId).first<{ x: number }>();
  return row?.x === 1;
}

// --------------------------------------------------------------- messages

/**
 * Stores messages, skipping duplicates and excluded chats. Returns how many were new.
 * One statement for the whole batch, so a batch costs the same number of D1
 * queries whatever its size.
 */
export async function storeMessages(
  env: Env,
  deviceId: string,
  messages: IncomingMessage[],
  now = Date.now()
): Promise<number> {
  const rows = messages.map((m) => ({ ...m, is_group: m.is_group ? 1 : 0 }));
  const v = (field: string) => `json_extract(value, '$.${field}')`;
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO messages
         (dedup_key, chat, chat_id, line_message_id, sticker_id, sender, body, is_group, sent_at, received_at, device_id)
       SELECT ${v('dedup_key')}, ${v('chat')}, ${v('chat_id')}, ${v('line_message_id')}, ${v('sticker_id')},
              ${v('sender')}, ${v('body')}, ${v('is_group')}, ${v('sent_at')}, ?, ?
       FROM json_each(?)
       WHERE NOT ${excludedSql(v('chat'), v('chat_id'))}`
    ).bind(now, deviceId, JSON.stringify(rows)),
    env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(now, deviceId),
  ]);
  return inserted.meta.changes ?? 0;
}

export interface MessageFilter {
  query?: string;
  /** A chat name or a chat id. */
  chat?: string;
  sender?: string;
  since?: number;
  until?: number;
  before?: number;
  ids?: number[];
}

function whereClause(filter: MessageFilter, table = ''): { sql: string; params: unknown[] } {
  const t = table ? `${table}.` : '';
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.query) {
    conditions.push(`${t}body LIKE ? ESCAPE '\\'`);
    params.push(likePattern(filter.query));
  }
  if (filter.chat) {
    conditions.push(`(${t}chat = ? OR ${t}chat_id = ?)`);
    params.push(filter.chat, filter.chat);
  }
  if (filter.sender) {
    conditions.push(`${t}sender = ?`);
    params.push(filter.sender);
  }
  if (filter.since !== undefined) {
    conditions.push(`${t}sent_at >= ?`);
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    conditions.push(`${t}sent_at <= ?`);
    params.push(filter.until);
  }
  if (filter.before !== undefined) {
    conditions.push(`${t}sent_at < ?`);
    params.push(filter.before);
  }
  if (filter.ids?.length) {
    conditions.push(`${t}id IN (${filter.ids.map(() => '?').join(', ')})`);
    params.push(...filter.ids);
  }
  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

/** The newest `limit` matches, returned oldest first so they read as a conversation. */
export async function queryMessages(env: Env, filter: MessageFilter, limit: number): Promise<MessageRow[]> {
  const where = whereClause(filter, 'm');
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.chat, m.chat_id, m.sender, m.body, m.is_group, m.sent_at, m.sticker_id,
            (SELECT md.id FROM media md WHERE md.line_message_id = m.line_message_id LIMIT 1) AS media_id
     FROM messages m ${where.sql}
     ORDER BY m.sent_at DESC, m.id DESC LIMIT ?`
  )
    .bind(...where.params, limit)
    .all<MessageRow>();
  return results.reverse();
}

export async function countMessages(env: Env, filter: MessageFilter): Promise<number> {
  const where = whereClause(filter);
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages ${where.sql}`)
    .bind(...where.params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function deleteMessages(env: Env, filter: MessageFilter): Promise<number> {
  const where = whereClause(filter);
  if (!where.sql) throw new Error('refusing to delete without a filter');
  const result = await env.DB.prepare(`DELETE FROM messages ${where.sql}`)
    .bind(...where.params)
    .run();
  return result.meta.changes ?? 0;
}

export interface ChatRow {
  chat: string;
  chat_id: string | null;
  is_group: number;
  messages: number;
  last_sent_at: number;
}

/**
 * One row per chat, keyed by LINE's chat id where known. The name is the one
 * on the latest message, so a renamed group shows its current name. (SQLite
 * takes bare columns from the row that matches the single MAX().)
 */
export async function listChats(env: Env): Promise<ChatRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT chat, chat_id, SUM(is_group) > 0 AS is_group, COUNT(*) AS messages, MAX(sent_at) AS last_sent_at
     FROM messages GROUP BY COALESCE(chat_id, 'name:' || chat) ORDER BY last_sent_at DESC`
  ).all<ChatRow>();
  return results;
}

// ------------------------------------------------------------------ media

export interface MediaRow {
  id: string;
  kind: string;
  chat: string;
  chat_id: string | null;
  line_message_id: string | null;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sent_at: number;
}

export interface IncomingMedia {
  dedup_key: string;
  kind: 'photo' | 'sticker';
  chat: string;
  chat_id: string | null;
  line_message_id: string | null;
  width: number | null;
  height: number | null;
  sent_at: number;
}

export const mediaKey = (id: string) => `media/${id}`;

/** Stores an image in R2 and records it. Returns its id, and whether it was new. */
export async function storeMedia(
  env: Env,
  deviceId: string,
  meta: IncomingMedia,
  mime: string,
  data: ArrayBuffer,
  now = Date.now()
): Promise<{ id: string; stored: boolean }> {
  const existing = await env.DB.prepare('SELECT id FROM media WHERE dedup_key = ?')
    .bind(meta.dedup_key)
    .first<{ id: string }>();
  if (existing) return { id: existing.id, stored: false };

  const id = crypto.randomUUID();
  await env.MEDIA.put(mediaKey(id), data, { httpMetadata: { contentType: mime } });
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO media
       (id, dedup_key, kind, chat_id, chat, line_message_id, mime, bytes, width, height, sent_at, received_at, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      meta.dedup_key,
      meta.kind,
      meta.chat_id,
      meta.chat,
      meta.line_message_id,
      mime,
      data.byteLength,
      meta.width,
      meta.height,
      meta.sent_at,
      now,
      deviceId
    )
    .run();
  if (inserted.meta.changes !== 1) {
    // The same image arrived twice at once; keep the first.
    await env.MEDIA.delete(mediaKey(id));
    const winner = await env.DB.prepare('SELECT id FROM media WHERE dedup_key = ?')
      .bind(meta.dedup_key)
      .first<{ id: string }>();
    return { id: winner!.id, stored: false };
  }
  return { id, stored: true };
}

export interface MediaFilter {
  chat?: string;
  kind?: string;
  since?: number;
  until?: number;
  before?: number;
  ids?: string[];
}

function mediaWhere(filter: MediaFilter): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.chat) {
    conditions.push('(chat = ? OR chat_id = ?)');
    params.push(filter.chat, filter.chat);
  }
  if (filter.kind) {
    conditions.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.since !== undefined) {
    conditions.push('sent_at >= ?');
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    conditions.push('sent_at <= ?');
    params.push(filter.until);
  }
  if (filter.before !== undefined) {
    conditions.push('sent_at < ?');
    params.push(filter.before);
  }
  if (filter.ids?.length) {
    conditions.push(`id IN (${filter.ids.map(() => '?').join(', ')})`);
    params.push(...filter.ids);
  }
  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

const MEDIA_COLUMNS = 'id, kind, chat, chat_id, line_message_id, mime, bytes, width, height, sent_at';

/** Newest first. */
export async function queryMedia(env: Env, filter: MediaFilter, limit: number): Promise<MediaRow[]> {
  const where = mediaWhere(filter);
  const { results } = await env.DB.prepare(
    `SELECT ${MEDIA_COLUMNS} FROM media ${where.sql} ORDER BY sent_at DESC LIMIT ?`
  )
    .bind(...where.params, limit)
    .all<MediaRow>();
  return results;
}

export async function getMedia(env: Env, id: string): Promise<MediaRow | null> {
  return env.DB.prepare(`SELECT ${MEDIA_COLUMNS} FROM media WHERE id = ?`).bind(id).first<MediaRow>();
}

export async function countMedia(env: Env, filter: MediaFilter): Promise<number> {
  const where = mediaWhere(filter);
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM media ${where.sql}`)
    .bind(...where.params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function deleteMedia(env: Env, filter: MediaFilter): Promise<number> {
  const where = mediaWhere(filter);
  if (!where.sql) throw new Error('refusing to delete without a filter');
  let deleted = 0;
  // R2 deletes up to 1000 keys per call.
  for (;;) {
    const { results } = await env.DB.prepare(`SELECT id FROM media ${where.sql} LIMIT 1000`)
      .bind(...where.params)
      .all<{ id: string }>();
    if (results.length === 0) return deleted;
    const ids = results.map((r) => r.id);
    await env.MEDIA.delete(ids.map(mediaKey));
    await env.DB.prepare(`DELETE FROM media WHERE id IN (${ids.map(() => '?').join(', ')})`)
      .bind(...ids)
      .run();
    deleted += ids.length;
  }
}
