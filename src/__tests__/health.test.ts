import { describe, expect, it } from 'vitest';
import { HealthState, renderHealthDashboard } from '../server/health.js';

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

  it('renders a human dashboard for the root page while keeping healthz as the data source', () => {
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

    const html = renderHealthDashboard(health.snapshot());

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Betterer Sync');
    expect(html).toContain('/healthz');
    expect(html).toContain('data-stat="imported"');
    expect(html).toContain('1499');
  });
});
