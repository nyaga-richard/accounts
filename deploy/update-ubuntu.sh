#!/usr/bin/env bash
set -Eeuo pipefail
if [[ ${EUID} -ne 0 ]]; then exec sudo "$0" "$@"; fi
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
if [[ ! -s .env ]]; then echo "Missing .env. Run sudo ./deploy/install-ubuntu.sh first." >&2; exit 1; fi
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then echo "Docker Engine and Compose plugin are required." >&2; exit 1; fi

# This updater runs as root (sudo) for Docker. Use an explicit per-command
# safe.directory override so a prior `sudo git pull`/root-owned checkout does
# not make Git reject the repository as dubious.
run_git() { git -c safe.directory="$ROOT_DIR" -C "$ROOT_DIR" "$@"; }
if ! run_git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Updates require a Git checkout with an upstream branch. Clone the reviewed Ledgerway repository, then run this script from that checkout." >&2
  exit 1
fi
UPSTREAM=$(run_git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
if [[ -z $UPSTREAM ]]; then echo "The current Git branch has no upstream. Configure its reviewed remote branch before updating." >&2; exit 1; fi
if [[ -n $(run_git status --porcelain) ]]; then echo "Working tree has local changes. Commit or stash them before updating; .env is ignored and is not affected." >&2; exit 1; fi
OLD_REV=$(run_git rev-parse HEAD)
echo "Fast-forwarding source from $UPSTREAM..."
run_git pull --ff-only
NEW_REV=$(run_git rev-parse HEAD)
if [[ $OLD_REV == "$NEW_REV" ]]; then echo "Source is already current; continuing with backup, migration check and rebuild."; else echo "Source updated: ${OLD_REV:0:12} -> ${NEW_REV:0:12}"; fi

compose() { docker compose --profile tunnel "$@"; }
compose config -q
if ! grep -q '^CLOUDFLARE_TUNNEL_TOKEN=.' .env; then echo "CLOUDFLARE_TUNNEL_TOKEN is missing from .env." >&2; exit 1; fi
if ! compose exec -T db pg_isready -U ledgerway -d ledgerway >/dev/null 2>&1; then echo "Database is not running. Start the existing deployment and retry." >&2; exit 1; fi
if ! compose exec -T api node -e "fetch('http://127.0.0.1:4000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then echo "API is not healthy; refusing to update without a working deployment and upload-volume access." >&2; exit 1; fi

echo "Creating a pre-update database and uploads backup..."
bash "$ROOT_DIR/deploy/scripts/backup.sh"
echo "Pulling the current Cloudflare connector and rebuilding application images..."
compose pull cloudflared
compose build --pull api web
echo "Applying database migrations before replacing application containers..."
compose run --rm --no-deps api npm run migrate -w @ledgerway/api
echo "Recreating API, web and Cloudflare connector..."
compose up -d --no-deps api web cloudflared
for service in api web; do
  for attempt in $(seq 1 40); do
    if [[ $service == api ]]; then path=/health; port=4000; else path=/; port=3000; fi
    if compose exec -T "$service" node -e "fetch('http://127.0.0.1:${port}${path}').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then break; fi
    if [[ $attempt -eq 40 ]]; then echo "$service did not pass its health check. Inspect: docker compose logs $service" >&2; exit 1; fi
    sleep 3
  done
done
compose ps
echo "Update complete. Review Cloudflare connector and application logs with: docker compose --profile tunnel logs --tail=100 cloudflared api web"
