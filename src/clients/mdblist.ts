import { requestJson } from '../http/request.js';
import type { Logger } from '../logger.js';
import type { MediaType, MdbListClientLike, WatchlistMediaItem } from '../sync/types.js';

type MDBListOptions = {
  baseUrl: string;
  apiKey: string;
  logger?: Logger;
};

const WATCHLIST_PAGE_SIZE = 500;

export class MDBListClient implements MdbListClientLike {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly logger?: Logger;

  constructor(options: MDBListOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.logger = options.logger;
  }

  async getWatchlist(): Promise<WatchlistMediaItem[]> {
    const items: WatchlistMediaItem[] = [];

    for (let offset = 0; ; offset += WATCHLIST_PAGE_SIZE) {
      const response = await requestJson<unknown>(
        this.url('/watchlist/items', {
          apikey: this.apiKey,
          limit: WATCHLIST_PAGE_SIZE,
          offset,
          unified: 1,
        }),
      );
      const pageItems = readWatchlistRows(response);

      for (const row of pageItems) {
        const item = normalizeWatchlistRow(row.value, row.defaultType);
        if (item) {
          items.push(item);
          continue;
        }
        this.logger?.warn('Skipped unsupported MDBList watchlist row', { row: row.value });
      }

      if (pageItems.length < WATCHLIST_PAGE_SIZE) {
        return items;
      }
    }
  }

  private url(path: string, query?: Record<string, string | number>): string {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}

function readWatchlistRows(response: unknown): Array<{ value: unknown; defaultType?: MediaType }> {
  if (Array.isArray(response)) {
    return response.map((value) => ({ value }));
  }
  const record = readRecord(response);
  const rows: Array<{ value: unknown; defaultType?: MediaType }> = [];

  if (Array.isArray(record.items)) {
    rows.push(...record.items.map((value) => ({ value })));
  }
  if (Array.isArray(record.movies)) {
    rows.push(...record.movies.map((value) => ({ value, defaultType: 'movie' as const })));
  }
  if (Array.isArray(record.shows)) {
    rows.push(...record.shows.map((value) => ({ value, defaultType: 'tv' as const })));
  }

  return rows;
}

function normalizeWatchlistRow(row: unknown, defaultType?: MediaType): WatchlistMediaItem | null {
  const record = readRecord(row);
  const ids = readRecord(record.ids);
  const mediaType = readMediaType(
    record.media_type ?? record.mediaType ?? record.mediatype ?? record.type ?? record.tmdb_type,
  ) ?? defaultType ?? null;
  const tmdbId = readNumber(record.tmdb_id ?? record.tmdbId ?? record.tmdb ?? ids.tmdb);

  if (!mediaType || tmdbId === null) {
    return null;
  }
  return { tmdbId, mediaType };
}

function readMediaType(value: unknown): MediaType | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'movie') {
    return 'movie';
  }
  if (['show', 'shows', 'series', 'tv', 'tvshow', 'tv_show'].includes(normalized)) {
    return 'tv';
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}
