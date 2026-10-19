# Deploying PolyPack on Fly.io

PolyPack is one Node process that serves the built website and the API and keeps its data in one SQLite file. On [Fly.io](https://fly.io) it runs as a single small machine with a 1 GB volume for the database. The repository's `Dockerfile` and `fly.toml` describe that set-up; no Docker is needed on your own computer, because Fly builds the image.

Fly.io has no free tier and asks for a payment card. See <https://fly.io/docs/about/pricing/> for current prices of a `shared-cpu-1x` machine with 512 MB and of volume storage.

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

## Looking after it

```sh
fly logs
fly status
fly volumes list
fly volumes snapshots list <volume id>
```

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
