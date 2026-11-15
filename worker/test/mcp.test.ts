// End to end: a client registers, the user consents and signs in with GitHub
// (mocked), the client exchanges its code, then talks MCP.
import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPairingCode, pairDevice, storeMessages } from '../src/db';
import { accessToken, authorize, callTool, mockGithub, REDIRECT, rpc, signIn } from './helpers';

const BASE = 'https://worker.test';

afterEach(() => vi.restoreAllMocks());

async function seed() {
  const { code } = await createPairingCode(env);
  const device = (await pairDevice(env, code, 'Pixel'))!;
  const at = (iso: string) => Date.parse(iso);
  await storeMessages(env, device.deviceId, [
    { dedup_key: 'seed-key-000000001', chat: '家族', chat_id: null, line_message_id: null, sticker_id: null, sender: '母', body: '日曜の夕飯どうする？', is_group: true, sent_at: at('2026-11-10T09:00:00+09:00') },
    { dedup_key: 'seed-key-000000002', chat: '家族', chat_id: null, line_message_id: null, sticker_id: null, sender: '父', body: '寿司がいい', is_group: true, sent_at: at('2026-11-10T09:05:00+09:00') },
    { dedup_key: 'seed-key-000000003', chat: '田中', chat_id: null, line_message_id: null, sticker_id: null, sender: '田中', body: '100%_OK です', is_group: false, sent_at: at('2026-11-12T23:30:00+09:00') },
  ]);
  return device;
}

describe('sign-in', () => {
  it('challenges requests without a token and publishes discovery metadata', async () => {
    const response = await SELF.fetch(`${BASE}/mcp`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
    const resource = await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
    expect(((await resource.json()) as { resource: string }).resource).toBe(`${BASE}/mcp`);
    const server = await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`);
    const metadata = (await server.json()) as Record<string, string>;
    expect(metadata.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(metadata.token_endpoint).toBe(`${BASE}/token`);
    expect(metadata.registration_endpoint).toBe(`${BASE}/register`);
  });

  it('rejects a bogus bearer token', async () => {
    const response = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer made-up' },
      body: '{}',
    });
    expect(response.status).toBe(401);
  });

  it('turns away any GitHub account but the allowed one', async () => {
    const { back } = await signIn({ id: 9999, login: 'stranger' });
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('does not contact GitHub when the user declines', async () => {
    const github = mockGithub({ id: 4242, login: 'owner' });
    const { decided } = await authorize('deny');
    expect(decided.status).toBe(302);
    const back = new URL(decided.headers.get('Location')!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(github).not.toHaveBeenCalled();
  });

  it('refuses a consent form posted from another browser', async () => {
    const { handle, authorizeUrl } = await authorize('deny'); // uses up one handle; get a fresh page below
    void handle;
    const page = await SELF.fetch(authorizeUrl, { redirect: 'manual' });
    const fresh = /name="handle" value="([^"]+)"/.exec(await page.text())![1];
    const forged = await SELF.fetch(authorizeUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, // no binding cookie
      body: new URLSearchParams({ handle: fresh, decision: 'approve' }),
    });
    expect(forged.status).toBe(400);
  });

  it('refuses a callback without the browser that started it', async () => {
    mockGithub({ id: 4242, login: 'owner' });
    const { decided } = await authorize();
    const state = new URL(decided.headers.get('Location')!).searchParams.get('state')!;
    const stolen = await SELF.fetch(`${BASE}/callback?code=github-code&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
    });
    expect(stolen.status).toBe(400);
  });
});

