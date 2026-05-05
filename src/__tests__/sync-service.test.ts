import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../storage/database.js';
import { SyncService } from '../sync/sync-service.js';
import type { PublicMetaDBClientLike, TraktClientLike } from '../sync/types.js';

class FakeTraktClient implements TraktClientLike {
  history: any[] = [];

  async *getHistory(_options?: { startAt?: string; limit?: number }): AsyncGenerator<any[]> {
    yield this.history;
  }
}

class FakePublicMetaDBClient implements PublicMetaDBClientLike {
  watched: any[] = [];
  private nextId = 1;

  async getAllWatched(): Promise<any[]> {
    return [...this.watched];
  }

  async createWatched(input: any): Promise<any> {
    const item = { id: `pm_${this.nextId++}`, ...input };
    this.watched.push(item);
    return item;
  }

  async patchWatched(id: string, input: { watched_at: string | null }): Promise<any> {
    const item = this.watched.find((entry) => entry.id === id);
    if (!item) {
      const error = new Error('Not found') as Error & { status?: number };
      error.status = 404;
      throw error;
    }
    item.watched_at = input.watched_at;
    return item;
  }

  async deleteWatched(id: string): Promise<void> {
    this.watched = this.watched.filter((entry) => entry.id !== id);
  }

  async lookupTmdbId(): Promise<number | null> {
    return null;
  }
}

describe('SyncService', () => {
  let dir: string;
  let dbPath: string;
  let db: ReturnType<typeof createDatabase>;
  let trakt: FakeTraktClient;
  let publicMetaDB: FakePublicMetaDBClient;
  let service: SyncService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'betterer-sync-'));
    dbPath = join(dir, 'sync.db');
    db = createDatabase(dbPath);
    trakt = new FakeTraktClient();
    publicMetaDB = new FakePublicMetaDBClient();
    service = new SyncService({ db, trakt, publicMetaDB, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent when the same Trakt play is synced twice', async () => {
    trakt.history = [
      movie(1, 550, '2024-03-10T08:15:00Z'),
    ];

    await service.backfill();
    await service.backfill();

    expect(publicMetaDB.watched).toHaveLength(1);
    expect(db.listSyncEntries()).toHaveLength(1);
    expect(db.getSyncEntry(1)?.publicmetadb_id).toBe('pm_1');
  });

  it('creates separate PublicMetaDB plays for Trakt rewatches', async () => {
    trakt.history = [
      movie(1, 550, '2024-03-10T08:15:00Z'),
      movie(2, 550, '2024-03-11T08:15:00Z'),
    ];

    await service.backfill();

    expect(publicMetaDB.watched).toEqual([
      expect.objectContaining({ tmdb_id: 550, watched_at: '2024-03-10T08:15:00Z' }),
      expect.objectContaining({ tmdb_id: 550, watched_at: '2024-03-11T08:15:00Z' }),
    ]);
  });

  it('adopts an exact existing PublicMetaDB play instead of duplicating it', async () => {
    publicMetaDB.watched = [
      { id: 'manual-but-exact', tmdb_id: 550, media_type: 'movie', season: null, episode: null, watched_at: '2024-03-10T08:15:00Z' },
    ];
    trakt.history = [movie(1, 550, '2024-03-10T08:15:00Z')];

    await service.backfill();

    expect(publicMetaDB.watched).toHaveLength(1);
    expect(db.getSyncEntry(1)?.publicmetadb_id).toBe('manual-but-exact');
  });

  it('patches PublicMetaDB when a synced Trakt timestamp changes', async () => {
    trakt.history = [movie(1, 550, '2024-03-10T08:15:00Z')];
    await service.backfill();

    trakt.history = [movie(1, 550, '2024-03-12T08:15:00Z')];
    await service.backfill();

    expect(publicMetaDB.watched[0].watched_at).toBe('2024-03-12T08:15:00Z');
    expect(db.getSyncEntry(1)?.watched_at).toBe('2024-03-12T08:15:00Z');
  });

  it('deletes only Trakt-owned PublicMetaDB plays during reconciliation', async () => {
    trakt.history = [movie(1, 550, '2024-03-10T08:15:00Z')];
    publicMetaDB.watched = [
      { id: 'manual', tmdb_id: 551, media_type: 'movie', season: null, episode: null, watched_at: '2024-01-01T00:00:00Z' },
    ];
    await service.backfill();

    trakt.history = [];
    await service.reconcile();

    expect(publicMetaDB.watched).toEqual([
      expect.objectContaining({ id: 'manual' }),
    ]);
    expect(db.getSyncEntry(1)?.sync_status).toBe('deleted');
  });

  it('recreates a synced PublicMetaDB play if it was manually deleted but still exists in Trakt', async () => {
    trakt.history = [movie(1, 550, '2024-03-10T08:15:00Z')];
    await service.backfill();
    publicMetaDB.watched = [];

    await service.reconcile();

    expect(publicMetaDB.watched).toHaveLength(1);
    expect(db.getSyncEntry(1)?.publicmetadb_id).toBe('pm_2');
  });
});

function movie(id: number, tmdb: number, watchedAt: string) {
  return {
    id,
    type: 'movie',
    watched_at: watchedAt,
    action: 'watch',
    movie: { ids: { trakt: id + 1000, tmdb } },
  };
}
