import { createServer, type Server } from 'node:http';
import type { SyncStats } from '../sync/types.js';

export type HealthRun = SyncStats & {
  ok: boolean;
  error?: string;
};

export type HealthSnapshot = {
  ok: boolean;
  startedAt: string;
  lastRun: (HealthRun & { finishedAt: string }) | null;
};

export class HealthState {
  private startedAt = new Date().toISOString();
  private lastRun: (HealthRun & { finishedAt: string }) | null = null;

  recordRun(run: HealthRun): void {
    this.lastRun = {
      ...run,
      finishedAt: new Date().toISOString(),
    };
  }

  snapshot(): HealthSnapshot {
    return {
      ok: this.lastRun?.ok ?? true,
      startedAt: this.startedAt,
      lastRun: this.lastRun,
    };
  }
}

export function startHealthServer(state: HealthState, port: number): Server {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

    if (path !== '/healthz') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }

    const snapshot = state.snapshot();
    response.writeHead(snapshot.ok ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify(snapshot));
  });

  server.listen(port);
  return server;
}
