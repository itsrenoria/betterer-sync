import { describe, expect, it } from 'vitest';
import { type AddressInfo } from 'node:net';
import { HealthState, startHealthServer } from '../server/health.js';

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

  it('keeps the root page closed while healthz remains available', async () => {
    const health = new HealthState();
    health.recordRun({
      ok: true,
      imported: 1499,
      adopted: 1,
      updated: 0,
      skipped: 299,
      retried: 0,
      failed: 0,
      deleted: 0,
    });

    const server = startHealthServer(health, 0);
    const port = (server.address() as AddressInfo).port;

    try {
      const root = await fetch(`http://127.0.0.1:${port}/`);
      const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);

      expect(root.status).toBe(404);
      expect(await root.json()).toEqual({ ok: false, error: 'not found' });
      expect(healthz.status).toBe(200);
      expect(await healthz.json()).toMatchObject({ ok: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
