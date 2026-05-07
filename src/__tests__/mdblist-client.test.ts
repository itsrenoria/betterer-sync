import { afterEach, describe, expect, it, vi } from 'vitest';
import { MDBListClient } from '../clients/mdblist.js';

describe('MDBListClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the unified watchlist with API key auth and normalizes movie and show rows', async () => {
    let requestedUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requestedUrl = url;
      return Response.json({
        items: [
          { type: 'movie', ids: { tmdb: 550 } },
          { type: 'show', ids: { tmdb: 1399 } },
          { type: 'movie', ids: { imdb: 'tt0137523' } },
        ],
      });
    }));

    const client = new MDBListClient({
      baseUrl: 'https://api.mdblist.com',
      apiKey: 'mdb-key',
    });

    await expect(client.getWatchlist()).resolves.toEqual([
      { tmdbId: 550, mediaType: 'movie' },
      { tmdbId: 1399, mediaType: 'tv' },
    ]);
    const parsed = new URL(requestedUrl);
    expect(parsed.pathname).toBe('/watchlist/items');
    expect(parsed.searchParams.get('apikey')).toBe('mdb-key');
    expect(parsed.searchParams.get('limit')).toBe('500');
    expect(parsed.searchParams.get('offset')).toBe('0');
    expect(parsed.searchParams.get('unified')).toBe('1');
  });

  it('normalizes MDBList watchlist rows that use the mediatype field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      items: [
        { mediatype: 'movie', ids: { tmdb: 948713 } },
        { mediatype: 'show', ids: { tmdb: 1409 } },
      ],
    })));

    const client = new MDBListClient({
      baseUrl: 'https://api.mdblist.com',
      apiKey: 'mdb-key',
    });

    await expect(client.getWatchlist()).resolves.toEqual([
      { tmdbId: 948713, mediaType: 'movie' },
      { tmdbId: 1409, mediaType: 'tv' },
    ]);
  });

  it('continues pagination while MDBList returns a full page', async () => {
    const urls: string[] = [];
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      type: 'movie',
      ids: { tmdb: index + 1 },
    }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      const offset = new URL(url).searchParams.get('offset');
      return Response.json(offset === '0'
        ? { items: firstPage }
        : { items: [{ type: 'show', ids: { tmdb: 1399 } }] });
    }));

    const client = new MDBListClient({
      baseUrl: 'https://api.mdblist.com',
      apiKey: 'mdb-key',
    });

    const items = await client.getWatchlist();

    expect(items).toHaveLength(501);
    expect(urls.map((url) => new URL(url).searchParams.get('offset'))).toEqual(['0', '500']);
    expect(items.at(-1)).toEqual({ tmdbId: 1399, mediaType: 'tv' });
  });
});
