import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REMOTE_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_REMOTE_REFRESH_TOKEN_TTL_SECONDS,
  buildGoogleAuthorizationEndpoint,
  getRemoteAuthSettings,
  getUpstreamAccessTokenExpiresAt,
  preferConfiguredAccessTokenTtl,
} from './remoteAuthConfig.js';

const baseEnv = {
  BASE_URL: 'https://example.com',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
};

describe('remote auth config', () => {
  it('derives stable secrets and uses longer default TTLs', () => {
    const settings = getRemoteAuthSettings(baseEnv);
    const again = getRemoteAuthSettings(baseEnv);

    expect(settings.accessTokenTtl).toBe(DEFAULT_REMOTE_ACCESS_TOKEN_TTL_SECONDS);
    expect(settings.refreshTokenTtl).toBe(DEFAULT_REMOTE_REFRESH_TOKEN_TTL_SECONDS);
    expect(settings.jwtSigningKey).toBe(again.jwtSigningKey);
    expect(settings.tokenEncryptionKey).toBe(again.tokenEncryptionKey);
    expect(settings.jwtSigningKey).not.toBe(settings.tokenEncryptionKey);
  });

  it('prefers explicit secrets and TTLs', () => {
    const settings = getRemoteAuthSettings({
      ...baseEnv,
      ACCESS_TOKEN_TTL: '120',
      REFRESH_TOKEN_TTL: '240',
      JWT_SIGNING_KEY: 'explicit-jwt',
      TOKEN_ENCRYPTION_KEY: 'explicit-encryption',
    });

    expect(settings.accessTokenTtl).toBe(120);
    expect(settings.refreshTokenTtl).toBe(240);
    expect(settings.jwtSigningKey).toBe('explicit-jwt');
    expect(settings.tokenEncryptionKey).toBe('explicit-encryption');
  });

  it('rejects invalid TTLs', () => {
    expect(() => getRemoteAuthSettings({ ...baseEnv, REFRESH_TOKEN_TTL: '0' })).toThrow(
      'REFRESH_TOKEN_TTL must be a positive integer number of seconds.'
    );
  });

  it('requests offline Google access for refresh tokens', () => {
    const url = new URL(buildGoogleAuthorizationEndpoint());

    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
  });

  it('computes upstream access token expiry from issuedAt', () => {
    expect(
      getUpstreamAccessTokenExpiresAt({
        expiresIn: 3600,
        issuedAt: '2026-05-18T12:00:00.000Z',
      })
    ).toBe(1779109200);
  });

  it('applies configured access token TTL to initial and refresh token paths', async () => {
    const oauthProxy: any = {
      config: { accessTokenTtl: 86_400 },
      calculateAccessTokenTtl: vi.fn(() => 3600),
      issueSwappedTokens: vi.fn(async (_clientId: string, upstreamTokens: any) => ({
        expiresIn: upstreamTokens.expiresIn,
      })),
    };

    preferConfiguredAccessTokenTtl(oauthProxy);

    expect(oauthProxy.calculateAccessTokenTtl({ expiresIn: 3600 })).toBe(86_400);
    await expect(oauthProxy.issueSwappedTokens('client', { expiresIn: 3600 })).resolves.toEqual({
      expiresIn: 0,
    });
  });
});
