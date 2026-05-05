import type { Logger } from '../logger.js';

export type MediaType = 'movie' | 'tv';

export type TraktHistoryItem = Record<string, unknown> & {
  id: number;
  type: string;
  watched_at: string;
  action?: string;
};

export type TransformedHistoryItem = {
  kind: 'ok';
  traktHistoryId: number;
  mediaType: MediaType;
  tmdbId: number;
  season: number | null;
  episode: number | null;
  watchedAt: string;
  action: string | null;
  source: TraktHistoryItem;
};

export type RetryHistoryItem = {
  kind: 'retry';
  traktHistoryId: number;
  reason: string;
  source: TraktHistoryItem;
};

export type TransformResult = TransformedHistoryItem | RetryHistoryItem;

export type TmdbResolver = {
  lookupTmdbId(idType: string, idValue: string, mediaType: MediaType): Promise<number | null>;
};

export type TraktClientLike = {
  getHistory(options?: { startAt?: string; endAt?: string; limit?: number }): AsyncGenerator<TraktHistoryItem[]>;
};

export type PublicMetaDBWatchedItem = {
  id: string;
  tmdb_id: number;
  media_type: MediaType;
  season?: number | null;
  episode?: number | null;
  watched_at: string | null;
};

export type PublicMetaDBCreateWatchedInput = {
  tmdb_id: number;
  media_type: MediaType;
  season?: number;
  episode?: number;
  watched_at: string | null;
};

export type PublicMetaDBClientLike = TmdbResolver & {
  getAllWatched(): Promise<PublicMetaDBWatchedItem[]>;
  createWatched(input: PublicMetaDBCreateWatchedInput): Promise<PublicMetaDBWatchedItem>;
  patchWatched(id: string, input: { watched_at: string | null }): Promise<PublicMetaDBWatchedItem>;
  deleteWatched(id: string): Promise<void>;
};

export type SyncStats = {
  imported: number;
  adopted: number;
  updated: number;
  skipped: number;
  retried: number;
  failed: number;
  deleted: number;
};

export type SyncServiceDeps = {
  db: import('../storage/database.js').SyncDatabase;
  trakt: TraktClientLike;
  publicMetaDB: PublicMetaDBClientLike;
  logger?: Logger;
  pageLimit?: number;
};
