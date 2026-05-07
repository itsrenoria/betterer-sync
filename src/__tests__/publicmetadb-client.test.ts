import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicMetaDBClient } from '../clients/publicmetadb.js';

describe('PublicMetaDBClient list methods', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a private watchlist when the account does not have one', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (!init?.method || init.method === 'GET') {
        return Response.json({ items: [], totalPages: 1 });
      }
      return Response.json({
        item: {
          id: 'lst_created',
          name: 'My Watchlist',
          type: 'watchlist',
          is_public: false,
        },
      });
    }));

    const client = new PublicMetaDBClient({
      baseUrl: 'https://publicmetadb.com',
      apiKey: 'pm-key',
    });

    await expect(client.getOrCreateWatchlist()).resolves.toMatchObject({
      id: 'lst_created',
      type: 'watchlist',
      is_public: false,
    });
    expect(requests.map((request) => [new URL(request.url).pathname, request.init?.method ?? 'GET'])).toEqual([
      ['/api/external/lists', 'GET'],
      ['/api/external/lists', 'POST'],
    ]);
    expect(JSON.parse(requests[1]?.init?.body as string)).toMatchObject({
      name: 'My Watchlist',
      type: 'watchlist',
      is_public: false,
    });
  });

  it('returns an existing watchlist without creating another list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      items: [
        { id: 'lst_custom', type: 'custom', name: 'Other' },
        { id: 'lst_watchlist', type: 'watchlist', name: 'My Watchlist' },
      ],
      totalPages: 1,
    })));

    const client = new PublicMetaDBClient({
      baseUrl: 'https://publicmetadb.com',
      apiKey: 'pm-key',
    });

    await expect(client.getOrCreateWatchlist()).resolves.toMatchObject({ id: 'lst_watchlist' });
  });

  it('paginates list items and maps add/delete requests to PublicMetaDB list endpoints', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname === '/api/external/lists/lst_watchlist/items' && (!init?.method || init.method === 'GET')) {
        return Response.json(parsed.searchParams.get('page') === '1'
          ? {
              items: [{ id: 'li_1', tmdb_id: 550, media_type: 'movie' }],
              totalPages: 2,
            }
          : {
              items: [{ id: 'li_2', tmdb_id: 1399, media_type: 'tv' }],
              totalPages: 2,
            });
      }
      if (parsed.pathname === '/api/external/lists/lst_watchlist/items' && init?.method === 'POST') {
        return Response.json({
          item: { id: 'li_3', tmdb_id: 551, media_type: 'movie' },
        });
      }
      return Response.json({ success: true });
    }));

    const client = new PublicMetaDBClient({
      baseUrl: 'https://publicmetadb.com',
      apiKey: 'pm-key',
    });

    await expect(client.getAllListItems('lst_watchlist')).resolves.toEqual([
      expect.objectContaining({ id: 'li_1' }),
      expect.objectContaining({ id: 'li_2' }),
    ]);
    await client.addListItem('lst_watchlist', { tmdbId: 551, mediaType: 'movie' });
    await client.deleteListItem('lst_watchlist', 'li_1');

    expect(JSON.parse(requests[2]?.init?.body as string)).toEqual({
      tmdb_id: 551,
      media_type: 'movie',
    });
    expect(new URL(requests[3]?.url ?? '').pathname).toBe('/api/external/lists/lst_watchlist/items/li_1');
    expect(requests[3]?.init?.method).toBe('DELETE');
  });
});
