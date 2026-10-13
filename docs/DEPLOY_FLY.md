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

```sh
git pull
fly deploy
```

## Looking after it

```sh
fly logs
fly status
fly volumes list
fly volumes snapshots list <volume id>
```

Fly takes a daily snapshot of the volume and keeps it for a few days; see <https://fly.io/docs/volumes/snapshots/>. For a copy of your own, download the database:

```sh
fly ssh sftp get /data/polypack.sqlite ./polypack-backup.sqlite
```

A file fetched while the server is writing can miss the most recent entries; a snapshot is the consistent copy.

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
