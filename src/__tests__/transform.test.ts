import { describe, expect, it } from 'vitest';
import { transformTraktHistoryItem } from '../sync/transform.js';

describe('transformTraktHistoryItem', () => {
  it('preserves movie TMDB ID and UTC watched_at timestamp', async () => {
    const item = {
      id: 101,
      type: 'movie',
      watched_at: '2024-03-10T08:15:00.000Z',
      action: 'watch',
      movie: {
        ids: { trakt: 1, tmdb: 550, imdb: 'tt0137523' },
      },
    };

    const result = await transformTraktHistoryItem(item, { lookupTmdbId: async () => null });

    expect(result).toEqual({
      kind: 'ok',
      traktHistoryId: 101,
      mediaType: 'movie',
      tmdbId: 550,
      watchedAt: '2024-03-10T08:15:00.000Z',
      season: null,
      episode: null,
      action: 'watch',
      source: item,
    });
  });

  it('uses show TMDB ID and season zero for specials episodes', async () => {
    const item = {
      id: 202,
      type: 'episode',
      watched_at: '2024-04-02T11:00:00Z',
      action: 'scrobble',
      episode: { season: 0, number: 3, ids: { trakt: 88, tvdb: 99 } },
      show: { ids: { trakt: 77, tmdb: 1399, tvdb: 121361 } },
    };

    const result = await transformTraktHistoryItem(item, { lookupTmdbId: async () => null });

    expect(result).toMatchObject({
      kind: 'ok',
      mediaType: 'tv',
      tmdbId: 1399,
      season: 0,
      episode: 3,
      watchedAt: '2024-04-02T11:00:00Z',
    });
  });

  it('falls back to PublicMetaDB external mapping when Trakt has no TMDB ID', async () => {
    const attempted: Array<{ idType: string; idValue: string; mediaType: string }> = [];
    const item = {
      id: 303,
      type: 'movie',
      watched_at: '2024-05-01T00:00:00Z',
      action: 'watch',
      movie: { ids: { trakt: 123, imdb: 'tt0111161' } },
    };

    const result = await transformTraktHistoryItem(item, {
      lookupTmdbId: async (idType, idValue, mediaType) => {
        attempted.push({ idType, idValue, mediaType });
        return idType === 'imdb' ? 278 : null;
      },
    });

    expect(result).toMatchObject({ kind: 'ok', mediaType: 'movie', tmdbId: 278 });
    expect(attempted).toEqual([
      { idType: 'trakt', idValue: '123', mediaType: 'movie' },
      { idType: 'imdb', idValue: 'tt0111161', mediaType: 'movie' },
    ]);
  });

  it('returns retry status for unsupported or unmapped items', async () => {
    const result = await transformTraktHistoryItem(
      {
        id: 404,
        type: 'episode',
        watched_at: '2024-05-01T00:00:00Z',
        action: 'watch',
        episode: { season: 1, number: 1, ids: { trakt: 10 } },
        show: { ids: { trakt: 20 } },
      },
      { lookupTmdbId: async () => null },
    );

    expect(result).toEqual({
      kind: 'retry',
      traktHistoryId: 404,
      reason: 'Unable to resolve TMDB ID for tv history item 404',
      source: expect.any(Object),
    });
  });
});
