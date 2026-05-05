import type { Logger } from '../logger.js';
import type { SyncDatabase, SyncEntryRow } from '../storage/database.js';
import { transformTraktHistoryItem } from './transform.js';
import type {
  PublicMetaDBClientLike,
  PublicMetaDBWatchedItem,
  SyncServiceDeps,
  SyncStats,
  TraktHistoryItem,
  TransformedHistoryItem,
} from './types.js';

const emptyStats = (): SyncStats => ({
  imported: 0,
  adopted: 0,
  updated: 0,
  skipped: 0,
  retried: 0,
  failed: 0,
  deleted: 0,
});

export class SyncService {
  private readonly db: SyncDatabase;
  private readonly trakt: SyncServiceDeps['trakt'];
  private readonly publicMetaDB: PublicMetaDBClientLike;
  private readonly logger: Logger;
  private readonly pageLimit: number;

  constructor(deps: SyncServiceDeps) {
    this.db = deps.db;
    this.trakt = deps.trakt;
    this.publicMetaDB = deps.publicMetaDB;
    this.logger = deps.logger ?? noopLogger;
    this.pageLimit = deps.pageLimit ?? 100;
  }

  async backfill(options: { startAt?: string } = {}): Promise<SyncStats> {
    const stats = emptyStats();
    const existingWatched = await this.publicMetaDB.getAllWatched();
    const adoptionIndex = new AdoptionIndex(existingWatched);

    for await (const page of this.trakt.getHistory({ startAt: options.startAt, limit: this.pageLimit })) {
      await this.syncPage(page, adoptionIndex, stats);
    }

    this.db.setState('last_backfill_at', new Date().toISOString());
    this.logStats('backfill complete', stats);
    return stats;
  }

  async syncRecent(overlapMinutes: number): Promise<SyncStats> {
    const startAt = new Date(Date.now() - overlapMinutes * 60_000).toISOString();
    return this.backfill({ startAt });
  }

  async reconcile(): Promise<SyncStats> {
    const stats = emptyStats();
    const existingWatched = await this.publicMetaDB.getAllWatched();
    const adoptionIndex = new AdoptionIndex(existingWatched);
    const publicMetaDBIds = new Set(existingWatched.map((item) => item.id));
    const current = new Map<number, TransformedHistoryItem>();

    for await (const page of this.trakt.getHistory({ limit: this.pageLimit })) {
      for (const item of page) {
        const transformed = await transformTraktHistoryItem(item, this.publicMetaDB);
        if (transformed.kind === 'ok') {
          current.set(transformed.traktHistoryId, transformed);
        }
      }
      await this.syncPage(page, adoptionIndex, stats);
    }

    for (const row of this.db.listActiveSyncedEntries()) {
      const currentItem = current.get(row.trakt_history_id);
      if (!currentItem) {
        await this.deleteMirroredRow(row, stats);
        continue;
      }

      if (row.publicmetadb_id && !publicMetaDBIds.has(row.publicmetadb_id)) {
        await this.createOrAdopt(currentItem, adoptionIndex, stats);
      }
    }

    this.db.setState('last_reconcile_at', new Date().toISOString());
    this.logStats('reconciliation complete', stats);
    return stats;
  }

  private async syncPage(
    page: TraktHistoryItem[],
    adoptionIndex: AdoptionIndex,
    stats: SyncStats,
  ): Promise<void> {
    for (const rawItem of page) {
      const transformed = await transformTraktHistoryItem(rawItem, this.publicMetaDB);
      if (transformed.kind === 'retry') {
        this.db.markRetry(transformed.traktHistoryId, transformed.source, transformed.reason);
        stats.retried++;
        continue;
      }

      try {
        await this.syncItem(transformed, adoptionIndex, stats);
      } catch (error) {
        this.db.markFailed(transformed.traktHistoryId, toErrorMessage(error));
        stats.failed++;
        this.logger.error('failed to sync Trakt history item', {
          traktHistoryId: transformed.traktHistoryId,
          error: toErrorMessage(error),
        });
      }
    }
  }

