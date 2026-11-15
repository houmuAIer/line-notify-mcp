import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Numeric GitHub user ID of the only account allowed to sign in. */
  ALLOWED_GITHUB_USER_ID: string;
  /** IANA time zone used when showing timestamps, e.g. "Asia/Tokyo". */
  TIMEZONE?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

/** What completeAuthorization() stores and the MCP handler receives in ctx.props. */
export interface AuthProps {
  githubUserId: string;
  githubLogin: string;
}
