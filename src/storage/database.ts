import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { MediaType, TransformedHistoryItem } from '../sync/types.js';

export type SyncEntryRow = {
  trakt_history_id: number;
  publicmetadb_id: string | null;
  media_type: MediaType | null;
  tmdb_id: number | null;
  season: number | null;
  episode: number | null;
  watched_at: string | null;
  action: string | null;
  source_payload: string | null;
  sync_status: 'synced' | 'retry' | 'failed' | 'deleted';
  error_message: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

export type StoredToken = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string;
  expires_at: number;
};

export function createDatabase(path: string): SyncDatabase {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  migrate(sqlite);
  return new SyncDatabase(sqlite);
}

export class SyncDatabase {
  constructor(private readonly sqlite: Database.Database) {}

  close(): void {
    this.sqlite.close();
  }

  upsertSyncedEntry(item: TransformedHistoryItem, publicmetadbId: string): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO sync_entries (
        trakt_history_id, publicmetadb_id, media_type, tmdb_id, season, episode,
        watched_at, action, source_payload, sync_status, error_message,
        last_seen_at, created_at, updated_at
      )
      VALUES (
        @trakt_history_id, @publicmetadb_id, @media_type, @tmdb_id, @season, @episode,
        @watched_at, @action, @source_payload, 'synced', NULL,
        @last_seen_at, @created_at, @updated_at
      )
      ON CONFLICT(trakt_history_id) DO UPDATE SET
        publicmetadb_id = excluded.publicmetadb_id,
        media_type = excluded.media_type,
        tmdb_id = excluded.tmdb_id,
        season = excluded.season,
        episode = excluded.episode,
        watched_at = excluded.watched_at,
        action = excluded.action,
        source_payload = excluded.source_payload,
        sync_status = 'synced',
        error_message = NULL,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `).run({
      trakt_history_id: item.traktHistoryId,
      publicmetadb_id: publicmetadbId,
      media_type: item.mediaType,
      tmdb_id: item.tmdbId,
      season: item.season,
      episode: item.episode,
      watched_at: item.watchedAt,
      action: item.action,
      source_payload: JSON.stringify(item.source),
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    });
  }

  markSeen(traktHistoryId: number): void {
    this.sqlite.prepare(`
      UPDATE sync_entries
      SET last_seen_at = @now, updated_at = @now
      WHERE trakt_history_id = @traktHistoryId
    `).run({ traktHistoryId, now: new Date().toISOString() });
  }

  markRetry(traktHistoryId: number, source: unknown, errorMessage: string): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO sync_entries (
        trakt_history_id, publicmetadb_id, sync_status, error_message,
        source_payload, last_seen_at, created_at, updated_at
      )
      VALUES (@traktHistoryId, NULL, 'retry', @errorMessage, @sourcePayload, @now, @now, @now)
      ON CONFLICT(trakt_history_id) DO UPDATE SET
        sync_status = 'retry',
        error_message = excluded.error_message,
        source_payload = excluded.source_payload,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `).run({
      traktHistoryId,
      errorMessage,
      sourcePayload: JSON.stringify(source),
      now,
    });
  }

  markFailed(item: TransformedHistoryItem, errorMessage: string): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO sync_entries (
        trakt_history_id, publicmetadb_id, media_type, tmdb_id, season, episode,
        watched_at, action, source_payload, sync_status, error_message,
        last_seen_at, created_at, updated_at
      )
      VALUES (
        @trakt_history_id, NULL, @media_type, @tmdb_id, @season, @episode,
        @watched_at, @action, @source_payload, 'failed', @error_message,
        @last_seen_at, @created_at, @updated_at
      )
      ON CONFLICT(trakt_history_id) DO UPDATE SET
        media_type = excluded.media_type,
        tmdb_id = excluded.tmdb_id,
        season = excluded.season,
        episode = excluded.episode,
        watched_at = excluded.watched_at,
        action = excluded.action,
        source_payload = excluded.source_payload,
        sync_status = 'failed',
        error_message = excluded.error_message,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `).run({
      trakt_history_id: item.traktHistoryId,
      media_type: item.mediaType,
      tmdb_id: item.tmdbId,
      season: item.season,
      episode: item.episode,
      watched_at: item.watchedAt,
      action: item.action,
      source_payload: JSON.stringify(item.source),
      error_message: errorMessage,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    });
  }

  markDeleted(traktHistoryId: number): void {
    this.sqlite.prepare(`
      UPDATE sync_entries
      SET sync_status = 'deleted', updated_at = @now
      WHERE trakt_history_id = @traktHistoryId
    `).run({ traktHistoryId, now: new Date().toISOString() });
  }

  getSyncEntry(traktHistoryId: number): SyncEntryRow | undefined {
    return this.sqlite.prepare(`
      SELECT * FROM sync_entries WHERE trakt_history_id = ?
    `).get(traktHistoryId) as SyncEntryRow | undefined;
  }

  listSyncEntries(): SyncEntryRow[] {
    return this.sqlite.prepare(`
      SELECT * FROM sync_entries ORDER BY trakt_history_id
    `).all() as SyncEntryRow[];
  }

  listActiveSyncedEntries(): SyncEntryRow[] {
    return this.sqlite.prepare(`
      SELECT * FROM sync_entries
      WHERE sync_status = 'synced' AND publicmetadb_id IS NOT NULL
      ORDER BY trakt_history_id
    `).all() as SyncEntryRow[];
  }

  saveToken(token: StoredToken): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO auth_tokens (
        id, access_token, refresh_token, token_type, scope, expires_at, created_at, updated_at
      )
      VALUES (1, @access_token, @refresh_token, @token_type, @scope, @expires_at, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        token_type = excluded.token_type,
        scope = excluded.scope,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run({ ...token, now });
  }

  getToken(): StoredToken | undefined {
    return this.sqlite.prepare(`
      SELECT access_token, refresh_token, token_type, scope, expires_at
      FROM auth_tokens
      WHERE id = 1
    `).get() as StoredToken | undefined;
  }

  setState(key: string, value: string): void {
    this.sqlite.prepare(`
      INSERT INTO sync_state (key, value, updated_at)
      VALUES (@key, @value, @now)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run({ key, value, now: new Date().toISOString() });
  }

  getState(key: string): string | undefined {
    const row = this.sqlite.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }
}

function migrate(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sync_entries (
      trakt_history_id INTEGER PRIMARY KEY,
      publicmetadb_id TEXT,
      media_type TEXT,
      tmdb_id INTEGER,
      season INTEGER,
      episode INTEGER,
      watched_at TEXT,
      action TEXT,
      source_payload TEXT,
      sync_status TEXT NOT NULL DEFAULT 'retry',
      error_message TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sync_entries_publicmetadb_id
      ON sync_entries(publicmetadb_id);

    CREATE INDEX IF NOT EXISTS idx_sync_entries_status
      ON sync_entries(sync_status);

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}
