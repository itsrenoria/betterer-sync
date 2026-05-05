import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger.js';

describe('logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_FORMAT;
  });

  it('writes human-readable text logs by default for Dozzle', () => {
    delete process.env.LOG_FORMAT;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info('Added to PublicMetaDB: Movie (movie tmdb:550) watched at 2026-05-05T12:00:00Z', {
      traktHistoryId: 42,
      publicMetaDBId: 'pm_42',
    });

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0]?.[0] ?? '';
    expect(line).toContain('INFO');
    expect(line).toContain('Added to PublicMetaDB: Movie');
    expect(line).toContain('traktHistoryId=42');
    expect(line).toContain('publicMetaDBId=pm_42');
    expect(() => JSON.parse(line)).toThrow();
  });

  it('can still write JSON logs when LOG_FORMAT=json', () => {
    process.env.LOG_FORMAT = 'json';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info('recent sync complete', { imported: 1 });

    const line = log.mock.calls[0]?.[0] ?? '';
    expect(JSON.parse(line)).toMatchObject({
      level: 'info',
      message: 'recent sync complete',
      meta: { imported: 1 },
    });
  });
});
