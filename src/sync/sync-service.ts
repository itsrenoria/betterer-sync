import type { Logger } from '../logger.js';
import type { SyncDatabase, SyncEntryRow } from '../storage/database.js';
import { transformTraktHistoryItem } from './transform.js';
import type {
  PublicMetaDBClientLike,
  PublicMetaDBWatchedItem,
  SyncAuditMappedChangeSample,
  SyncAuditReport,
  SyncAuditSample,
  SyncEntryStatus,
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

const emptyStatusCounts = (): Record<SyncEntryStatus, number> => ({
  synced: 0,
  retry: 0,
  failed: 0,
  deleted: 0,
});

const AUDIT_SAMPLE_LIMIT = 20;

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

  async backfill(options: { startAt?: string; completeMessage?: string } = {}): Promise<SyncStats> {
    const stats = emptyStats();
    const existingWatched = await this.publicMetaDB.getAllWatched();
    const adoptionIndex = new AdoptionIndex(existingWatched, mappedPublicMetaDBIds(this.db.listActiveSyncedEntries()));

    for await (const page of this.trakt.getHistory({ startAt: options.startAt, limit: this.pageLimit })) {
      await this.syncPage(page, adoptionIndex, stats);
    }

    this.db.setState(options.startAt ? 'last_recent_sync_at' : 'last_backfill_at', new Date().toISOString());
    this.logStats(options.completeMessage ?? 'backfill complete', stats);
    return stats;
  }

  async syncRecent(overlapMinutes: number): Promise<SyncStats> {
    const startAt = new Date(Date.now() - overlapMinutes * 60_000).toISOString();
    return this.backfill({ startAt, completeMessage: 'recent sync complete' });
  }

  async reconcile(): Promise<SyncStats> {
    const stats = emptyStats();
    const existingWatched = await this.publicMetaDB.getAllWatched();
    const adoptionIndex = new AdoptionIndex(existingWatched, mappedPublicMetaDBIds(this.db.listActiveSyncedEntries()));
    const publicMetaDBIds = new Set(existingWatched.map((item) => item.id));
    const publicMetaDBById = indexPublicMetaDBById(existingWatched);
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
        continue;
      }

      const mappedItem = row.publicmetadb_id ? publicMetaDBById.get(row.publicmetadb_id) : undefined;
      if (mappedItem && !publicMetaDBItemMatches(mappedItem, currentItem)) {
        await this.repairMappedRow(currentItem, row, mappedItem, adoptionIndex, stats);
      }
    }

    this.db.setState('last_reconcile_at', new Date().toISOString());
    this.logStats('reconciliation complete', stats);
    return stats;
  }

  async audit(): Promise<SyncAuditReport> {
    const existingWatched = await this.publicMetaDB.getAllWatched();
    const publicMetaDBById = indexPublicMetaDBById(existingWatched);
    const dbRows = this.db.listSyncEntries();
    const adoptionIndex = new AdoptionIndex(existingWatched, mappedPublicMetaDBIds(dbRows));
    const dbRowsByHistoryId = indexSyncRowsByHistoryId(dbRows);
    const historyIdCounts = new Map<number, number>();
    const missingSamples: SyncAuditSample[] = [];
    const mappedChangedSamples: SyncAuditMappedChangeSample[] = [];
    const mappedMissingSamples: SyncAuditSample[] = [];
    const unresolvedSamples: SyncAuditSample[] = [];
    let traktItems = 0;
    let transformable = 0;
    let unresolved = 0;
    let exactMatches = 0;
    let mappedChanged = 0;
    let mappedMissingById = 0;
    let missing = 0;

    for await (const page of this.trakt.getHistory({ limit: this.pageLimit })) {
      for (const rawItem of page) {
        traktItems++;
        historyIdCounts.set(rawItem.id, (historyIdCounts.get(rawItem.id) ?? 0) + 1);

        const transformed = await transformTraktHistoryItem(rawItem, this.publicMetaDB);
        if (transformed.kind === 'retry') {
          unresolved++;
          pushSample(unresolvedSamples, sampleForRawItem(transformed.source, transformed.reason));
          continue;
        }

        transformable++;
        const row = dbRowsByHistoryId.get(transformed.traktHistoryId);
        const mappedId = activePublicMetaDBId(row);
        const mapped = mappedId ? publicMetaDBById.get(mappedId) : undefined;
        if (mappedId && !mapped) {
          mappedMissingById++;
          missing++;
          pushSample(mappedMissingSamples, sampleForItem(transformed));
          continue;
        }
        if (mappedId && mapped) {
          if (publicMetaDBItemMatches(mapped, transformed)) {
            exactMatches++;
            continue;
          }
          mappedChanged++;
          pushSample(mappedChangedSamples, sampleForMappedChange(transformed, mapped));
          continue;
        }

        const matched = adoptionIndex.takeExact(transformed);
        if (matched) {
          exactMatches++;
          continue;
        }

        missing++;
        pushSample(missingSamples, sampleForItem(transformed));
      }
    }

    const duplicateHistoryIdSamples = [...historyIdCounts.entries()]
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, AUDIT_SAMPLE_LIMIT)
      .map(([traktHistoryId, count]) => ({ traktHistoryId, count }));

    const dbStatusCounts = emptyStatusCounts();
    for (const row of this.db.listSyncEntries()) {
      dbStatusCounts[row.sync_status] = (dbStatusCounts[row.sync_status] ?? 0) + 1;
    }

    const report: SyncAuditReport = {
      traktItems,
      uniqueTraktHistoryIds: historyIdCounts.size,
      duplicateTraktHistoryIds: [...historyIdCounts.values()].filter((count) => count > 1).length,
      transformable,
      unresolved,
      publicMetaDBItems: existingWatched.length,
      exactMatches,
      mappedChanged,
      mappedMissingById,
      missing,
      dbStatusCounts,
      missingSamples,
      mappedChangedSamples,
      mappedMissingSamples,
      unresolvedSamples,
      duplicateHistoryIdSamples,
    };

    this.logAudit(report);
    return report;
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
        this.logger.warn(`Retry queued: ${describeRawHistoryItem(transformed.source)} (${transformed.reason})`, {
          traktHistoryId: transformed.traktHistoryId,
        });
        continue;
      }

      try {
        await this.syncItem(transformed, adoptionIndex, stats);
      } catch (error) {
        this.db.markFailed(transformed, toErrorMessage(error));
        stats.failed++;
        this.logger.error(`Failed to sync Trakt play: ${describeHistoryItem(transformed)}`, {
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
        await this.patchOrRecreate(item, existing.publicmetadb_id, adoptionIndex, stats, existing.watched_at);
        return;
      }

      adoptionIndex.markUsed(existing.publicmetadb_id);
      this.db.markSeen(item.traktHistoryId);
      stats.skipped++;
      return;
    }

    this.logger.info(`Found new Trakt play: ${describeHistoryItem(item)}`, {
      traktHistoryId: item.traktHistoryId,
    });
    await this.createOrAdopt(item, adoptionIndex, stats);
  }

  private async patchOrRecreate(
    item: TransformedHistoryItem,
    publicMetaDBId: string,
    adoptionIndex: AdoptionIndex,
    stats: SyncStats,
    previousWatchedAt: string | null,
  ): Promise<void> {
    try {
      await this.publicMetaDB.patchWatched(publicMetaDBId, { watched_at: item.watchedAt });
      adoptionIndex.markUsed(publicMetaDBId);
      this.db.upsertSyncedEntry(item, publicMetaDBId);
      stats.updated++;
      this.logger.info(`Updated PublicMetaDB timestamp: ${describeHistoryItem(item)} (${previousWatchedAt ?? 'unknown time'} -> ${item.watchedAt})`, {
        traktHistoryId: item.traktHistoryId,
        publicMetaDBId,
      });
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
      this.logger.info(`Adopted existing PublicMetaDB play: ${describeHistoryItem(item)}`, {
        traktHistoryId: item.traktHistoryId,
        publicMetaDBId: adopted.id,
      });
      return;
    }

    const created = await this.publicMetaDB.createWatched(toPublicMetaDBInput(item));
    adoptionIndex.markUsed(created.id);
    this.db.upsertSyncedEntry(item, created.id);
    stats.imported++;
    this.logger.info(`Added to PublicMetaDB: ${describeHistoryItem(item)}`, {
      traktHistoryId: item.traktHistoryId,
      publicMetaDBId: created.id,
    });
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
    this.logger.info(`Removed from PublicMetaDB because Trakt history item is gone: ${describeSyncRow(row)}`, {
      traktHistoryId: row.trakt_history_id,
      publicMetaDBId: row.publicmetadb_id,
    });
  }

  private async repairMappedRow(
    item: TransformedHistoryItem,
    row: SyncEntryRow,
    mappedItem: PublicMetaDBWatchedItem,
    adoptionIndex: AdoptionIndex,
    stats: SyncStats,
  ): Promise<void> {
    if (row.publicmetadb_id && samePublicMetaDBTarget(mappedItem, item)) {
      await this.patchOrRecreate(item, row.publicmetadb_id, adoptionIndex, stats, mappedItem.watched_at);
      return;
    }

    if (row.publicmetadb_id) {
      this.logger.warn(`Mapped PublicMetaDB row changed identity, recreating Trakt play: ${describeHistoryItem(item)}`, {
        traktHistoryId: item.traktHistoryId,
        publicMetaDBId: row.publicmetadb_id,
        actual: describePublicMetaDBItem(mappedItem),
      });
      adoptionIndex.markUsed(row.publicmetadb_id);
      try {
        await this.publicMetaDB.deleteWatched(row.publicmetadb_id);
      } catch (error) {
        if (readStatus(error) !== 404) {
          throw error;
        }
      }
    }
    await this.createOrAdopt(item, adoptionIndex, stats);
  }

  private logStats(message: string, stats: SyncStats): void {
    this.logger.info(message, stats);
  }

  private logAudit(report: SyncAuditReport): void {
    this.logger.info('audit complete', {
      traktItems: report.traktItems,
      uniqueTraktHistoryIds: report.uniqueTraktHistoryIds,
      duplicateTraktHistoryIds: report.duplicateTraktHistoryIds,
      transformable: report.transformable,
      unresolved: report.unresolved,
      publicMetaDBItems: report.publicMetaDBItems,
      exactMatches: report.exactMatches,
      mappedChanged: report.mappedChanged,
      mappedMissingById: report.mappedMissingById,
      missing: report.missing,
      dbSynced: report.dbStatusCounts.synced,
      dbRetry: report.dbStatusCounts.retry,
      dbFailed: report.dbStatusCounts.failed,
      dbDeleted: report.dbStatusCounts.deleted,
    });

    for (const sample of report.missingSamples) {
      this.logger.warn(`Audit missing from PublicMetaDB: ${sample.title} (${sample.media}) watched at ${sample.watchedAt}`, {
        traktHistoryId: sample.traktHistoryId,
      });
    }
    for (const sample of report.mappedChangedSamples) {
      this.logger.warn(`Audit mapped PublicMetaDB row drifted: ${sample.title} expected ${sample.media} watched at ${sample.watchedAt}, got ${sample.actualMedia} watched at ${sample.actualWatchedAt ?? 'null'}`, {
        traktHistoryId: sample.traktHistoryId,
        publicMetaDBId: sample.publicMetaDBId,
      });
    }
    for (const sample of report.mappedMissingSamples) {
      this.logger.warn(`Audit mapped PublicMetaDB row missing by id: ${sample.title} (${sample.media}) watched at ${sample.watchedAt}`, {
        traktHistoryId: sample.traktHistoryId,
      });
    }
    for (const sample of report.unresolvedSamples) {
      this.logger.warn(`Audit unresolved Trakt play: ${sample.title} (${sample.media}) watched at ${sample.watchedAt}`, {
        traktHistoryId: sample.traktHistoryId,
        reason: sample.reason,
      });
    }
    for (const sample of report.duplicateHistoryIdSamples) {
      this.logger.warn('Audit duplicate Trakt history id returned by API', sample);
    }
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

function describeHistoryItem(item: TransformedHistoryItem): string {
  return `${titleFromSource(item.source, item)} (${mediaLabel(item)}) watched at ${item.watchedAt}`;
}

function sampleForItem(item: TransformedHistoryItem): SyncAuditSample {
  return {
    traktHistoryId: item.traktHistoryId,
    title: titleFromSource(item.source, item),
    media: mediaLabel(item),
    watchedAt: item.watchedAt,
  };
}

function sampleForRawItem(item: TraktHistoryItem, reason: string): SyncAuditSample {
  const fallback: TransformedHistoryItem = {
    kind: 'ok',
    traktHistoryId: item.id,
    mediaType: item.type === 'movie' ? 'movie' : 'tv',
    tmdbId: readNumber(readIdsFromRaw(item).tmdb) ?? 0,
    season: readNumber(readRecord(item.episode).season),
    episode: readNumber(readRecord(item.episode).number),
    watchedAt: item.watched_at,
    action: typeof item.action === 'string' ? item.action : null,
    source: item,
  };
  return {
    ...sampleForItem(fallback),
    reason,
  };
}

function sampleForMappedChange(
  item: TransformedHistoryItem,
  actual: PublicMetaDBWatchedItem,
): SyncAuditMappedChangeSample {
  return {
    ...sampleForItem(item),
    publicMetaDBId: actual.id,
    actualMedia: mediaLabelFromPublicMetaDB(actual),
    actualWatchedAt: actual.watched_at,
  };
}

function pushSample(samples: SyncAuditSample[], sample: SyncAuditSample): void {
  if (samples.length < AUDIT_SAMPLE_LIMIT) {
    samples.push(sample);
  }
}

function describeRawHistoryItem(item: TraktHistoryItem): string {
  const fallback: TransformedHistoryItem = {
    kind: 'ok',
    traktHistoryId: item.id,
    mediaType: item.type === 'movie' ? 'movie' : 'tv',
    tmdbId: readNumber(readIdsFromRaw(item).tmdb) ?? 0,
    season: readNumber(readRecord(item.episode).season),
    episode: readNumber(readRecord(item.episode).number),
    watchedAt: item.watched_at,
    action: typeof item.action === 'string' ? item.action : null,
    source: item,
  };
  return describeHistoryItem(fallback);
}

function describeSyncRow(row: SyncEntryRow): string {
  const source = parseSourcePayload(row.source_payload);
  const item: TransformedHistoryItem = {
    kind: 'ok',
    traktHistoryId: row.trakt_history_id,
    mediaType: row.media_type ?? 'movie',
    tmdbId: row.tmdb_id ?? 0,
    season: row.season,
    episode: row.episode,
    watchedAt: row.watched_at ?? 'unknown time',
    action: row.action,
    source,
  };
  return describeHistoryItem(item);
}

function titleFromSource(source: TraktHistoryItem, item: TransformedHistoryItem): string {
  const movie = readRecord(source.movie);
  const show = readRecord(source.show);
  const episode = readRecord(source.episode);
  const movieTitle = readString(movie.title);
  const showTitle = readString(show.title);
  const episodeTitle = readString(episode.title);

  if (item.mediaType === 'movie') {
    return movieTitle ?? `Movie ${item.tmdbId}`;
  }
  if (showTitle && episodeTitle) {
    return `${showTitle} - ${episodeTitle}`;
  }
  return showTitle ?? `TV ${item.tmdbId}`;
}

function mediaLabel(input: Pick<TransformedHistoryItem, 'mediaType' | 'tmdbId' | 'season' | 'episode'>): string {
  if (input.mediaType === 'movie') {
    return `movie tmdb:${input.tmdbId}`;
  }

  const episode = input.season === null || input.episode === null
    ? ''
    : ` S${input.season}E${input.episode}`;
  return `tv tmdb:${input.tmdbId}${episode}`;
}

function mediaLabelFromPublicMetaDB(item: PublicMetaDBWatchedItem): string {
  if (item.media_type === 'movie') {
    return `movie tmdb:${item.tmdb_id}`;
  }

  const episode = item.season === null || item.season === undefined || item.episode === null || item.episode === undefined
    ? ''
    : ` S${item.season}E${item.episode}`;
  return `tv tmdb:${item.tmdb_id}${episode}`;
}

function describePublicMetaDBItem(item: PublicMetaDBWatchedItem): string {
  return `${mediaLabelFromPublicMetaDB(item)} watched at ${item.watched_at ?? 'null'}`;
}

function indexPublicMetaDBById(items: PublicMetaDBWatchedItem[]): Map<string, PublicMetaDBWatchedItem> {
  return new Map(items.map((item) => [item.id, item]));
}

function indexSyncRowsByHistoryId(rows: SyncEntryRow[]): Map<number, SyncEntryRow> {
  return new Map(rows.map((row) => [row.trakt_history_id, row]));
}

function mappedPublicMetaDBIds(rows: SyncEntryRow[]): string[] {
  return rows
    .map((row) => activePublicMetaDBId(row))
    .filter((id): id is string => id !== null);
}

function activePublicMetaDBId(row: SyncEntryRow | undefined): string | null {
  if (!row || row.sync_status !== 'synced') {
    return null;
  }
  return row.publicmetadb_id;
}

function publicMetaDBItemMatches(item: PublicMetaDBWatchedItem, expected: TransformedHistoryItem): boolean {
  return watchedKey(publicMetaDBKeyInput(item)) === watchedKey(transformedKeyInput(expected));
}

function samePublicMetaDBTarget(item: PublicMetaDBWatchedItem, expected: TransformedHistoryItem): boolean {
  return watchedTargetKey(publicMetaDBKeyInput(item)) === watchedTargetKey(transformedKeyInput(expected));
}

function parseSourcePayload(payload: string | null): TraktHistoryItem {
  if (!payload) {
    return { id: 0, type: 'unknown', watched_at: 'unknown time' };
  }
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === 'object') {
      return parsed as TraktHistoryItem;
    }
  } catch {
    // Fall through to a minimal placeholder so deletion logs still explain the row.
  }
  return { id: 0, type: 'unknown', watched_at: 'unknown time' };
}

