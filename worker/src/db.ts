import type { Env } from './env';
import { likePattern, randomPairingCode, randomToken, sha256Hex } from './util';

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_BODY_CHARS = 10_000;
export const MAX_NAME_CHARS = 200;

export interface MessageRow {
  id: number;
  chat: string;
  sender: string;
  body: string;
  is_group: number;
  sent_at: number;
}

export interface IncomingMessage {
  dedup_key: string;
  chat: string;
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

export async function getExclusions(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT chat FROM exclusions ORDER BY chat').all<{ chat: string }>();
  return results.map((r) => r.chat);
}

export async function replaceExclusions(env: Env, chats: string[], now = Date.now()): Promise<void> {
  const unique = [...new Set(chats)];
  await env.DB.batch([
    env.DB.prepare('DELETE FROM exclusions'),
    env.DB.prepare('INSERT INTO exclusions (chat, created_at) SELECT value, ? FROM json_each(?)').bind(
      now,
      JSON.stringify(unique)
    ),
  ]);
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
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO messages (dedup_key, chat, sender, body, is_group, sent_at, received_at, device_id)
       SELECT json_extract(value, '$.dedup_key'), json_extract(value, '$.chat'), json_extract(value, '$.sender'),
              json_extract(value, '$.body'), json_extract(value, '$.is_group'), json_extract(value, '$.sent_at'), ?, ?
       FROM json_each(?)
       WHERE json_extract(value, '$.chat') NOT IN (SELECT chat FROM exclusions)`
    ).bind(now, deviceId, JSON.stringify(rows)),
    env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(now, deviceId),
  ]);
  return inserted.meta.changes ?? 0;
}

export interface MessageFilter {
  query?: string;
  chat?: string;
  sender?: string;
  since?: number;
  until?: number;
  before?: number;
  ids?: number[];
}

function whereClause(filter: MessageFilter): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.query) {
    conditions.push("body LIKE ? ESCAPE '\\'");
    params.push(likePattern(filter.query));
  }
  if (filter.chat) {
    conditions.push('chat = ?');
    params.push(filter.chat);
  }
  if (filter.sender) {
    conditions.push('sender = ?');
    params.push(filter.sender);
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

/** The newest `limit` matches, returned oldest first so they read as a conversation. */
export async function queryMessages(env: Env, filter: MessageFilter, limit: number): Promise<MessageRow[]> {
  const where = whereClause(filter);
  const { results } = await env.DB.prepare(
    `SELECT id, chat, sender, body, is_group, sent_at FROM messages ${where.sql}
     ORDER BY sent_at DESC, id DESC LIMIT ?`
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

export async function listChats(
  env: Env
): Promise<{ chat: string; is_group: number; messages: number; last_sent_at: number }[]> {
  const { results } = await env.DB.prepare(
    `SELECT chat, MAX(is_group) AS is_group, COUNT(*) AS messages, MAX(sent_at) AS last_sent_at
     FROM messages GROUP BY chat ORDER BY last_sent_at DESC`
  ).all<{ chat: string; is_group: number; messages: number; last_sent_at: number }>();
  return results;
}
