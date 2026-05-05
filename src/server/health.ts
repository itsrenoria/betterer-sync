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

    if (path === '/' || path === '/index.html') {
      const snapshot = state.snapshot();
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(renderHealthDashboard(snapshot));
      return;
    }

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

export function renderHealthDashboard(snapshot: HealthSnapshot): string {
  const lastRun = snapshot.lastRun;
  const stats: Array<[keyof SyncStats, string]> = [
    ['imported', 'Imported'],
    ['adopted', 'Adopted'],
    ['updated', 'Updated'],
    ['skipped', 'Skipped'],
    ['retried', 'Retried'],
    ['failed', 'Failed'],
    ['deleted', 'Deleted'],
  ];

  const statCards = stats.map(([key, label]) => `
        <article class="stat">
          <span>${label}</span>
          <strong data-stat="${key}">${lastRun?.[key] ?? 0}</strong>
        </article>`).join('');

  const statusText = snapshot.ok ? 'Healthy' : 'Needs Attention';
  const finishedAt = lastRun?.finishedAt ?? 'No run completed yet';
  const startedAt = snapshot.startedAt;
  const error = lastRun?.error
    ? `<section class="alert"><span>Last error</span><p>${escapeHtml(lastRun.error)}</p></section>`
    : '';
  const snapshotJson = escapeHtml(JSON.stringify(snapshot, null, 2));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Betterer Sync Status</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d0f0e;
      --panel: #151815;
      --line: #2c342d;
      --ink: #f0f4e8;
      --muted: #8e9b8d;
      --good: #8ccf7e;
      --warn: #f0b86a;
      --bad: #ff746c;
      --accent: #d9ff73;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(90deg, rgba(217,255,115,.05) 1px, transparent 1px) 0 0 / 44px 44px,
        linear-gradient(rgba(217,255,115,.035) 1px, transparent 1px) 0 0 / 44px 44px,
        radial-gradient(circle at 80% 10%, rgba(140,207,126,.16), transparent 30rem),
        var(--bg);
      color: var(--ink);
      font-family: ui-monospace, "SFMono-Regular", "Cascadia Code", "Liberation Mono", Menlo, monospace;
      letter-spacing: 0;
    }
    main {
      width: min(1100px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 48px 0;
    }
    header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 24px;
      align-items: end;
      padding-bottom: 28px;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0;
      font-size: clamp(2rem, 6vw, 4.8rem);
      line-height: .9;
      font-weight: 900;
      text-transform: uppercase;
    }
    .kicker {
      margin: 0 0 14px;
      color: var(--accent);
      font-size: .78rem;
      text-transform: uppercase;
    }
    .status {
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--panel) 88%, transparent);
      padding: 18px;
      min-width: 230px;
    }
    .status span, .stat span, .meta span, .alert span {
      display: block;
      color: var(--muted);
      font-size: .72rem;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .status strong {
      color: ${snapshot.ok ? 'var(--good)' : 'var(--bad)'};
      font-size: 1.35rem;
      text-transform: uppercase;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 10px;
      margin: 24px 0;
    }
    .stat, .meta, .alert, pre {
      border: 1px solid var(--line);
      background: rgba(21, 24, 21, .82);
    }
    .stat {
      min-height: 116px;
      padding: 16px;
    }
    .stat strong {
      display: block;
      font-size: clamp(1.8rem, 4vw, 3rem);
      line-height: 1;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-bottom: 24px;
    }
    .meta, .alert {
      padding: 16px;
      overflow-wrap: anywhere;
    }
    .meta strong, .alert p {
      margin: 0;
      color: var(--ink);
      font-size: .95rem;
    }
    .alert {
      border-color: color-mix(in srgb, var(--bad) 45%, var(--line));
      margin-bottom: 24px;
    }
    pre {
      margin: 0;
      padding: 18px;
      overflow: auto;
      color: #cbd6c5;
      font-size: .82rem;
      line-height: 1.55;
    }
    a {
      color: var(--accent);
      text-decoration: none;
    }
    @media (max-width: 860px) {
      header, .meta-grid { grid-template-columns: 1fr; }
      .grid { grid-template-columns: repeat(2, 1fr); }
      .status { min-width: 0; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <p class="kicker">Trakt -> PublicMetaDB</p>
        <h1>Betterer Sync</h1>
      </div>
      <section class="status">
        <span>Service</span>
        <strong>${statusText}</strong>
      </section>
    </header>
    <section class="grid">
${statCards}
    </section>
    <section class="meta-grid">
      <article class="meta"><span>Started</span><strong>${escapeHtml(startedAt)}</strong></article>
      <article class="meta"><span>Last Run</span><strong>${escapeHtml(finishedAt)}</strong></article>
      <article class="meta"><span>Machine Endpoint</span><strong><a href="/healthz">/healthz</a></strong></article>
    </section>
    ${error}
    <pre id="snapshot">${snapshotJson}</pre>
  </main>
  <script>
    async function refresh() {
      try {
        const response = await fetch('/healthz', { cache: 'no-store' });
        const data = await response.json();
        document.querySelector('.status strong').textContent = data.ok ? 'Healthy' : 'Needs Attention';
        document.querySelector('#snapshot').textContent = JSON.stringify(data, null, 2);
        const run = data.lastRun || {};
        for (const key of ['imported','adopted','updated','skipped','retried','failed','deleted']) {
          const el = document.querySelector('[data-stat="' + key + '"]');
          if (el) el.textContent = run[key] ?? 0;
        }
      } catch {}
    }
    setInterval(refresh, 10000);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
