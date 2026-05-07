import type { Logger } from '../logger.js';
import type {
  MdbListClientLike,
  PublicMetaDBListItem,
  PublicMetaDBWatchlistClientLike,
  SyncStats,
  WatchlistMediaItem,
} from './types.js';

type WatchlistSyncDeps = {
  mdbList: MdbListClientLike;
  publicMetaDB: PublicMetaDBWatchlistClientLike;
  logger?: Logger;
};

export class WatchlistSyncService {
  private readonly mdbList: MdbListClientLike;
  private readonly publicMetaDB: PublicMetaDBWatchlistClientLike;
  private readonly logger: Logger;

  constructor(deps: WatchlistSyncDeps) {
    this.mdbList = deps.mdbList;
    this.publicMetaDB = deps.publicMetaDB;
    this.logger = deps.logger ?? noopLogger;
  }

  async sync(): Promise<SyncStats> {
    const stats = emptyStats();
    const sourceItems = uniqueWatchlistItems(await this.mdbList.getWatchlist());
    const sourceKeys = new Set(sourceItems.map(watchlistItemKey));
    const watchlist = await this.publicMetaDB.getOrCreateWatchlist();
    const existingItems = await this.publicMetaDB.getAllListItems(watchlist.id);
    const existingKeys = new Set(existingItems.map(publicMetaDBListItemKey));

    for (const item of sourceItems) {
      const key = watchlistItemKey(item);
      if (existingKeys.has(key)) {
        stats.skipped++;
        continue;
      }

      try {
        await this.publicMetaDB.addListItem(watchlist.id, item);
        stats.imported++;
        this.logger.info(`Added MDBList watchlist item to PublicMetaDB: ${describeWatchlistItem(item)}`);
      } catch (error) {
        stats.failed++;
        this.logger.error(`Failed to add MDBList watchlist item to PublicMetaDB: ${describeWatchlistItem(item)}`, {
          error: toErrorMessage(error),
        });
      }
    }

    for (const item of existingItems) {
      const key = publicMetaDBListItemKey(item);
      if (sourceKeys.has(key)) {
        continue;
      }

      try {
        await this.publicMetaDB.deleteListItem(watchlist.id, item.id);
        stats.deleted++;
        this.logger.info(`Removed PublicMetaDB watchlist item missing from MDBList: ${describePublicMetaDBListItem(item)}`);
      } catch (error) {
        stats.failed++;
        this.logger.error(`Failed to remove PublicMetaDB watchlist item missing from MDBList: ${describePublicMetaDBListItem(item)}`, {
          error: toErrorMessage(error),
        });
      }
    }

    this.logger.info('MDBList watchlist sync complete', stats);
    return stats;
  }
}

function uniqueWatchlistItems(items: WatchlistMediaItem[]): WatchlistMediaItem[] {
  const seen = new Set<string>();
  const unique: WatchlistMediaItem[] = [];
  for (const item of items) {
    const key = watchlistItemKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function watchlistItemKey(item: WatchlistMediaItem): string {
  return [item.mediaType, item.tmdbId].join('|');
}

function publicMetaDBListItemKey(item: PublicMetaDBListItem): string {
  return [item.media_type, item.tmdb_id].join('|');
}

function describeWatchlistItem(item: WatchlistMediaItem): string {
  return `${item.mediaType} tmdb:${item.tmdbId}`;
}

function describePublicMetaDBListItem(item: PublicMetaDBListItem): string {
  return `${item.media_type} tmdb:${item.tmdb_id}`;
}

function emptyStats(): SyncStats {
  return {
    imported: 0,
    adopted: 0,
    updated: 0,
    skipped: 0,
    retried: 0,
    failed: 0,
    deleted: 0,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
