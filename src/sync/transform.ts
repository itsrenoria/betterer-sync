import type {
  MediaType,
  TmdbResolver,
  TraktHistoryItem,
  TransformResult,
} from './types.js';

type Ids = {
  trakt?: number | string | null;
  imdb?: string | null;
  tmdb?: number | string | null;
  tvdb?: number | string | null;
};

export async function transformTraktHistoryItem(
  item: TraktHistoryItem,
  resolver: TmdbResolver,
): Promise<TransformResult> {
  if (item.type === 'movie') {
    const ids = readIds(readRecord(item.movie));
    const tmdbId = await resolveTmdbId(ids, 'movie', resolver);
    if (!tmdbId) {
      return retry(item, `Unable to resolve TMDB ID for movie history item ${item.id}`);
    }

    return ok(item, 'movie', tmdbId, null, null);
  }

  if (item.type === 'episode' || item.type === 'show') {
    const episode = readRecord(item.episode);
    const show = readRecord(item.show);
    const showIds = readIds(show);
    const tmdbId = await resolveTmdbId(showIds, 'tv', resolver);
    const season = readNumber(episode.season);
    const episodeNumber = readNumber(episode.number);

    if (!tmdbId) {
      return retry(item, `Unable to resolve TMDB ID for tv history item ${item.id}`);
    }
    if (season === null || episodeNumber === null) {
      return retry(item, `Unable to resolve season/episode for tv history item ${item.id}`);
    }

    return ok(item, 'tv', tmdbId, season, episodeNumber);
  }

  return retry(item, `Unsupported Trakt history type "${item.type}" for item ${item.id}`);
}

async function resolveTmdbId(
  ids: Ids,
  mediaType: MediaType,
  resolver: TmdbResolver,
): Promise<number | null> {
  const direct = readNumber(ids.tmdb);
  if (direct !== null) {
    return direct;
  }

  const candidates: Array<[string, unknown]> = [
    ['trakt', ids.trakt],
    ['imdb', ids.imdb],
    ['tvdb', ids.tvdb],
  ];

  for (const [idType, idValue] of candidates) {
    if (idValue === null || idValue === undefined || idValue === '') {
      continue;
    }

    const tmdbId = await resolver.lookupTmdbId(idType, String(idValue), mediaType);
    if (tmdbId !== null) {
      return tmdbId;
    }
  }

  return null;
}

function ok(
  item: TraktHistoryItem,
  mediaType: MediaType,
  tmdbId: number,
  season: number | null,
  episode: number | null,
): TransformResult {
  return {
    kind: 'ok',
    traktHistoryId: item.id,
    mediaType,
    tmdbId,
    watchedAt: item.watched_at,
    season,
    episode,
    action: typeof item.action === 'string' ? item.action : null,
    source: item,
  };
}

function retry(item: TraktHistoryItem, reason: string): TransformResult {
  return {
    kind: 'retry',
    traktHistoryId: item.id,
    reason,
    source: item,
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function readIds(record: Record<string, unknown>): Ids {
  return readRecord(record.ids) as Ids;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}
