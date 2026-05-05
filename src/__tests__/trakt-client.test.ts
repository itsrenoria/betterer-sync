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

  it('uses private sync history media endpoints for complete account history', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, _init?: RequestInit) => {
      urls.push(url);
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

    for await (const _page of client.getHistory({ limit: 100 })) {
      // no pages expected
    }

    expect(urls.map((url) => new URL(url).pathname)).toEqual([
      '/sync/history/movies',
      '/sync/history/episodes',
    ]);
  });

  it('deep-crawls older history windows when Trakt returns a full capped page', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, _init?: RequestInit) => {
      urls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/sync/history/episodes') {
        return Response.json([], { headers: { 'X-Pagination-Page-Count': '1' } });
      }
      if (parsed.searchParams.has('end_at')) {
        if (parsed.searchParams.get('end_at') !== '2024-03-09T11:59:59.999Z') {
          return Response.json([], { headers: { 'X-Pagination-Page-Count': '1' } });
        }
        return Response.json([
          historyItem(3, '2024-03-08T12:00:00.000Z'),
        ], { headers: { 'X-Pagination-Page-Count': '1' } });
      }
      return Response.json([
        historyItem(1, '2024-03-10T12:00:00.000Z'),
        historyItem(2, '2024-03-09T12:00:00.000Z'),
      ], { headers: { 'X-Pagination-Page-Count': '1' } });
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

    const ids: number[] = [];
    for await (const page of client.getHistory({ limit: 2 })) {
      ids.push(...page.map((item) => item.id));
    }

    expect(ids).toEqual([1, 2, 3]);
    const movieUrls = urls
      .map((url) => new URL(url))
      .filter((url) => url.pathname === '/sync/history/movies');
    expect(movieUrls).toHaveLength(3);
    expect(movieUrls[1].searchParams.get('end_at')).toBe('2024-03-09T11:59:59.999Z');
  });

  it('probes older history windows even when Trakt returns a partial capped slice', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, _init?: RequestInit) => {
      urls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/sync/history/episodes') {
        return Response.json([], { headers: { 'X-Pagination-Page-Count': '1' } });
      }
      if (parsed.searchParams.has('end_at')) {
        if (parsed.searchParams.get('end_at') !== '2023-03-01T11:59:59.999Z') {
          return Response.json([]);
        }
        return Response.json([
          historyItem(2, '2023-02-28T09:34:00.000Z'),
        ], { headers: { 'X-Pagination-Page-Count': '41' } });
      }
      return Response.json([
        historyItem(1, '2023-03-01T12:00:00.000Z'),
      ], { headers: { 'X-Pagination-Page-Count': '58' } });
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

    const ids: number[] = [];
    for await (const page of client.getHistory({ limit: 100 })) {
      ids.push(...page.map((item) => item.id));
    }

    expect(ids).toEqual([1, 2]);
    const movieUrls = urls
      .map((url) => new URL(url))
      .filter((url) => url.pathname === '/sync/history/movies');
    expect(movieUrls).toHaveLength(3);
    expect(movieUrls[1].searchParams.get('end_at')).toBe('2023-03-01T11:59:59.999Z');
  });
});

function historyItem(id: number, watchedAt: string) {
  return {
    id,
    type: 'movie',
    watched_at: watchedAt,
    movie: { ids: { tmdb: 1000 + id } },
  };
}
