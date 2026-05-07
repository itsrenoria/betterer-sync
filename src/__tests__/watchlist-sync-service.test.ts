import { describe, expect, it } from 'vitest';
import { WatchlistSyncService } from '../sync/watchlist-sync-service.js';
import type {
  MdbListClientLike,
  PublicMetaDBList,
  PublicMetaDBListItem,
  PublicMetaDBWatchlistClientLike,
  WatchlistMediaItem,
} from '../sync/types.js';

class FakeMdbListClient implements MdbListClientLike {
  constructor(private readonly items: WatchlistMediaItem[]) {}

  async getWatchlist(): Promise<WatchlistMediaItem[]> {
    return this.items;
  }
}

class FakePublicMetaDBWatchlistClient implements PublicMetaDBWatchlistClientLike {
  readonly list: PublicMetaDBList = { id: 'lst_watchlist', name: 'My Watchlist', type: 'watchlist' };
  items: PublicMetaDBListItem[] = [];
  failedAdds = new Set<string>();
  failedDeletes = new Set<string>();
  private nextId = 1;

  async getOrCreateWatchlist(): Promise<PublicMetaDBList> {
    return this.list;
  }

  async getAllListItems(): Promise<PublicMetaDBListItem[]> {
    return [...this.items];
  }

  async addListItem(listId: string, item: WatchlistMediaItem): Promise<PublicMetaDBListItem> {
    if (this.failedAdds.has(`${item.mediaType}|${item.tmdbId}`)) {
      throw new Error(`add failed for ${item.mediaType}:${item.tmdbId}`);
    }
    const created = {
      id: `li_${this.nextId++}`,
      list: listId,
      tmdb_id: item.tmdbId,
      media_type: item.mediaType,
    };
    this.items.push(created);
    return created;
  }

  async deleteListItem(_listId: string, itemId: string): Promise<void> {
    if (this.failedDeletes.has(itemId)) {
      throw new Error(`delete failed for ${itemId}`);
    }
    this.items = this.items.filter((item) => item.id !== itemId);
  }
}

describe('WatchlistSyncService', () => {
  it('adds MDBList watchlist items that are missing from PublicMetaDB', async () => {
    const publicMetaDB = new FakePublicMetaDBWatchlistClient();
    const service = serviceWith([
      { tmdbId: 550, mediaType: 'movie' },
      { tmdbId: 1399, mediaType: 'tv' },
    ], publicMetaDB);

    const stats = await service.sync();

    expect(stats.imported).toBe(2);
    expect(stats.deleted).toBe(0);
    expect(publicMetaDB.items).toEqual([
      expect.objectContaining({ tmdb_id: 550, media_type: 'movie' }),
      expect.objectContaining({ tmdb_id: 1399, media_type: 'tv' }),
    ]);
  });

  it('removes PublicMetaDB watchlist items that are absent from MDBList', async () => {
    const publicMetaDB = new FakePublicMetaDBWatchlistClient();
    publicMetaDB.items = [
      { id: 'li_keep', list: 'lst_watchlist', tmdb_id: 550, media_type: 'movie' },
      { id: 'li_delete', list: 'lst_watchlist', tmdb_id: 1399, media_type: 'tv' },
    ];
    const service = serviceWith([{ tmdbId: 550, mediaType: 'movie' }], publicMetaDB);

    const stats = await service.sync();

    expect(stats.deleted).toBe(1);
    expect(publicMetaDB.items).toEqual([
      expect.objectContaining({ id: 'li_keep' }),
    ]);
  });

  it('skips existing matching PublicMetaDB watchlist items', async () => {
    const publicMetaDB = new FakePublicMetaDBWatchlistClient();
    publicMetaDB.items = [
      { id: 'li_existing', list: 'lst_watchlist', tmdb_id: 550, media_type: 'movie' },
    ];
    const service = serviceWith([{ tmdbId: 550, mediaType: 'movie' }], publicMetaDB);

    const stats = await service.sync();

    expect(stats).toMatchObject({ imported: 0, skipped: 1, deleted: 0, failed: 0 });
    expect(publicMetaDB.items).toHaveLength(1);
  });

  it('deduplicates repeated MDBList rows before adding to PublicMetaDB', async () => {
    const publicMetaDB = new FakePublicMetaDBWatchlistClient();
    const service = serviceWith([
      { tmdbId: 550, mediaType: 'movie' },
      { tmdbId: 550, mediaType: 'movie' },
    ], publicMetaDB);

    const stats = await service.sync();

    expect(stats.imported).toBe(1);
    expect(publicMetaDB.items).toHaveLength(1);
  });

  it('records item mutation failures and continues syncing the remaining items', async () => {
    const publicMetaDB = new FakePublicMetaDBWatchlistClient();
    publicMetaDB.items = [
      { id: 'li_delete', list: 'lst_watchlist', tmdb_id: 1399, media_type: 'tv' },
    ];
    publicMetaDB.failedAdds.add('movie|550');
    const service = serviceWith([
      { tmdbId: 550, mediaType: 'movie' },
      { tmdbId: 551, mediaType: 'movie' },
    ], publicMetaDB);

    const stats = await service.sync();

    expect(stats).toMatchObject({ imported: 1, deleted: 1, failed: 1 });
    expect(publicMetaDB.items).toEqual([
      expect.objectContaining({ tmdb_id: 551, media_type: 'movie' }),
    ]);
  });
});

function serviceWith(
  mdbListItems: WatchlistMediaItem[],
  publicMetaDB: FakePublicMetaDBWatchlistClient,
): WatchlistSyncService {
  return new WatchlistSyncService({
    mdbList: new FakeMdbListClient(mdbListItems),
    publicMetaDB,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}
