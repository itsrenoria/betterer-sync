# Betterer Sync

Dockerized sync from Trakt watch history to PublicMetaDB watched history, with optional MDBList watchlist mirroring into PublicMetaDB watchlist.

The service imports every Trakt movie/episode play with its original `watched_at` timestamp, then polls for recent changes. It treats PublicMetaDB as a Trakt-owned mirror only for rows it created or safely adopted by exact item + timestamp match, so unrelated PublicMetaDB history is left alone.

## What It Syncs

- Trakt movies to PublicMetaDB `movie` watched rows.
- Trakt episodes to PublicMetaDB `tv` watched rows using show TMDB ID, season, and episode.
- Rewatches as separate PublicMetaDB plays.
- Trakt timestamp edits by patching the mapped PublicMetaDB play.
- Trakt deletions by deleting only mapped PublicMetaDB plays.

Aside from the optional MDBList watchlist mirror below, it does not sync ratings, resume/progress, lists, or PublicMetaDB changes back to Trakt.

Optional MDBList watchlist sync treats MDBList as the source of truth. PublicMetaDB watchlist items that are not present in MDBList are removed during watchlist sync, including items manually added in PublicMetaDB.

## Setup

1. Create a Trakt API app and put its credentials in `.env`.
2. Create a PublicMetaDB API key and put it in `.env`.
3. Build the image and authorize Trakt:

```bash
cp .env.example .env
docker compose build
docker compose run --rm betterer-sync auth
```

The `auth` command prints a Trakt URL and user code. Complete that flow in your browser; the refresh token is stored in the Docker volume.

## Run

Import everything once:

```bash
docker compose run --rm betterer-sync backfill
```

Run continuously:

```bash
docker compose up -d
```

Check health. The root path intentionally does not serve a UI; `/healthz` is the service health endpoint.

```bash
curl http://localhost:3000/healthz
```

## Commands

```bash
docker compose run --rm betterer-sync auth
docker compose run --rm betterer-sync backfill
docker compose run --rm betterer-sync reconcile
docker compose run --rm betterer-sync audit
docker compose run --rm betterer-sync sync-watchlist
docker compose up -d
```

`serve` is the default command. It runs a startup backfill, polls recent Trakt history every `POLL_INTERVAL_SECONDS`, and performs full reconciliation every `RECONCILE_INTERVAL_HOURS`.

When `MDBLIST_WATCHLIST_SYNC_ENABLED=true`, `serve` also syncs MDBList watchlist to PublicMetaDB watchlist during startup and then every `MDBLIST_WATCHLIST_POLL_INTERVAL_SECONDS`. Use `sync-watchlist` for a one-off watchlist mirror run.

`audit` is read-only. It fetches all Trakt movie and episode history, compares it with local sync state and PublicMetaDB watched rows, then logs counts and samples for missing, mapped-but-drifted, unresolved, failed, or duplicate history rows.

## Environment

- `TRAKT_CLIENT_ID`: Required.
- `TRAKT_CLIENT_SECRET`: Required.
- `PUBLICMETADB_API_KEY`: Required, should look like `pm-...`.
- `MDBLIST_API_KEY`: Required only for `sync-watchlist` or when `MDBLIST_WATCHLIST_SYNC_ENABLED=true`.
- `TRAKT_REDIRECT_URI`: Optional, defaults to `urn:ietf:wg:oauth:2.0:oob`; use the redirect URI configured in your Trakt app if different.
- `POLL_INTERVAL_SECONDS`: Optional, default `60`.
- `HISTORY_OVERLAP_MINUTES`: Optional, default `10`.
- `RECONCILE_INTERVAL_HOURS`: Optional, default `24`.
- `TRAKT_PAGE_LIMIT`: Optional, default `100`.
- `DATABASE_PATH`: Optional, default `/data/sync.db`.
- `PORT`: Optional, default `3000`.
- `RUN_BACKFILL_ON_START`: Optional, set `false` if you only want polling/reconciliation on startup.
- `MDBLIST_WATCHLIST_SYNC_ENABLED`: Optional, default `false`. Set `true` to mirror MDBList watchlist into PublicMetaDB watchlist during `serve`.
- `MDBLIST_WATCHLIST_POLL_INTERVAL_SECONDS`: Optional, default `3600`, so watchlist polling stays comfortably under the MDBList free tier of 1,000 API requests per day.
- `LOG_FORMAT`: Optional, default `text` for human-readable Dozzle logs. Set `json` for structured logs.

## Edge-Case Behavior

- Existing PublicMetaDB rows are adopted only when media type, TMDB ID, season/episode, and timestamp match exactly by instant.
- Missing TMDB IDs use PublicMetaDB mapping lookup with Trakt, IMDb, or TVDB IDs where available.
- Unresolved items are stored with `retry` status in SQLite and do not block the rest of the sync.
- HTTP `429` and `5xx` responses are retried with `Retry-After` support.
- PublicMetaDB rows manually deleted after sync are recreated during reconciliation if the Trakt play still exists.
- PublicMetaDB manual history is not deleted during reconciliation.
- MDBList watchlist sync is an exact mirror into PublicMetaDB watchlist. PMDB watchlist-only items are deleted unless they also exist in MDBList.

## Local Development

```bash
npm install
npm test
npm run build
```
