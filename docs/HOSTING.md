# Hosting PolyPack on a Mac

For a rented server instead, see [DEPLOY_FLY.md](DEPLOY_FLY.md).

PolyPack is one Node process: it serves the built website and the API, and keeps its data in one SQLite file. Any always-on machine can host it. This page sets it up on a Mac at home, reachable from the internet through a tunnel, so that no port is opened on the home router and the home address is not exposed.

The scripts are in `deploy/macos/`.

| Piece | What it does |
|---|---|
| `install.sh` | Writes `~/.polypack/env` (with a random admin token), builds the site, registers the two launchd jobs below. Safe to run again. |
| `start.sh` | Starts the server with the settings in `~/.polypack/env`. Run by launchd at boot and restarted if it stops. |
| `backup.sh` | Copies the database to `~/.polypack/backups/` every night at 04:10 and keeps the newest 30. |

## 1. Prepare the Mac

Install [Homebrew](https://brew.sh), then:

```sh
brew install node@24 git cloudflared
brew link --overwrite --force node@24
node --version
```

The version printed must be 24 or newer.

Keep the Mac awake on mains power and have it start again after a power cut:

```sh
sudo pmset -c sleep 0 disksleep 0 womp 1 autorestart 1
```

A laptop sleeps when its lid is closed unless an external display is attached. Either leave the lid open, or turn that off (and back on with `0`):

```sh
sudo pmset -a disablesleep 1
```

A laptop left on charge for months is hard on its battery; in System Settings → Battery, turn on optimised charging.

## 2. Install PolyPack

```sh
mkdir -p ~/GitHub
cd ~/GitHub
git clone https://github.com/sinkomr/PolyPack.git
cd PolyPack
./deploy/macos/install.sh
```

The script asks for the Mac's password once (to register the launchd jobs) and ends by reporting that the site answers on `http://127.0.0.1:8787`. The server listens only on the Mac itself; the tunnel in the next step is the only way in.

Settings are in `~/.polypack/env`:

| Setting | Meaning |
|---|---|
| `PORT`, `HOST` | Where the server listens. Leave `HOST=127.0.0.1`. |
| `DATABASE_PATH` | The SQLite file. |
| `ADMIN_TOKEN` | Password for the admin page. Generated at random by `install.sh`; never commit it or paste it anywhere public. Without one, the admin page is switched off. |
| `CLIENT_IP_HEADER` | The header in which the tunnel reports the visitor's address, so that rate limits apply per visitor rather than to the tunnel. `cf-connecting-ip` for Cloudflare; remove the line for Tailscale Funnel. |

## 3. Make it reachable: Cloudflare Tunnel

This needs a domain name whose DNS is managed by a (free) Cloudflare account. A domain can be bought at cost from Cloudflare Registrar. Replace `polypack.example.com` below with the name you want.

```sh
cloudflared tunnel login
cloudflared tunnel create polypack
cloudflared tunnel route dns polypack polypack.example.com
```

`tunnel create` prints a tunnel ID and writes a credentials file `~/.cloudflared/<ID>.json`. Treat that file like a password. Create `~/.cloudflared/config.yml` with the ID and your own user name filled in:

```yaml
tunnel: <ID>
credentials-file: /Users/<you>/.cloudflared/<ID>.json
ingress:
  - hostname: polypack.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Then install the tunnel as a service that starts at boot:

```sh
sudo cloudflared --config ~/.cloudflared/config.yml service install
```

The site is now at `https://polypack.example.com`. Cloudflare provides the certificate.

### Without a domain: Tailscale Funnel

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) gives a free public address of the form `https://<machine>.<tailnet>.ts.net` with no domain to buy. Install Tailscale from the App Store, sign in, enable Funnel for the tailnet when prompted, then:

```sh
tailscale funnel --bg 8787
```

The address is less memorable and bandwidth is limited, but nothing else changes.

## 4. Updating

```sh
cd ~/GitHub/PolyPack
git pull
./deploy/macos/install.sh
```

## 5. Looking after it

```sh
tail -n 50 ~/.polypack/logs/org.polypack.server.log
sudo launchctl kickstart -k system/org.polypack.server
ls -lh ~/.polypack/backups
```

The first shows the server log, the second restarts the server, the third lists the backups. To restore, stop the server, copy a backup over the file named by `DATABASE_PATH`, and start it again:

```sh
sudo launchctl bootout system /Library/LaunchDaemons/org.polypack.server.plist
cp ~/.polypack/backups/polypack-2026-01-01.sqlite ~/.polypack/polypack.sqlite
rm -f ~/.polypack/polypack.sqlite-wal ~/.polypack/polypack.sqlite-shm
sudo launchctl bootstrap system /Library/LaunchDaemons/org.polypack.server.plist
```

The backups sit on the same disk as the database. Copy `~/.polypack/backups/` somewhere else from time to time, or include it in Time Machine.

To remove everything:

```sh
sudo launchctl bootout system /Library/LaunchDaemons/org.polypack.server.plist
sudo launchctl bootout system /Library/LaunchDaemons/org.polypack.backup.plist
sudo rm /Library/LaunchDaemons/org.polypack.server.plist /Library/LaunchDaemons/org.polypack.backup.plist
sudo cloudflared service uninstall
```
