export type AppConfig = {
  traktClientId: string;
  traktClientSecret: string;
  traktRedirectUri: string;
  publicMetaDBApiKey: string;
  mdbListApiKey?: string;
  traktBaseUrl: string;
  publicMetaDBBaseUrl: string;
  mdbListBaseUrl: string;
  databasePath: string;
  pollIntervalSeconds: number;
  port: number;
  traktPageLimit: number;
  historyOverlapMinutes: number;
  reconcileIntervalHours: number;
  runBackfillOnStart: boolean;
  mdbListWatchlistSyncEnabled: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mdbListWatchlistSyncEnabled = readBoolean(env.MDBLIST_WATCHLIST_SYNC_ENABLED, false);

  return {
    traktClientId: readRequired(env, 'TRAKT_CLIENT_ID'),
    traktClientSecret: readRequired(env, 'TRAKT_CLIENT_SECRET'),
    traktRedirectUri: env.TRAKT_REDIRECT_URI ?? 'urn:ietf:wg:oauth:2.0:oob',
    publicMetaDBApiKey: readRequired(env, 'PUBLICMETADB_API_KEY'),
    mdbListApiKey: mdbListWatchlistSyncEnabled ? readRequired(env, 'MDBLIST_API_KEY') : env.MDBLIST_API_KEY,
    traktBaseUrl: env.TRAKT_BASE_URL ?? 'https://api.trakt.tv',
    publicMetaDBBaseUrl: env.PUBLICMETADB_BASE_URL ?? 'https://publicmetadb.com',
    mdbListBaseUrl: env.MDBLIST_BASE_URL ?? 'https://api.mdblist.com',
    databasePath: env.DATABASE_PATH ?? '/data/sync.db',
    pollIntervalSeconds: readNumber(env.POLL_INTERVAL_SECONDS, 60),
    port: readNumber(env.PORT, 3000),
    traktPageLimit: readNumber(env.TRAKT_PAGE_LIMIT, 100),
    historyOverlapMinutes: readNumber(env.HISTORY_OVERLAP_MINUTES, 10),
    reconcileIntervalHours: readNumber(env.RECONCILE_INTERVAL_HOURS, 24),
    runBackfillOnStart: env.RUN_BACKFILL_ON_START !== 'false',
    mdbListWatchlistSyncEnabled,
  };
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): Pick<
  AppConfig,
  'traktClientId' | 'traktClientSecret' | 'traktRedirectUri' | 'traktBaseUrl' | 'databasePath'
> {
  return {
    traktClientId: readRequired(env, 'TRAKT_CLIENT_ID'),
    traktClientSecret: readRequired(env, 'TRAKT_CLIENT_SECRET'),
    traktRedirectUri: env.TRAKT_REDIRECT_URI ?? 'urn:ietf:wg:oauth:2.0:oob',
    traktBaseUrl: env.TRAKT_BASE_URL ?? 'https://api.trakt.tv',
    databasePath: env.DATABASE_PATH ?? '/data/sync.db',
  };
}

function readRequired(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === 'true';
}
