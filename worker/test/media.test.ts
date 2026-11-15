// LINE ids, ID-based exclusions, and images (R2), through the phone API and MCP.
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createPairingCode, deleteMedia } from '../src/db';
import { mcpToken, rpc, callTool } from './helpers';

const BASE = 'https://worker.test';

// A 1x1 PNG.
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0)
);

async function deviceToken(): Promise<string> {
  const { code } = await createPairingCode(env);
  const response = await SELF.fetch(`${BASE}/api/pair`, { method: 'POST', body: JSON.stringify({ code }) });
  return ((await response.json()) as { token: string }).token;
}

function message(n: number, extra: Record<string, unknown> = {}) {
  return {
    dedup_key: `line:${String(n).padStart(18, '0')}`,
    chat: '家族',
    chat_id: 'c0123456789abcdef0123456789abcdef',
    line_message_id: String(n).padStart(18, '0'),
    sender: '母',
    body: `メッセージ ${n}`,
    is_group: true,
    sent_at: Date.parse('2026-11-15T12:00:00+09:00') + n * 60_000,
    ...extra,
  };
}

function upload(token: string, messages: unknown[]) {
  return SELF.fetch(`${BASE}/api/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages }),
  });
}

function uploadMedia(token: string, meta: Record<string, unknown>, body: BodyInit = PNG, type = 'image/png') {
  return SELF.fetch(`${BASE}/api/media`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': type,
      'X-Media-Meta': encodeURIComponent(JSON.stringify(meta)),
    },
    body,
  });
}

const photoMeta = (extra: Record<string, unknown> = {}) => ({
  dedup_key: 'photo-0000000000000001',
  kind: 'photo',
  chat: '家族',
  chat_id: 'c0123456789abcdef0123456789abcdef',
  width: 1,
  height: 1,
  sent_at: Date.parse('2026-11-15T13:00:00+09:00'),
  ...extra,
});

describe('LINE ids', () => {
  it('stores ids and keeps one chat across a rename', async () => {
    const token = await deviceToken();
    await upload(token, [message(1), message(2, { chat: '家族（新）', sticker_id: 52002734 })]);
    const row = await env.DB.prepare('SELECT chat_id, line_message_id, sticker_id FROM messages WHERE line_message_id = ?')
      .bind('000000000000000002')
      .first();
    expect(row).toEqual({ chat_id: 'c0123456789abcdef0123456789abcdef', line_message_id: '000000000000000002', sticker_id: '52002734' });

    const access = await mcpToken();
    const chats = await callTool(access, 'list_chats');
    expect(chats.data.chats).toHaveLength(1);
    expect(chats.data.chats[0]).toMatchObject({ chat: '家族（新）', chat_id: 'c0123456789abcdef0123456789abcdef', messages: 2 });

    // Either the name or the id selects the chat.
    const byId = await callTool(access, 'list_recent_messages', { chat: 'c0123456789abcdef0123456789abcdef' });
    expect(byId.data.count).toBe(2);
    expect(byId.data.messages[1]).toMatchObject({ sticker: true });
    expect((await callTool(access, 'list_recent_messages', { chat: '家族' })).data.count).toBe(1);
  });

  it('accepts messages from app versions that send no ids', async () => {
    const token = await deviceToken();
    const old = { dedup_key: 'a'.repeat(64), chat: '田中', sender: '田中', body: 'やあ', is_group: false, sent_at: 1_800_000_000_000 };
    expect(((await (await upload(token, [old])).json()) as { stored: number }).stored).toBe(1);
  });

  it('rejects malformed ids', async () => {
    const token = await deviceToken();
    expect((await upload(token, [message(1, { chat_id: 'x'.repeat(101) })])).status).toBe(400);
    expect((await upload(token, [message(1, { sticker_id: { id: 1 } })])).status).toBe(400);
  });
});

describe('exclusions by id', () => {
  it('drops a renamed chat that was excluded by id, and syncs entries to a new phone', async () => {
    const token = await deviceToken();
    const put = await SELF.fetch(`${BASE}/api/exclusions`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ entries: [{ chat: '公式ショップ', chat_id: 'u99999999999999999999999999999999' }, 'クーポン'] }),
    });
    expect(((await put.json()) as { entries: unknown }).entries).toEqual([
      { chat: 'クーポン', chat_id: null },
      { chat: '公式ショップ', chat_id: 'u99999999999999999999999999999999' },
    ]);
    const renamed = message(3, { chat: '公式ショップ（改名）', chat_id: 'u99999999999999999999999999999999' });
    const result = await upload(token, [message(1), renamed, message(4, { chat: 'クーポン', chat_id: null })]);
    expect(((await result.json()) as { stored: number }).stored).toBe(1);

    const { code } = await createPairingCode(env);
    const paired = (await (await SELF.fetch(`${BASE}/api/pair`, { method: 'POST', body: JSON.stringify({ code }) })).json()) as {
      exclusions: string[];
      exclusion_entries: unknown[];
    };
    expect(paired.exclusions).toEqual(['クーポン', '公式ショップ']);
    expect(paired.exclusion_entries).toHaveLength(2);
  });
});

describe('images', () => {
  it('stores, lists, shows and deletes a photo', async () => {
    const token = await deviceToken();
    const first = await uploadMedia(token, photoMeta());
    expect(first.status).toBe(200);
    const { id, stored } = (await first.json()) as { id: string; stored: boolean };
    expect(stored).toBe(true);
    expect(await env.MEDIA.head(`media/${id}`)).not.toBeNull();

    // The same image again is not stored twice.
    expect(((await (await uploadMedia(token, photoMeta())).json()) as { id: string; stored: boolean })).toEqual({ ok: true, id, stored: false });

    const access = await mcpToken();
    const list = await callTool(access, 'list_media', {});
    expect(list.data.total).toBe(1);
    expect(list.data.media[0]).toMatchObject({ media_id: id, kind: 'photo', chat: '家族', at: '2026-11-15 13:00', size: '1x1', type: 'image/png' });

    const shown = await rpc(access, 'tools/call', { name: 'get_media', arguments: { media_id: id } });
    expect(shown.content[0].type).toBe('image');
    expect(shown.content[0].mimeType).toBe('image/png');
    expect(Uint8Array.from(atob(shown.content[0].data), (c) => c.charCodeAt(0))).toEqual(PNG);

    expect((await callTool(access, 'get_media', { media_id: 'nope' })).isError).toBe(true);
    expect((await callTool(access, 'delete_media', {})).isError).toBe(true);
    expect((await callTool(access, 'delete_media', { chat: '家族' })).data).toMatchObject({ would_delete: 1 });
    expect((await callTool(access, 'delete_media', { chat: '家族', confirm: true })).data.deleted).toBe(1);
    expect(await env.MEDIA.head(`media/${id}`)).toBeNull();
  });

  it('links a sticker image to its message', async () => {
    const token = await deviceToken();
    await upload(token, [message(7, { sticker_id: '123', body: '母がスタンプを送信しました' })]);
    const sticker = photoMeta({ dedup_key: 'sticker-000000000000007', kind: 'sticker', line_message_id: '000000000000000007' });
    const { id } = (await (await uploadMedia(token, sticker)).json()) as { id: string };
    const access = await mcpToken();
    const recent = await callTool(access, 'list_recent_messages', {});
    expect(recent.data.messages[0]).toMatchObject({ sticker: true, media_id: id });
    expect((await callTool(access, 'list_media', { kind: 'photo' })).data.total).toBe(0);
  });

  it('refuses bad uploads and images from excluded chats', async () => {
    const token = await deviceToken();
    expect((await SELF.fetch(`${BASE}/api/media`, { method: 'POST', body: PNG })).status).toBe(401);
    expect((await uploadMedia(token, photoMeta(), PNG, 'video/mp4')).status).toBe(415);
    expect((await uploadMedia(token, { ...photoMeta(), kind: 'video' })).status).toBe(400);
    expect((await uploadMedia(token, photoMeta(), new Uint8Array(0))).status).toBe(400);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    expect((await uploadMedia(token, photoMeta(), big)).status).toBe(413);

    await SELF.fetch(`${BASE}/api/exclusions`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ entries: [{ chat: '別名', chat_id: 'c0123456789abcdef0123456789abcdef' }] }),
    });
    expect(await (await uploadMedia(token, photoMeta())).json()).toEqual({ ok: true, stored: false, excluded: true });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM media').first('n')).toBe(0);
  });

  it('deletes in R2 as well as in the table', async () => {
    const token = await deviceToken();
    for (let i = 0; i < 3; i++) await uploadMedia(token, photoMeta({ dedup_key: `photo-bulk-0000000${i}` }));
    expect(await deleteMedia(env, { chat: '家族' })).toBe(3);
    expect((await env.MEDIA.list({ prefix: 'media/' })).objects).toHaveLength(0);
  });
});
