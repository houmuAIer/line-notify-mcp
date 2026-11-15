// Sign-in for MCP clients: consent page first, then GitHub, then a check that
// the GitHub account is the one allowed to read this server.
import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
} from '@cloudflare/workers-oauth-provider';
import type { AuthProps, Env } from './env';
import { escapeHtml } from './util';

const HTML = { 'Content-Type': 'text/html; charset=utf-8' };

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.7; }
  button { font-size: 1rem; padding: .6rem 1.2rem; margin-right: .5rem; }
  .warn { border-left: 4px solid #b45309; padding-left: .8rem; }
</style>
${body}
</html>`;
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `提供元: <strong>${escapeHtml(details.clientDomain)}</strong>`
    : 'このアプリは自己申告で登録されており、名前は検証されていません。';
  return page(
    `${details.clientName} を許可`,
    `<h1>${name} に LINE 通知の閲覧を許可しますか？</h1>
<p>${origin}</p>
<p>アクセス権の送り先: <strong>${escapeHtml(details.redirectHost)}</strong></p>
${
  details.redirectIsLoopback
    ? '<p class="warn">この端末上のアプリにアクセス権が送られます。いま自分でそのアプリからサインインを始めた場合だけ続けてください。</p>'
    : ''
}
<p>許可すると GitHub でのサインインに進みます。保存済みのメッセージの閲覧・削除と、端末の管理ができるようになります。</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <p><button name="decision" value="approve">許可する</button> <button name="decision" value="deny">拒否する</button></p>
</form>`
  );
}

function errorPage(message: string, status: number): Response {
  return new Response(page('サインインできません', `<h1>サインインできません</h1><p>${escapeHtml(message)}</p>`), {
    status,
    headers: HTML,
  });
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let binary = '';
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fetchGithubUser(
  env: Env,
  code: string,
  verifier: string,
  redirectUri: string
): Promise<{ id: number; login: string } | null> {
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) return null;
  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token.access_token) return null;

  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'line-notify-mcp',
    },
  });
  if (!userResponse.ok) return null;
  const user = (await userResponse.json()) as { id?: unknown; login?: unknown };
  if (typeof user.id !== 'number' || typeof user.login !== 'string') return null;
  return { id: user.id, login: user.login };
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;

  if (request.method === 'GET') {
    const authRequest = await oauth.parseAuthRequest(request);
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    consent.headers.set('Content-Type', HTML['Content-Type']);
    return new Response(consentPage(details, consent.handle), { headers: consent.headers });
  }

  if (request.method === 'POST') {
    const form = await request.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      denied.headers.set('Location', denied.redirectTo);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(request, handle);
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const { state, headers } = await oauth.beginUpstream(approved.request, {
      data: { verifier },
      headers: approved.headers,
    });
    const github = new URL('https://github.com/login/oauth/authorize');
    github.searchParams.set('client_id', env.GITHUB_CLIENT_ID!);
    github.searchParams.set('redirect_uri', new URL('/callback', request.url).href);
    github.searchParams.set('state', state);
    github.searchParams.set('code_challenge', await s256(verifier));
    github.searchParams.set('code_challenge_method', 'S256');
    github.searchParams.set('allow_signup', 'false');
    headers.set('Location', github.href);
    return new Response(null, { status: 302, headers });
  }

  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
}

async function callback(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const url = new URL(request.url);
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);

  const code = url.searchParams.get('code');
  if (url.searchParams.get('error') || !code) {
    headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
    return new Response(null, { status: 302, headers });
  }

  const user = await fetchGithubUser(env, code, data.verifier, new URL('/callback', request.url).href);
  if (!user) {
    headers.set('Location', authorizationErrorRedirect(original, 'server_error'));
    return new Response(null, { status: 302, headers });
  }

  // The gate: any GitHub account can reach this point, only one may pass.
  // Compared by numeric ID, which survives a rename of the account.
  if (String(user.id) !== env.ALLOWED_GITHUB_USER_ID) {
    headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
    return new Response(null, { status: 302, headers });
  }

  const props: AuthProps = { githubUserId: String(user.id), githubLogin: user.login };
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: props.githubUserId,
    metadata: { login: user.login },
    scope: original.scope,
    props,
  });
  headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers });
}

export async function handleAuth(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.ALLOWED_GITHUB_USER_ID) {
    return errorPage('サーバーの設定が完了していません（GitHub OAuth アプリ、または許可するユーザー ID が未設定です）。', 503);
  }
  try {
    return new URL(request.url).pathname === '/callback' ? await callback(request, env) : await authorize(request, env);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) {
      return errorPage(`${error.description} 接続元のアプリからやり直してください。`, 400);
    }
    if (error instanceof CimdFetchError) {
      return errorPage('接続元のアプリを確認できませんでした。', 400);
    }
    throw error;
  }
}