  private async syncItem(
    item: TransformedHistoryItem,
    adoptionIndex: AdoptionIndex,
    stats: SyncStats,
  ): Promise<void> {
    const existing = this.db.getSyncEntry(item.traktHistoryId);
    if (existing?.sync_status === 'synced' && existing.publicmetadb_id) {
      if (existing.watched_at !== item.watchedAt) {
        await this.patchOrRecreate(item, existing.publicmetadb_id, adoptionIndex, stats);
        return;
      }

      this.db.markSeen(item.traktHistoryId);
      stats.skipped++;
      return;
    }

    await this.createOrAdopt(item, adoptionIndex, stats);
  }

  private async patchOrRecreate(
    item: TransformedHistoryItem,
    publicMetaDBId: string,
    adoptionIndex: AdoptionIndex,
    stats: SyncStats,
  ): Promise<void> {
    try {
      await this.publicMetaDB.patchWatched(publicMetaDBId, { watched_at: item.watchedAt });
      this.db.upsertSyncedEntry(item, publicMetaDBId);
      stats.updated++;
    } catch (error) {
      if (readStatus(error) !== 404) {
        throw error;
      }
      await this.createOrAdopt(item, adoptionIndex, stats);
    }
  }

  private async createOrAdopt(
    item: TransformedHistoryItem,
    adoptionIndex: AdoptionIndex,
    stats: SyncStats,
  ): Promise<void> {
    const adopted = adoptionIndex.takeExact(item);
    if (adopted) {
      this.db.upsertSyncedEntry(item, adopted.id);
      stats.adopted++;
      return;
    }

    const created = await this.publicMetaDB.createWatched(toPublicMetaDBInput(item));
    this.db.upsertSyncedEntry(item, created.id);
    stats.imported++;
  }

  private async deleteMirroredRow(row: SyncEntryRow, stats: SyncStats): Promise<void> {
    if (row.publicmetadb_id) {
      try {
        await this.publicMetaDB.deleteWatched(row.publicmetadb_id);
      } catch (error) {
        if (readStatus(error) !== 404) {
          throw error;
        }
      }
    }
    this.db.markDeleted(row.trakt_history_id);
    stats.deleted++;
  }

  private logStats(message: string, stats: SyncStats): void {
    this.logger.info(message, stats);
  }
}

function toPublicMetaDBInput(item: TransformedHistoryItem) {
  return {
    tmdb_id: item.tmdbId,
    media_type: item.mediaType,
    ...(item.season === null ? {} : { season: item.season }),
    ...(item.episode === null ? {} : { episode: item.episode }),
    watched_at: item.watchedAt,
  };
}

class AdoptionIndex {
  private readonly entries = new Map<string, PublicMetaDBWatchedItem[]>();
  private readonly used = new Set<string>();

  constructor(items: PublicMetaDBWatchedItem[]) {
    for (const item of items) {
      const key = watchedKey({
        mediaType: item.media_type,
        tmdbId: item.tmdb_id,
        season: item.season ?? null,
        episode: item.episode ?? null,
        watchedAt: item.watched_at,
      });
      const list = this.entries.get(key) ?? [];
      list.push(item);
      this.entries.set(key, list);
    }
  }

  takeExact(item: TransformedHistoryItem): PublicMetaDBWatchedItem | undefined {
    const key = watchedKey({
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
      season: item.season,
      episode: item.episode,
      watchedAt: item.watchedAt,
    });
    const candidates = this.entries.get(key) ?? [];
    const candidate = candidates.find((entry) => !this.used.has(entry.id));
    if (candidate) {
      this.used.add(candidate.id);
    }
    return candidate;
  }
}

function watchedKey(input: {
  mediaType: string;
  tmdbId: number;
  season: number | null;
  episode: number | null;
  watchedAt: string | null;
}): string {
  return [
    input.mediaType,
    input.tmdbId,
    input.season ?? '',
    input.episode ?? '',
    normalizeTimestamp(input.watchedAt),
  ].join('|');
}

function normalizeTimestamp(value: string | null): string {
  if (value === null) {
    return 'null';
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

function readStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
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
