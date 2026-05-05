import { createServer, type Server } from 'node:http';
import type { SyncStats } from '../sync/types.js';

export type HealthRun = SyncStats & {
  ok: boolean;
  error?: string;
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

  snapshot(): { ok: boolean; startedAt: string; lastRun: (HealthRun & { finishedAt: string }) | null } {
    return {
      ok: this.lastRun?.ok ?? true,
      startedAt: this.startedAt,
      lastRun: this.lastRun,
    };
  }
}

export function startHealthServer(state: HealthState, port: number): Server {
  const server = createServer((request, response) => {
    if (request.url !== '/healthz') {
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
