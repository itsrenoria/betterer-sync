import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

describe('loadConfig MDBList watchlist settings', () => {
  it('keeps MDBList watchlist sync disabled by default without requiring an MDBList key', () => {
    const config = loadConfig(baseEnv());

    expect(config.mdbListWatchlistSyncEnabled).toBe(false);
    expect(config.mdbListApiKey).toBeUndefined();
    expect(config.mdbListBaseUrl).toBe('https://api.mdblist.com');
  });

  it('requires MDBLIST_API_KEY when MDBList watchlist sync is enabled', () => {
    expect(() => loadConfig({
      ...baseEnv(),
      MDBLIST_WATCHLIST_SYNC_ENABLED: 'true',
    })).toThrow('Missing required environment variable MDBLIST_API_KEY');
  });

  it('loads MDBList watchlist sync settings when enabled', () => {
    const config = loadConfig({
      ...baseEnv(),
      MDBLIST_WATCHLIST_SYNC_ENABLED: 'true',
      MDBLIST_API_KEY: 'mdb-key',
      MDBLIST_BASE_URL: 'https://mdb.example.test',
    });

    expect(config.mdbListWatchlistSyncEnabled).toBe(true);
    expect(config.mdbListApiKey).toBe('mdb-key');
    expect(config.mdbListBaseUrl).toBe('https://mdb.example.test');
  });
});

function baseEnv(): NodeJS.ProcessEnv {
  return {
    TRAKT_CLIENT_ID: 'trakt-client',
    TRAKT_CLIENT_SECRET: 'trakt-secret',
    PUBLICMETADB_API_KEY: 'pm-key',
  };
}
