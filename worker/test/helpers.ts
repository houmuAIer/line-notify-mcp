// Sign-in and MCP helpers shared by the tests.
import { SELF } from 'cloudflare:test';
import { expect, vi } from 'vitest';

const BASE = 'https://worker.test';
export const REDIRECT = 'https://client.example/callback';

export function mockGithub(user: { id: number; login: string }) {
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

export function cookies(response: Response, jar: Map<string, string>) {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index);
    const value = pair.slice(index + 1);
    if (value === '' || /max-age=0/i.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
}

export const cookieHeader = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

export async function s256(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Runs the flow up to the redirect back to the client. */
export async function authorize(decision: 'approve' | 'deny' = 'approve') {
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

export async function signIn(user: { id: number; login: string }) {
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

export async function accessToken(): Promise<string> {
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
export async function rpc(token: string, method: string, params: unknown = {}) {
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

export async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const result = await rpc(token, 'tools/call', { name, arguments: args });
  return { isError: result.isError === true, data: JSON.parse(result.content[0].text) };
}


/** An MCP access token for the allowed account. */
export const mcpToken = accessToken;
