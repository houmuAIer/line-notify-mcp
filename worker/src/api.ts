// The phone's API. These routes are not behind the OAuth provider: the phone
// proves itself with a pairing code once, and with its device token after that.
import type { Env } from './env';
import {
  authenticateDevice,
  getExclusions,
  MAX_BODY_CHARS,
  MAX_NAME_CHARS,
  pairDevice,
  replaceExclusions,
  storeMessages,
  type IncomingMessage,
} from './db';
import { json, normalizePairingCode, PAIRING_CODE_LENGTH } from './util';

const MAX_REQUEST_CHARS = 600_000;
const MAX_BATCH = 50;
const MAX_EXCLUSIONS = 2000;

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.length > MAX_REQUEST_CHARS) return json({ error: 'too_large' }, 413);
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
}

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '');
  return match ? match[1] : null;
}

function parseMessage(value: unknown): IncomingMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  if (typeof m.dedup_key !== 'string' || m.dedup_key.length < 16 || m.dedup_key.length > 128) return null;
  if (typeof m.chat !== 'string' || !m.chat) return null;
  if (typeof m.sender !== 'string') return null;
  if (typeof m.body !== 'string') return null;
  if (typeof m.sent_at !== 'number' || !Number.isFinite(m.sent_at) || m.sent_at <= 0) return null;
  return {
    dedup_key: m.dedup_key,
    chat: m.chat.slice(0, MAX_NAME_CHARS),
    sender: m.sender.slice(0, MAX_NAME_CHARS),
    body: m.body.slice(0, MAX_BODY_CHARS),
    is_group: m.is_group === true,
    sent_at: Math.trunc(m.sent_at),
  };
}

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
    return json({ device_id: paired.deviceId, token: paired.token, exclusions: await getExclusions(env) });
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

  if (pathname === '/api/exclusions' && request.method === 'GET') {
    return json({ chats: await getExclusions(env) });
  }

  if (pathname === '/api/exclusions' && request.method === 'PUT') {
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const chats = body.chats;
    if (
      !Array.isArray(chats) ||
      chats.length > MAX_EXCLUSIONS ||
      !chats.every((c): c is string => typeof c === 'string' && c.length > 0 && c.length <= MAX_NAME_CHARS)
    ) {
      return json({ error: 'invalid_chats' }, 400);
    }
    await replaceExclusions(env, chats);
    return json({ ok: true, chats: await getExclusions(env) });
  }

  return json({ error: 'not_found' }, 404);
}
