# Deploying PolyPack on Fly.io

PolyPack is one Node process that serves the built website and the API and keeps its data in one SQLite file. On [Fly.io](https://fly.io) it runs as a single small machine with a 1 GB volume for the database. The repository's `Dockerfile` and `fly.toml` describe that set-up; no Docker is needed on your own computer, because Fly builds the image.

Fly.io has no free tier and asks for a payment card. See <https://fly.io/docs/about/pricing/> for current prices of a `shared-cpu-2x` machine with 1 GB (the size `fly.toml` sets since 2026-10-31; it was a `shared-cpu-1x` with 512 MB before) and of volume storage.

## First deployment

Create an account at <https://fly.io> and add a card. Then, on a Mac with [Homebrew](https://brew.sh):

```sh
brew install flyctl
fly auth login
```

From the repository folder, register the app. Fly asks for a name, which must be unique across Fly and becomes the address `https://<name>.fly.dev`, and for a region. Decline any offer to add a database or to change the settings.

```sh
fly launch --copy-config --no-deploy
```

Create the admin password before the site is reachable. The second line shows it once: save it in a password manager. It is the password for `/admin.html`.

```sh
TOKEN=$(openssl rand -hex 32)
echo $TOKEN
fly secrets set ADMIN_TOKEN=$TOKEN
```

Deploy. The first deployment also creates the volume.

```sh
fly deploy
fly status
fly open
```

## Settings

| Where | Setting | Meaning |
|---|---|---|
| `fly.toml` | `app`, `primary_region` | Chosen at `fly launch`. |
| `fly.toml` | `CLIENT_IP_HEADER = "fly-client-ip"` | Rate limits apply to each visitor's address, as reported by Fly's proxy. |
| `fly.toml` | `[mounts]` | The volume holding `/data/polypack.sqlite`. It survives deployments and restarts. |
| `fly.toml` | `SNAPSHOT_DIR = "/data/snapshot"` | Where the server builds the nightly records snapshot (see below). |
| `fly.toml` | `[[vm]]` | Machine size. |
| secret | `ADMIN_TOKEN` | Admin password. Without one the admin page is switched off. |

Keep exactly one machine. The database is a single file on one volume, so a second machine would have its own, separate leaderboard:

```sh
fly scale count 1
```

## Updating

Every push to `main` runs the tests (`.github/workflows/ci.yml`); when they all pass, the same workflow deploys to Fly. It needs a repository secret `FLY_API_TOKEN` holding a deploy token for the app:

```sh
fly tokens create deploy -a <name> | gh secret set FLY_API_TOKEN
```

To deploy by hand instead:

```sh
fly deploy
```

`.github/workflows/uptime.yml` asks the site every 15 minutes whether it is healthy; GitHub reports a failed run by its usual notification. GitHub pauses scheduled workflows in a repository that has had no activity for 60 days.

## Moderation

`/admin.html`, with the admin token, lists entries that claim to beat a published value for review, and can remove any entry by its number.

## Records snapshot

Every night at 11:00 UTC (`SNAPSHOT_HOUR`) the server writes every open problem's leader, with its coordinates, to `/data/snapshot`: one gzipped JSON file per shape pair, one per space for the other dimensions (`space-{space}.json.gz`, the site entries with their configurations) and `manifest.json`. It serves them at `/api/snapshot`, and the workflow `.github/workflows/records.yml` mirrors them at 12:30 UTC into the GitHub release `records` (`scripts/mirror-snapshot.ts`). The format is on the API page.

A pair's file is rebuilt only when its leaders changed (any new leader, edited name or review), so quiet nights are short; while volunteers are active across many pairs, most nights may rebuild most of them [SPEC]. The build reads the leaders one shape pair at a time and the entries 25 at a time, and the manifest says when it has finished (`completed_at` equal to `generated_at`); the mirror waits for that. The first build writes every file. On an Apple Silicon Mac a full pair (P from 1 to 500, about 125,000 pieces) took 0.37 s and made a 3.4 MB file, and no request waited more than 7 ms behind it [CALC]. The live site has about 324 such pairs, so the files take about 1.1 GB of the volume [SPEC]. After each pair the build pauses three times as long as the pair took, at least 1 s, to leave the shared CPU to requests. A space's file is rebuilt whole when any of its leaders changes, and can be much larger than a pair's: an entry on every polyhedra problem would make about 28 MB and 6 s of work on the same Mac [CALC]. So the build also pauses inside a space's file, after every 25,000 pieces (`SPACE_PAUSE_PIECES`), by the same rule. When the snapshot is missing, unfinished (a deploy cut the build short), more than a day old or without the space files (one written before they existed), the build starts 5 minutes after the server starts.

## Looking after it

```sh
fly logs
fly status
fly volumes list
fly volumes snapshots list <volume id>
```

The server logs one line per submission, with its status, problem and time, in all and for the geometry check (`[submit] 200 4/4/11 1.32 ms, verification 0.87 ms`; never a name or an address). In every minute with a submission or an open live-update stream it adds one line with the counts by status, the percentiles of verification time, the leader changes, the open streams and the longest event-loop delay (`[load] last minute: …`). `fly logs | grep '\[load\]'` follows the load.

Each address may cause 2 s of verification a minute (`VERIFY_MS_PER_MINUTE` in `apps/server/src/limits.ts`); IPv6 addresses count by their /64. While the event loop lags by more than 250 ms, submissions are answered 503 with `Retry-After`. The setting `OVERLOAD_DELAY_MS` changes that threshold, and `0` switches the refusal off.

Fly takes a daily snapshot of the volume and keeps it for a few days; see <https://fly.io/docs/volumes/snapshots/>. The volume lives on one server, so the snapshots are the only copy on Fly.

For a copy of your own on a Mac, `deploy/fly/backup-to-mac.sh` streams the database to the Mac and keeps it gzip-compressed, the newest four by default. On the server, `backup-dump.cjs` reads one consistent snapshot (a single read transaction, while the server goes on writing) and sends it gzipped over `fly ssh`; nothing is written to the server's disk. On the Mac, `backup-rebuild.mjs` rebuilds the database from the stream, refuses a stream that was cut short or whose row counts differ from the dump's own, and checks the result before it is kept:

```sh
./deploy/fly/backup-to-mac.sh
./deploy/fly/backup-to-mac.sh install
```

The first takes a backup now; the second runs it every Sunday at 04:00 through launchd (a run missed while the Mac sleeps happens on wake). Backups go to `~/GitHub/PolyPack-backups/database` unless `POLYPACK_BACKUP_DIR` says otherwise, and the log to `~/Library/Logs/polypack-backup.log`. Reading the whole database, at low CPU priority, slows the site for a few minutes. Copying the file directly (`fly ssh sftp get /data/polypack.sqlite`) while the server writes can give an inconsistent file.

To restore from such a backup: `gunzip` it, upload it with `fly ssh sftp shell` (`put polypack-….sqlite /data/restore.sqlite`), then in `fly ssh console` replace the database and its journal, and restart. Entries submitted between the replacement and the restart are lost. The upload needs free space on the volume as large as the backup; if the volume is too full, move the broken database off it first.

```sh
mv /data/restore.sqlite /data/polypack.sqlite && rm -f /data/polypack.sqlite-wal /data/polypack.sqlite-shm
fly machine restart
```

The first line runs on the server (in `fly ssh console`), the second on your Mac.

## The unit change (2026-10-27)

Disk and ball pieces now have diameter 1 (they had radius 1), and circle and ball containers are scored by their diameter (they were scored by their radius). Every stored entry of an affected problem is the old one scaled by a power of two, so the conversion is exact and reversible. The classes and factors are listed at the top of `apps/server/src/units-migration.ts`; in short, 2D disks in a polygon halve score and pieces, disks in a circle keep their score and halve their pieces, polygons in a circle double their score, and the spaces' disk and ball entries convert the same way (curved disks at K other than 0 have no equivalent and are set aside in `space_entries_units_archive`, which the reverse restores).

The server converts by itself at start-up: one `BEGIN IMMEDIATE` transaction, before it listens, that rewrites the scores, pieces, `literature_value`, `strict_check.certifiedSize` and the spaces' `config` of the affected rows and sets `meta.units_epoch = 2` in the same transaction. A crash leaves all old or all new, a second start does nothing, and a new database starts at 2. Leaders and ranks are read from the rows, so they are consistent as soon as it commits. The log says `units: converted to diameter units in N ms` with the counts. On the 1.3 GB backup of 2026-10-27 (182,480 rows, 18,548 of them affected) it took about 0.8 s [CALC].

Before deploying:

1. Take a backup (`./deploy/fly/backup-to-mac.sh`), and avoid the nightly jobs (trim at 10:30 UTC, the records mirror).
2. Dry-run the conversion on a copy of the volume file, never on the live file: `npx tsx scripts/units-migrate.ts --dry-run <copy>`. It converts inside a transaction, checks row counts, that every leader keeps its id, that the real validators accept every converted 2D row (and a sample of the spaces' entries) with the stored score, that a second run changes nothing and that the reverse restores every row bit for bit, prints five entries before and after, and rolls back.
3. Deploy the image that holds the converted `data/*` (the server reads `data/records.json` at start-up, so data and database must switch together).
4. Rebuild the snapshot (format 2, every file written again, `units: "diameter"` in the manifest) and run `scripts/mirror-snapshot.ts` once; it reads a format 1 or 2 release manifest and uploads every changed file.
5. Smoke tests: `GET /api` says `conventions.version` 2; a disk submission without `"units": "diameter"` answers 426; a request with `User-Agent: polypack-volunteer/0.1.x` to a disk problem answers 426.

Rollback: redeploy the previous image and run `npx tsx scripts/units-migrate.ts --reverse <database file>` with the server stopped (it sets `units_epoch` to 1), or restore the backup if no new entry was accepted. Entries made after the conversion at curved K other than 0 for disks (new problems in the new units) go to the archive with epoch 2 and return if the conversion is run again.

## Database size

Since 2026-10-18 the server keeps the database small in two ways:

- **Only the leader of each problem is kept.** Every other entry is deleted as soon as it is overtaken, row and name included. The one exception is a leader that awaits review: the best entry that is not pending is kept behind it, so that rejecting the claim gives the problem its previous record back. A rejected or removed entry is deleted.
- **Pieces are stored as binary.** Each piece takes 24 bytes (three 8-byte numbers) instead of about 74 bytes of JSON text, and comes back exactly as it was sent.

### The migration of existing rows

Rows written before this version are converted in the background by the server itself, so nothing needs to be run by hand. Every second the server takes the next 100 rows by id. It deletes the rows their problem no longer keeps, converts the pieces of the rest, and records how far it got. It does this in one short transaction, and the requests in between are served as usual. After a restart or a deployment it carries on where it stopped. The log shows one line when it starts, one a minute while it runs, and one when it is complete:

```sh
fly logs | grep '\[pieces\]'
```

Two settings (as `fly secrets set` or in `[env]` of `fly.toml`) change its pace: `PIECES_MIGRATION_BATCH`, the rows per step (100; `0` switches it off), and `PIECES_MIGRATION_PAUSE_MS`, the pause between steps (1000). On a synthetic database with three entries per problem, a step of 100 rows took 16 ms (median; 37 ms at most) on an Apple Silicon Mac [CALC]. On Fly's shared CPU it is slower, by an amount not yet measured. A dry run on a copy of the live database of 2026-10-18 (212,394 rows over 179,010 problems) took about 2,116 steps, 24 ms each (median; 92 ms at most), 52 s of work on a Mac, so about 36 minutes at the default pause [CALC]. It kept every problem's leader with the same id and score and its pieces bit for bit, and deleted 33,385 rows [CALC].

Take a backup (`./deploy/fly/backup-to-mac.sh`) before deploying this version. **There is no way back to an older version afterwards**: older versions read pieces only as JSON text, and the deleted rows are gone. To go back, restore that backup; entries submitted since are then lost.

### How much it frees

On a synthetic copy (`npx tsx scripts/measure-storage.ts --problems 3000`: 9,000 rows, three entries per problem, P from 50 to 500, 74.5 bytes of JSON per piece) [CALC]:

| | rows | in use | per original row |
|---|---|---|---|
| before | 9,000 | 193.7 MB | 21.5 kB |
| after the migration | 3,028 | 24.8 MB | 2.75 kB (12.8%) |
| after VACUUM | 3,028 | 23.5 MB (file) | |

What remains is about 24 bytes per piece of each leader, plus about 1.5 kB per row for the other columns and the index. The live database held about 1.19 entries per problem, not three: in the dry run on its copy of 2026-10-18, the pages in use fell from 4,392 MB to 1,408 MB (pieces from 3,310 MB to 1,073 MB), and VACUUM then gave a 1,309 MB file in 21.5 s on a Mac [CALC]. `db-space.mjs` below reports the real figures.

### Checking and reclaiming the space

SQLite reuses the pages freed by deleted and shrunk rows for new ones, so after the migration the file stops growing until that free space is used up. It shrinks only if an operator runs `VACUUM`; the server never does. To see how the file is used:

```sh
fly ssh console -C "node --no-warnings /app/apps/server/scripts/db-space.mjs"
```

It prints JSON and changes nothing. `page_count × page_size` is the file, `freelist_count × page_size` the free part (`free_in_file_mb`), `in_use_mb` the rest, `disk_free_mb` the room left on the volume, and `migration` how far the migration is (`done`, and `cursor` against `last_id`).

The weekly backup streams the database and needs no room on the volume, but its single read transaction keeps the write-ahead log from being emptied while it runs. During the migration the log grows by about 0.7 MB a step (about 40 MB a minute) [CALC], so let a backup and the migration overlap only when the volume has room for that.

To give the free pages back to the volume, optionally and once the migration is complete:

```sh
fly ssh console -C "node --no-warnings /app/apps/server/scripts/db-space.mjs --vacuum"
```

It refuses to start before the migration is complete, or with less free disk than about twice the pages in use (a temporary copy next to the database, and the write-ahead log). While it runs, the site keeps answering, but submissions fail with HTTP 500 (the database is busy). `scripts/batch-search.ts` tries a failed submission again for about two minutes, and running the same command again sends what is still missing. Run it at a quiet time, and not while a backup runs. On the synthetic copy it took a fraction of a second; on the live volume it will take longer, by an amount not yet measured. Its output gives the figures before and after. Take a new backup afterwards.

## Your own domain

```sh
fly certs add polypack.example.com
```

Fly then shows the DNS records to create at your domain's registrar.

## Removing it

```sh
fly apps destroy <name>
```

This deletes the machine and the volume, including the database.