describe('MCP tools', () => {
  it('initializes and lists the tools', async () => {
    const token = await accessToken();
    const init = await rpc(token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.serverInfo.name).toBe('line-notify-mcp');
    const { tools } = await rpc(token, 'tools/list');
    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'create_pairing_code',
      'delete_media',
      'delete_messages',
      'get_media',
      'list_chats',
      'list_devices',
      'list_media',
      'list_recent_messages',
      'revoke_device',
      'search_messages',
    ]);
  });

  it('reads, searches, deletes and manages phones', async () => {
    const device = await seed();
    const token = await accessToken();

    const recent = await callTool(token, 'list_recent_messages', {});
    expect(recent.data.messages.map((m: { body: string }) => m.body)).toEqual([
      '日曜の夕飯どうする？',
      '寿司がいい',
      '100%_OK です',
    ]);
    expect(recent.data.messages[0]).toMatchObject({ chat: '家族', sender: '母', sent_at: '2026-11-10 09:00', group: true });

    const newest = await callTool(token, 'list_recent_messages', { limit: 1 });
    expect(newest.data.messages[0].body).toBe('100%_OK です');

    const ranged = await callTool(token, 'list_recent_messages', {
      since: '2026-11-10T09:03:00+09:00',
      until: '2026-11-11T00:00:00+09:00',
    });
    expect(ranged.data.messages.map((m: { sender: string }) => m.sender)).toEqual(['父']);

    const found = await callTool(token, 'search_messages', { query: '寿司' });
    expect(found.data.total_matches).toBe(1);
    expect(found.data.messages[0].sender).toBe('父');
    // % and _ are matched literally, not as wildcards.
    expect((await callTool(token, 'search_messages', { query: '100%_OK' })).data.total_matches).toBe(1);
    expect((await callTool(token, 'search_messages', { query: '%' })).data.total_matches).toBe(1);
    expect((await callTool(token, 'search_messages', { query: '_' })).data.total_matches).toBe(1);

    const chats = await callTool(token, 'list_chats');
    expect(chats.data.chats).toEqual([
      { chat: '田中', chat_id: null, group: false, messages: 1, last_message_at: '2026-11-12 23:30' },
      { chat: '家族', chat_id: null, group: true, messages: 2, last_message_at: '2026-11-10 09:05' },
    ]);

    expect((await callTool(token, 'delete_messages', {})).isError).toBe(true);
    expect((await callTool(token, 'delete_messages', { confirm: true })).isError).toBe(true);
    const preview = await callTool(token, 'delete_messages', { chat: '家族' });
    expect(preview.data).toMatchObject({ deleted: 0, would_delete: 2 });
    expect((await callTool(token, 'list_recent_messages', {})).data.count).toBe(3);
    const deleted = await callTool(token, 'delete_messages', { chat: '家族', confirm: true });
    expect(deleted.data.deleted).toBe(2);
    expect((await callTool(token, 'list_recent_messages', {})).data.count).toBe(1);

    const devices = await callTool(token, 'list_devices');
    expect(devices.data.devices).toHaveLength(1);
    expect(devices.data.devices[0]).toMatchObject({ device_id: device.deviceId, name: 'Pixel', active: true });

    const pairing = await callTool(token, 'create_pairing_code');
    expect(pairing.data.pairing_string).toMatch(/^https:\/\/worker\.test#[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    const code = pairing.data.pairing_string.split('#')[1];
    const paired = await SELF.fetch(`${BASE}/api/pair`, {
      method: 'POST',
      body: JSON.stringify({ code, device_name: 'New phone' }),
    });
    expect(paired.status).toBe(200);
    const newDevice = (await paired.json()) as { device_id: string; token: string };

    const after = await callTool(token, 'list_devices');
    expect(after.data.devices.find((d: { device_id: string }) => d.device_id === device.deviceId).active).toBe(false);

    expect((await callTool(token, 'revoke_device', { device_id: newDevice.device_id })).data.revoked).toBe(true);
    expect((await callTool(token, 'revoke_device', { device_id: newDevice.device_id })).data.revoked).toBe(false);
    const status = await SELF.fetch(`${BASE}/api/status`, { headers: { Authorization: `Bearer ${newDevice.token}` } });
    expect(status.status).toBe(401);
  });

  it('rejects malformed tool input', async () => {
    const token = await accessToken();
    const result = await rpc(token, 'tools/call', { name: 'list_recent_messages', arguments: { since: 'last week' } });
    expect(result.isError).toBe(true);
  });
});
