import { createDatabase } from './storage/database.js';
import { loadAuthConfig, loadConfig } from './config.js';
import { TraktClient } from './clients/trakt.js';
import { PublicMetaDBClient } from './clients/publicmetadb.js';
import { MDBListClient } from './clients/mdblist.js';
import { SyncService } from './sync/sync-service.js';
import { WatchlistSyncService } from './sync/watchlist-sync-service.js';
import { HealthState, startHealthServer } from './server/health.js';
import { logger } from './logger.js';
import type { SyncStats } from './sync/types.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'serve';

  if (command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (command === 'auth') {
    await runAuth();
    return;
  }

  if (command === 'backfill') {
    await withService(async (service) => {
      const stats = await service.backfill();
      logger.info('backfill finished', stats);
    });
    return;
  }

  if (command === 'reconcile') {
    await withService(async (service) => {
      const stats = await service.reconcile();
      logger.info('reconcile finished', stats);
    });
    return;
  }

  if (command === 'audit') {
    await withService(async (service) => {
      await service.audit();
    });
    return;
  }

  if (command === 'sync-watchlist') {
    const config = loadConfig();
    const service = makeWatchlistService(config);
    const stats = await service.sync();
    logger.info('watchlist sync finished', stats);
    return;
  }

  if (command === 'serve') {
    await runServe();
    return;
  }

  printUsage();
  process.exitCode = 1;
}

async function runAuth(): Promise<void> {
  const config = loadAuthConfig();
  const db = createDatabase(config.databasePath);
  const trakt = new TraktClient({
    baseUrl: config.traktBaseUrl,
    clientId: config.traktClientId,
    clientSecret: config.traktClientSecret,
    redirectUri: config.traktRedirectUri,
    db,
    logger,
  });

  try {
    await trakt.authenticateDeviceFlow((code) => {
      logger.info('authorize Trakt device code', {
        verificationUrl: code.verification_url,
        userCode: code.user_code,
        expiresInSeconds: code.expires_in,
      });
      console.log(`Open ${code.verification_url} and enter code ${code.user_code}`);
    });
    logger.info('Trakt authorization saved');
  } finally {
    db.close();
  }
}

async function runServe(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  const service = makeService(config, db);
  const watchlistService = config.mdbListWatchlistSyncEnabled
    ? makeWatchlistService(config)
    : null;
  const health = new HealthState();
  const server = startHealthServer(health, config.port);
  let running = false;
  let shuttingDown = false;

  const run = async (label: string, task: () => Promise<SyncStats>) => {
    if (running || shuttingDown) {
      return;
    }
    running = true;
    try {
      logger.info(`${label} starting`);
      const stats = await task();
      health.recordRun({ ok: true, ...stats });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${label} failed`, { error: message });
      health.recordRun({ ok: false, error: message, ...zeroStats() });
    } finally {
      running = false;
    }
  };

  logger.info('health server listening', { port: config.port });
  if (config.runBackfillOnStart || watchlistService) {
    await run('startup sync', async () => combineStats([
      config.runBackfillOnStart ? await service.backfill() : zeroStats(),
      watchlistService ? await watchlistService.sync() : zeroStats(),
    ]));
  }

  const pollTimer = setInterval(() => {
    void run('poll sync', async () => combineStats([
      await service.syncRecent(config.historyOverlapMinutes),
      watchlistService ? await watchlistService.sync() : zeroStats(),
    ]));
  }, config.pollIntervalSeconds * 1000);

  const reconcileTimer = setInterval(() => {
    void run('full reconciliation', () => service.reconcile());
  }, config.reconcileIntervalHours * 60 * 60 * 1000);

  const shutdown = () => {
    shuttingDown = true;
    clearInterval(pollTimer);
    clearInterval(reconcileTimer);
    server.close(() => {
      db.close();
      logger.info('shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function withService(callback: (service: SyncService) => Promise<void>): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  const service = makeService(config, db);
  try {
    await callback(service);
  } finally {
    db.close();
  }
}

function makeService(config: ReturnType<typeof loadConfig>, db: ReturnType<typeof createDatabase>): SyncService {
  const trakt = new TraktClient({
    baseUrl: config.traktBaseUrl,
    clientId: config.traktClientId,
    clientSecret: config.traktClientSecret,
    redirectUri: config.traktRedirectUri,
    db,
    logger,
  });
  const publicMetaDB = new PublicMetaDBClient({
    baseUrl: config.publicMetaDBBaseUrl,
    apiKey: config.publicMetaDBApiKey,
  });

  return new SyncService({
    db,
    trakt,
    publicMetaDB,
    logger,
    pageLimit: config.traktPageLimit,
  });
}

function makeWatchlistService(config: ReturnType<typeof loadConfig>): WatchlistSyncService {
  if (!config.mdbListApiKey) {
    throw new Error('Missing required environment variable MDBLIST_API_KEY');
  }

  return new WatchlistSyncService({
    mdbList: new MDBListClient({
      baseUrl: config.mdbListBaseUrl,
      apiKey: config.mdbListApiKey,
      logger,
    }),
    publicMetaDB: new PublicMetaDBClient({
      baseUrl: config.publicMetaDBBaseUrl,
      apiKey: config.publicMetaDBApiKey,
    }),
    logger,
  });
}

function combineStats(statsList: SyncStats[]): SyncStats {
  return statsList.reduce((combined, stats) => ({
    imported: combined.imported + stats.imported,
    adopted: combined.adopted + stats.adopted,
    updated: combined.updated + stats.updated,
    skipped: combined.skipped + stats.skipped,
    retried: combined.retried + stats.retried,
    failed: combined.failed + stats.failed,
    deleted: combined.deleted + stats.deleted,
  }), zeroStats());
}

function zeroStats(): SyncStats {
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

function printUsage(): void {
  console.log(`Usage: betterer-sync <command>

Commands:
  auth       Authorize Trakt with device code flow and save tokens
  backfill   Import all Trakt watch history into PublicMetaDB
  reconcile  Run a full mirror reconciliation
  audit      Compare Trakt, local sync state, and PublicMetaDB without changing anything
  sync-watchlist
             Mirror MDBList watchlist into PublicMetaDB watchlist
  serve      Run startup backfill, polling sync, reconciliation, and /healthz
`);
}

main().catch((error) => {
  logger.error('fatal error', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
