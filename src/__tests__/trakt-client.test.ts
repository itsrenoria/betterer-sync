import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraktClient } from '../clients/trakt.js';

describe('TraktClient headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends explicit JSON, API identity, and user-agent headers during device auth', async () => {
    const requests: Array<{ url: string; headers: HeadersInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, headers: init?.headers });
      if (url.endsWith('/oauth/device/code')) {
        return Response.json({
          device_code: 'device-code',
          user_code: 'USER-CODE',
          verification_url: 'https://trakt.tv/activate',
          expires_in: 60,
          interval: 0,
        });
      }

      return Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        token_type: 'bearer',
        scope: 'public',
        expires_in: 3600,
        created_at: 1000,
      });
    }));

    const db = { saveToken: vi.fn() };
    const client = new TraktClient({
      baseUrl: 'https://api.trakt.tv',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'urn:ietf:wg:oauth:2.0:oob',
      db: db as never,
    });

    await client.authenticateDeviceFlow(() => {});

    expect(requests[0]?.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
      'trakt-api-key': 'client-id',
      'trakt-api-version': '2',
      'user-agent': expect.stringContaining('betterer-sync'),
    });
    expect(requests[0]?.headers).not.toHaveProperty('Authorization');
  });

  it('adds Authorization only for authenticated API requests', async () => {
    let headers: HeadersInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      headers = init?.headers;
      return Response.json([], { headers: { 'X-Pagination-Page-Count': '1' } });
    }));

    const db = {
      getToken: vi.fn(() => ({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        token_type: 'bearer',
        scope: 'public',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      })),
    };
    const client = new TraktClient({
      baseUrl: 'https://api.trakt.tv',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'urn:ietf:wg:oauth:2.0:oob',
      db: db as never,
    });

    for await (const _page of client.getHistory({ limit: 1 })) {
      // no pages expected
    }

    expect(headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
      'trakt-api-key': 'client-id',
      'trakt-api-version': '2',
      'user-agent': expect.stringContaining('betterer-sync'),
      Authorization: 'Bearer access-token',
    });
  });
});
