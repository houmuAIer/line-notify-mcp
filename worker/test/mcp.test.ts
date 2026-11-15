// End to end: a client registers, the user consents and signs in with GitHub
// (mocked), the client exchanges its code, then talks MCP.
import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPairingCode, pairDevice, storeMessages } from '../src/db';

const BASE = 'https://worker.test';
const REDIRECT = 'https://client.example/callback';

afterEach(() => vi.restoreAllMocks());

function mockGithub(user: { id: number; login: string }) {
  const original = globalThis.fetch;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = JSON.parse(String(init?.body));
      expect(body.client_secret).toBe('test-client-secret');
      expect(body.code).toBe('github-code');
      expect(body.code_verifier.length).toBeGreaterThan(40);
      return Response.json({ access_token: 'gho_test' });
    }
    if (url === 'https://api.github.com/user') return Response.json(user);
    return original(input, init);
  });
}

function cookies(response: Response, jar: Map<string, string>) {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index);
    const value = pair.slice(index + 1);
    if (value === '' || /max-age=0/i.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
}

const cookieHeader = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function s256(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Runs the flow up to the redirect back to the client. */
async function authorize(decision: 'approve' | 'deny' = 'approve') {
  const registration = await SELF.fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test <b>Client</b>',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(registration.status).toBe(201);
  const client = (await registration.json()) as { client_id: string };

  const verifier = 'v'.repeat(64);
  const authorizeUrl = new URL(`${BASE}/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    state: 'client-state',
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
    resource: `${BASE}/mcp`,
  }).toString();

  const jar = new Map<string, string>();
  const consent = await SELF.fetch(authorizeUrl, { redirect: 'manual' });
  expect(consent.status).toBe(200);
  expect(consent.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  const html = await consent.text();
  expect(html).toContain('client.example');
  expect(html).not.toContain('<b>Client</b>'); // client-supplied text is escaped
  cookies(consent, jar);
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];

  const decided = await SELF.fetch(authorizeUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader(jar), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ handle, decision }),
  });
  cookies(decided, jar);
  return { client, verifier, decided, jar, handle, authorizeUrl };
}

async function signIn(user: { id: number; login: string }) {
  mockGithub(user);
  const { client, verifier, decided, jar } = await authorize();
  expect(decided.status).toBe(302);
  const github = new URL(decided.headers.get('Location')!);
  expect(github.origin + github.pathname).toBe('https://github.com/login/oauth/authorize');
  expect(github.searchParams.get('client_id')).toBe('test-client-id');
  expect(github.searchParams.get('redirect_uri')).toBe(`${BASE}/callback`);
  const state = github.searchParams.get('state')!;

  const callback = await SELF.fetch(`${BASE}/callback?code=github-code&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
    headers: { Cookie: cookieHeader(jar) },
  });
  expect(callback.status).toBe(302);
  return { client, verifier, state, jar, back: new URL(callback.headers.get('Location')!) };
}

async function accessToken(): Promise<string> {
  const { client, verifier, back } = await signIn({ id: 4242, login: 'owner' });
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe('client-state');
  const token = await SELF.fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: back.searchParams.get('code')!,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }),
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

let nextId = 1;
async function rpc(token: string, method: string, params: unknown = {}) {
  const response = await SELF.fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: any; error?: unknown }).result;
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const result = await rpc(token, 'tools/call', { name, arguments: args });
  return { isError: result.isError === true, data: JSON.parse(result.content[0].text) };
}

async function seed() {
  const { code } = await createPairingCode(env);
  const device = (await pairDevice(env, code, 'Pixel'))!;
  const at = (iso: string) => Date.parse(iso);
  await storeMessages(env, device.deviceId, [
    { dedup_key: 'seed-key-000000001', chat: '家族', sender: '母', body: '日曜の夕飯どうする？', is_group: true, sent_at: at('2026-11-10T09:00:00+09:00') },
    { dedup_key: 'seed-key-000000002', chat: '家族', sender: '父', body: '寿司がいい', is_group: true, sent_at: at('2026-11-10T09:05:00+09:00') },
    { dedup_key: 'seed-key-000000003', chat: '田中', sender: '田中', body: '100%_OK です', is_group: false, sent_at: at('2026-11-12T23:30:00+09:00') },
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
      'delete_messages',
      'list_chats',
      'list_devices',
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
      { chat: '田中', group: false, messages: 1, last_message_at: '2026-11-12 23:30' },
      { chat: '家族', group: true, messages: 2, last_message_at: '2026-11-10 09:05' },
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
