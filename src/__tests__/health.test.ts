import { describe, expect, it } from 'vitest';
import { HealthState } from '../server/health.js';

describe('HealthState', () => {
  it('reports unhealthy after a failed run and includes concise counters', () => {
    const health = new HealthState();

    health.recordRun({
      ok: false,
      imported: 2,
      adopted: 1,
      updated: 0,
      skipped: 3,
      retried: 4,
      failed: 1,
      deleted: 0,
      error: 'boom',
    });

    expect(health.snapshot()).toMatchObject({
      ok: false,
      lastRun: expect.objectContaining({
        imported: 2,
        retried: 4,
        failed: 1,
        error: 'boom',
      }),
    });
  });
});