function readIdsFromRaw(item: TraktHistoryItem): Record<string, unknown> {
  if (item.type === 'movie') {
    return readRecord(readRecord(item.movie).ids);
  }
  return readRecord(readRecord(item.show).ids);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

class AdoptionIndex {
  private readonly entries = new Map<string, PublicMetaDBWatchedItem[]>();
  private readonly used = new Set<string>();

  constructor(items: PublicMetaDBWatchedItem[], usedIds: Iterable<string> = []) {
    for (const id of usedIds) {
      this.used.add(id);
    }

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

  markUsed(id: string | null | undefined): void {
    if (id) {
      this.used.add(id);
    }
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
    watchedTargetKey(input),
    normalizeTimestamp(input.watchedAt),
  ].join('|');
}

function watchedTargetKey(input: {
  mediaType: string;
  tmdbId: number;
  season: number | null;
  episode: number | null;
}): string {
  const season = input.mediaType === 'movie' ? '' : input.season ?? '';
  const episode = input.mediaType === 'movie' ? '' : input.episode ?? '';
  return [
    input.mediaType,
    input.tmdbId,
    season,
    episode,
  ].join('|');
}

function publicMetaDBKeyInput(item: PublicMetaDBWatchedItem) {
  return {
    mediaType: item.media_type,
    tmdbId: item.tmdb_id,
    season: item.season ?? null,
    episode: item.episode ?? null,
    watchedAt: item.watched_at,
  };
}

function transformedKeyInput(item: TransformedHistoryItem) {
  return {
    mediaType: item.mediaType,
    tmdbId: item.tmdbId,
    season: item.season,
    episode: item.episode,
    watchedAt: item.watchedAt,
  };
}

function normalizeTimestamp(value: string | null): string {
  if (value === null) {
    return 'null';
  }
  const trimmed = value.trim();
  const parsed = Date.parse(canonicalizeExplicitOffsetTimestamp(trimmed) ?? trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : trimmed;
}

function canonicalizeExplicitOffsetTimestamp(value: string): string | null {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i);
  if (!match) {
    return null;
  }

  const zone = match[4].toUpperCase() === 'Z'
    ? 'Z'
    : match[4].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  return `${match[1]}T${match[2]}${match[3] ?? ''}${zone}`;
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
