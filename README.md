# Betterer Sync

One-way sync from Trakt watch history to PublicMetaDB, with optional MDBList
watchlist mirroring.

It preserves Trakt timestamps and rewatches, updates changed plays, and deletes
only PublicMetaDB history rows that it created or safely adopted. Ratings,
progress, lists, and PublicMetaDB-to-Trakt changes are not synced.

## Run with Docker

Create `.env` from the example and add your Trakt and PublicMetaDB credentials:

```bash
cp .env.example .env
docker compose pull
docker compose run --rm betterer-sync auth
```

Complete the printed Trakt authorization flow, then run the service:

```bash
docker compose up -d
curl http://localhost:3000/healthz
```

Compose pulls the public `ghcr.io/itsrenoria/betterer-sync:latest` image for
`linux/amd64` or `linux/arm64`. Authentication and sync state persist in the
`betterer-sync-data` Docker volume.

## Commands

```bash
docker compose run --rm betterer-sync auth
docker compose run --rm betterer-sync backfill
docker compose run --rm betterer-sync reconcile
docker compose run --rm betterer-sync audit
docker compose run --rm betterer-sync sync-watchlist
docker compose up -d
```

`serve` is the default. Startup backfill is enabled unless
`RUN_BACKFILL_ON_START=false`; the service then polls recent Trakt history and
periodically reconciles all history. `audit` is read-only.

## Configuration

`.env.example` documents the available settings. These are required:

- `TRAKT_CLIENT_ID`
- `TRAKT_CLIENT_SECRET`
- `PUBLICMETADB_API_KEY`

`MDBLIST_API_KEY` is required only when MDBList watchlist sync is enabled or
when running `sync-watchlist`.

Important optional settings include polling and reconciliation intervals,
database path, port, startup backfill, and log format. By default the service
uses `/data/sync.db`, listens on port `3000`, and writes human-readable logs.

### MDBList watchlist warning

When `MDBLIST_WATCHLIST_SYNC_ENABLED=true`, MDBList is the source of truth.
PublicMetaDB watchlist items absent from MDBList are removed, including items
added manually in PublicMetaDB.

## Update or Roll Back

```bash
docker compose pull
docker compose up -d
```

To pin a commit-specific build, set this in `.env` and recreate the service:

```text
BETTERER_SYNC_IMAGE=ghcr.io/itsrenoria/betterer-sync:sha-<commit>
```

Remove the override to follow `latest` again.

## Development

```bash
npm ci
npm test
npm run build
```

Build a local image with `docker build -t betterer-sync:local .`.

## License

MIT. See `LICENSE`.
