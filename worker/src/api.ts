// The phone's API. These routes are not behind the OAuth provider: the phone
// proves itself with a pairing code once, and with its device token after that.
import type { Env } from './env';
import {
  authenticateDevice,
  getExclusions,
  isExcluded,
  MAX_BODY_CHARS,
  MAX_ID_CHARS,
  MAX_NAME_CHARS,
  pairDevice,
  replaceExclusions,
  storeMedia,
  storeMessages,
  type Exclusion,
  type IncomingMedia,
  type IncomingMessage,
} from './db';
import { json, normalizePairingCode, PAIRING_CODE_LENGTH } from './util';

const MAX_REQUEST_CHARS = 600_000;
const MAX_BATCH = 50;
const MAX_EXCLUSIONS = 2000;
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.length > MAX_REQUEST_CHARS) return json({ error: 'too_large' }, 413);
  return parseObject(text) ?? json({ error: 'invalid_json' }, 400);
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '');
  return match ? match[1] : null;
}

/** An optional short identifier: absent, null, or a non-empty string (numbers are accepted as text). */
function optionalId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS) return value;
  return undefined; // invalid
}

function validDedupKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 128;
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseMessage(value: unknown): IncomingMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  if (!validDedupKey(m.dedup_key)) return null;
  if (typeof m.chat !== 'string' || !m.chat) return null;
  if (typeof m.sender !== 'string') return null;
  if (typeof m.body !== 'string') return null;
  if (!validTime(m.sent_at)) return null;
  const chatId = optionalId(m.chat_id);
  const lineMessageId = optionalId(m.line_message_id);
  const stickerId = optionalId(m.sticker_id);
  if (chatId === undefined || lineMessageId === undefined || stickerId === undefined) return null;
  return {
    dedup_key: m.dedup_key,
    chat: m.chat.slice(0, MAX_NAME_CHARS),
    chat_id: chatId,
    line_message_id: lineMessageId,
    sticker_id: stickerId,
    sender: m.sender.slice(0, MAX_NAME_CHARS),
    body: m.body.slice(0, MAX_BODY_CHARS),
    is_group: m.is_group === true,
    sent_at: Math.trunc(m.sent_at),
  };
}

/** Accepts the old form (a chat name) and the new one ({ chat, chat_id }). */
function parseExclusion(value: unknown): Exclusion | null {
  if (typeof value === 'string') {
    return value.length > 0 && value.length <= MAX_NAME_CHARS ? { chat: value, chat_id: null } : null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const e = value as Record<string, unknown>;
  if (typeof e.chat !== 'string' || !e.chat || e.chat.length > MAX_NAME_CHARS) return null;
  const chatId = optionalId(e.chat_id);
  if (chatId === undefined) return null;
  return { chat: e.chat, chat_id: chatId };
}

function parseMediaMeta(header: string | null): IncomingMedia | null {
  if (!header) return null;
  let text: string;
  try {
    text = decodeURIComponent(header);
  } catch {
    return null;
  }
  const m = parseObject(text);
  if (!m) return null;
  if (!validDedupKey(m.dedup_key)) return null;
  if (m.kind !== 'photo' && m.kind !== 'sticker') return null;
  if (typeof m.chat !== 'string' || !m.chat) return null;
  if (!validTime(m.sent_at)) return null;
  const chatId = optionalId(m.chat_id);
  const lineMessageId = optionalId(m.line_message_id);
  if (chatId === undefined || lineMessageId === undefined) return null;
  const dimension = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 100_000 ? v : null);
  return {
    dedup_key: m.dedup_key,
    kind: m.kind,
    chat: m.chat.slice(0, MAX_NAME_CHARS),
    chat_id: chatId,
    line_message_id: lineMessageId,
    width: dimension(m.width),
    height: dimension(m.height),
    sent_at: Math.trunc(m.sent_at),
  };
}

const exclusionNames = (entries: Exclusion[]) => entries.map((e) => e.chat);

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === '/api/pair' && request.method === 'POST') {
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const code = normalizePairingCode(typeof body.code === 'string' ? body.code : '');
    if (code.length !== PAIRING_CODE_LENGTH) return json({ error: 'invalid_code' }, 400);
    const deviceName = typeof body.device_name === 'string' ? body.device_name : '';
    const paired = await pairDevice(env, code, deviceName);
    if (!paired) return json({ error: 'invalid_code' }, 400);
    const exclusions = await getExclusions(env);
    return json({
      device_id: paired.deviceId,
      token: paired.token,
      exclusions: exclusionNames(exclusions), // names only, for app versions before 0.3
      exclusion_entries: exclusions,
    });
  }

  const token = bearer(request);
  const deviceId = token ? await authenticateDevice(env, token) : null;
  if (!deviceId) return json({ error: 'unauthorized' }, 401);

  if (pathname === '/api/status' && request.method === 'GET') {
    return json({ ok: true, device_id: deviceId });
  }

  if (pathname === '/api/messages' && request.method === 'POST') {
    const body = await readJson(request);
    if (body instanceof Response) return body;
    if (!Array.isArray(body.messages) || body.messages.length > MAX_BATCH) {
      return json({ error: 'invalid_messages' }, 400);
    }
    const messages: IncomingMessage[] = [];
    for (const raw of body.messages) {
      const parsed = parseMessage(raw);
      if (!parsed) return json({ error: 'invalid_message' }, 400);
      messages.push(parsed);
    }
    const stored = await storeMessages(env, deviceId, messages);
    return json({ ok: true, received: messages.length, stored });
  }

  if (pathname === '/api/media' && request.method === 'POST') {
    const meta = parseMediaMeta(request.headers.get('X-Media-Meta'));
    if (!meta) return json({ error: 'invalid_meta' }, 400);
    const mime = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
    if (!MEDIA_TYPES.includes(mime)) return json({ error: 'unsupported_type' }, 415);
    const declared = Number(request.headers.get('Content-Length') ?? '0');
    if (declared > MAX_MEDIA_BYTES) return json({ error: 'too_large' }, 413);
    const data = await request.arrayBuffer();
    if (data.byteLength === 0) return json({ error: 'empty' }, 400);
    if (data.byteLength > MAX_MEDIA_BYTES) return json({ error: 'too_large' }, 413);
    if (await isExcluded(env, meta.chat, meta.chat_id)) return json({ ok: true, stored: false, excluded: true });
    const result = await storeMedia(env, deviceId, meta, mime, data);
    return json({ ok: true, id: result.id, stored: result.stored });
  }

  if (pathname === '/api/exclusions' && request.method === 'GET') {
    const exclusions = await getExclusions(env);
    return json({ chats: exclusionNames(exclusions), entries: exclusions });
  }

  if (pathname === '/api/exclusions' && request.method === 'PUT') {
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const raw = body.entries ?? body.chats;
    if (!Array.isArray(raw) || raw.length > MAX_EXCLUSIONS) return json({ error: 'invalid_chats' }, 400);
    const entries: Exclusion[] = [];
    for (const item of raw) {
      const parsed = parseExclusion(item);
      if (!parsed) return json({ error: 'invalid_chats' }, 400);
      entries.push(parsed);
    }
    await replaceExclusions(env, entries);
    const exclusions = await getExclusions(env);
    return json({ ok: true, chats: exclusionNames(exclusions), entries: exclusions });
  }

  return json({ error: 'not_found' }, 404);
}
