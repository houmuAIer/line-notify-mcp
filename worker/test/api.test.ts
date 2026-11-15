import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createPairingCode, PAIRING_CODE_TTL_MS } from '../src/db';
import { formatPairingCode } from '../src/util';

const BASE = 'https://worker.test';

function message(n: number, overrides: Record<string, unknown> = {}) {
  return {
    dedup_key: `dedup-key-number-${String(n).padStart(4, '0')}`,
    chat: '家族',
    sender: '母',
    body: `メッセージ ${n}`,
    is_group: true,
    sent_at: 1_800_000_000_000 + n,
    ...overrides,
  };
}

async function pair(code: string, name = 'Pixel') {
  return SELF.fetch(`${BASE}/api/pair`, {
    method: 'POST',
    body: JSON.stringify({ code, device_name: name }),
  });
}

async function newDevice(): Promise<string> {
  const { code } = await createPairingCode(env);
  const response = await pair(code);
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

function upload(token: string, messages: unknown[]) {
  return SELF.fetch(`${BASE}/api/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages }),
  });
}

describe('pairing', () => {
  it('rejects uploads without a device token', async () => {
    expect((await upload('not-a-token', [message(1)])).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/messages`, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('rejects an unknown code', async () => {
    expect((await pair('ABCDE-FGHJK')).status).toBe(400);
    expect((await pair('short')).status).toBe(400);
  });

  it('accepts a code once, as a person would type it', async () => {
    const { code } = await createPairingCode(env);
    const typed = formatPairingCode(code).toLowerCase();
    const first = await pair(` ${typed} `);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { token: string; device_id: string; exclusions: string[] };
    expect(body.token.length).toBeGreaterThan(30);
    expect(body.exclusions).toEqual([]);
    expect((await pair(code)).status).toBe(400);
  });

  it('rejects an expired code', async () => {
    const { code } = await createPairingCode(env, Date.now() - PAIRING_CODE_TTL_MS - 1000);
    expect((await pair(code)).status).toBe(400);
  });

  it('stores only a hash of the token and the code', async () => {
    const { code } = await createPairingCode(env);
    const token = ((await (await pair(code)).json()) as { token: string }).token;
    const dump = JSON.stringify([
      (await env.DB.prepare('SELECT * FROM devices').all()).results,
      (await env.DB.prepare('SELECT * FROM pairing_codes').all()).results,
    ]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(code);
  });

  it('signs the old phone out when a new phone pairs', async () => {
    const oldToken = await newDevice();
    expect((await upload(oldToken, [message(1)])).status).toBe(200);
    const newToken = await newDevice();
    expect((await upload(oldToken, [message(2)])).status).toBe(401);
    const status = await SELF.fetch(`${BASE}/api/status`, { headers: { Authorization: `Bearer ${oldToken}` } });
    expect(status.status).toBe(401);
    expect((await upload(newToken, [message(2)])).status).toBe(200);
  });
});

describe('uploading', () => {
  it('stores new messages and ignores duplicates', async () => {
    const token = await newDevice();
    const first = (await (await upload(token, [message(1), message(2)])).json()) as { stored: number };
    expect(first.stored).toBe(2);
    const second = (await (await upload(token, [message(2), message(3)])).json()) as { stored: number };
    expect(second.stored).toBe(1);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>();
    expect(count?.n).toBe(3);
    const row = await env.DB.prepare('SELECT chat, sender, body, is_group, sent_at FROM messages WHERE dedup_key = ?')
      .bind(message(1).dedup_key)
      .first();
    expect(row).toEqual({ chat: '家族', sender: '母', body: 'メッセージ 1', is_group: 1, sent_at: 1_800_000_000_001 });
  });

  it('rejects malformed batches', async () => {
    const token = await newDevice();
    expect((await upload(token, [{ chat: 'x' }])).status).toBe(400);
    expect((await upload(token, [message(1, { sent_at: 'yesterday' })])).status).toBe(400);
    expect((await upload(token, Array.from({ length: 51 }, (_, i) => message(i)))).status).toBe(400);
    const notJson = await SELF.fetch(`${BASE}/api/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: 'not json',
    });
    expect(notJson.status).toBe(400);
  });

  it('accepts a full batch in one request', async () => {
    const token = await newDevice();
    const response = await upload(token, Array.from({ length: 50 }, (_, i) => message(i)));
    expect(((await response.json()) as { stored: number }).stored).toBe(50);
  });
});

describe('exclusions', () => {
  it('syncs the list and drops excluded chats on upload', async () => {
    const token = await newDevice();
    const put = await SELF.fetch(`${BASE}/api/exclusions`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ chats: ['公式ショップ', 'クーポン', 'クーポン'] }),
    });
    expect(((await put.json()) as { chats: string[] }).chats).toEqual(['クーポン', '公式ショップ']);

    const result = await upload(token, [message(1), message(2, { chat: '公式ショップ' })]);
    expect(((await result.json()) as { stored: number }).stored).toBe(1);

    // A new phone gets the list back when it pairs.
    const { code } = await createPairingCode(env);
    const paired = (await (await pair(code)).json()) as { exclusions: string[] };
    expect(paired.exclusions).toEqual(['クーポン', '公式ショップ']);
  });

  it('requires a device token', async () => {
    expect((await SELF.fetch(`${BASE}/api/exclusions`)).status).toBe(401);
  });
});
