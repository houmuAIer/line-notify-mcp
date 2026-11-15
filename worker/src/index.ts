import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { handleApi } from './api';
import { handleAuth } from './auth';
import type { AuthProps, Env } from './env';
import { handleMcp } from './mcp';

const DAY = 24 * 60 * 60;

function buildProvider(origin: string): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: {
      async fetch(request: Request, env: Env, ctx: ExecutionContext) {
        // Checked on every request as well as at sign-in, so changing
        // ALLOWED_GITHUB_USER_ID locks out tokens issued to the previous account.
        const props = ctx.props as Partial<AuthProps> | undefined;
        if (!props?.githubUserId || props.githubUserId !== env.ALLOWED_GITHUB_USER_ID) {
          return new Response('Forbidden', { status: 403 });
        }
        return handleMcp(request, env);
      },
    },
    defaultHandler: {
      async fetch(request: Request, env: Env) {
        const { pathname } = new URL(request.url);
        if (pathname === '/authorize' || pathname === '/callback') return handleAuth(request, env);
        if (pathname.startsWith('/api/')) return handleApi(request, env);
        if (pathname === '/') return new Response('line-notify-mcp\n', { headers: { 'Content-Type': 'text/plain' } });
        return new Response('Not Found', { status: 404 });
      },
    },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    clientIdMetadataDocumentEnabled: true,
    // A sign-in lasts as long as the client keeps using it, and ends after 90 idle days.
    refreshTokenIdleTTL: 90 * DAY,
    // Tokens are bound to this URL. It follows the host the Worker is served
    // from, so the code needs no deployment-specific address.
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'LINE notifications' },
  });
}

const providers = new Map<string, OAuthProvider<Env>>();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { origin } = new URL(request.url);
    let provider = providers.get(origin);
    if (!provider) {
      provider = buildProvider(origin);
      providers.set(origin, provider);
    }
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
