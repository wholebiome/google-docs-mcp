import { createHash } from 'crypto';

const SECONDS_PER_DAY = 24 * 60 * 60;

export const DEFAULT_REMOTE_ACCESS_TOKEN_TTL_SECONDS = 30 * SECONDS_PER_DAY;
export const DEFAULT_REMOTE_REFRESH_TOKEN_TTL_SECONDS = 90 * SECONDS_PER_DAY;

type Env = Record<string, string | undefined>;

export interface RemoteAuthSettings {
  accessTokenTtl: number;
  refreshTokenTtl: number;
  jwtSigningKey: string;
  tokenEncryptionKey: string;
}

export interface UpstreamTokenExpiry {
  expiresIn?: number;
  issuedAt?: Date | number | string;
}

export function getRemoteAuthSettings(env: Env = process.env): RemoteAuthSettings {
  return {
    accessTokenTtl: readPositiveIntegerEnv(
      env,
      'ACCESS_TOKEN_TTL',
      DEFAULT_REMOTE_ACCESS_TOKEN_TTL_SECONDS
    ),
    refreshTokenTtl: readPositiveIntegerEnv(
      env,
      'REFRESH_TOKEN_TTL',
      DEFAULT_REMOTE_REFRESH_TOKEN_TTL_SECONDS
    ),
    jwtSigningKey: env.JWT_SIGNING_KEY || deriveStableOAuthSecret('jwt-signing', env),
    tokenEncryptionKey:
      env.TOKEN_ENCRYPTION_KEY || deriveStableOAuthSecret('token-encryption', env),
  };
}

export function buildGoogleAuthorizationEndpoint(): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  return url.toString();
}

export function getUpstreamAccessTokenExpiresAt(
  upstreamTokens: UpstreamTokenExpiry
): number | undefined {
  const expiresIn = Number(upstreamTokens.expiresIn);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return undefined;

  return Math.floor((issuedAtToMs(upstreamTokens.issuedAt) + expiresIn * 1000) / 1000);
}

export function preferConfiguredAccessTokenTtl(oauthProxy: any): void {
  const patchKey = Symbol.for('google-docs-mcp.prefer-configured-access-token-ttl');
  if (oauthProxy[patchKey]) return;
  oauthProxy[patchKey] = true;

  const originalCalculate = oauthProxy.calculateAccessTokenTtl?.bind(oauthProxy);
  if (typeof originalCalculate === 'function') {
    oauthProxy.calculateAccessTokenTtl = function (upstreamTokens: any) {
      if (this.config?.accessTokenTtl) return this.config.accessTokenTtl;
      return originalCalculate(upstreamTokens);
    };
  }

  const originalIssue = oauthProxy.issueSwappedTokens?.bind(oauthProxy);
  if (typeof originalIssue === 'function') {
    oauthProxy.issueSwappedTokens = async function (clientId: string, upstreamTokens: any) {
      if (this.config?.accessTokenTtl) {
        return originalIssue(clientId, { ...upstreamTokens, expiresIn: 0 });
      }
      return originalIssue(clientId, upstreamTokens);
    };
  }
}

function deriveStableOAuthSecret(purpose: string, env: Env): string {
  if (!env.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      `GOOGLE_CLIENT_SECRET is required to derive a stable ${purpose} key for remote OAuth.`
    );
  }

  return createHash('sha256')
    .update('google-docs-mcp remote oauth secret v1')
    .update('\0')
    .update(purpose)
    .update('\0')
    .update(env.BASE_URL || '')
    .update('\0')
    .update(env.GOOGLE_CLIENT_ID || '')
    .update('\0')
    .update(env.GOOGLE_CLIENT_SECRET)
    .digest('hex');
}

function readPositiveIntegerEnv(env: Env, name: string, fallback: number): number {
  const rawValue = env[name];
  if (!rawValue) return fallback;

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of seconds.`);
  }

  return value;
}

function issuedAtToMs(issuedAt: UpstreamTokenExpiry['issuedAt']): number {
  if (!issuedAt) return Date.now();
  const date = issuedAt instanceof Date ? issuedAt : new Date(issuedAt);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}
