#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $# -ne 1 || ! -f "$1" ]]; then echo "Usage: $0 path/to/ledgerway-TIMESTAMP.dump" >&2; exit 2; fi
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
dump=$(realpath "$1")
uploads="${dump%.dump}-uploads.tar.gz"
echo "WARNING: this replaces the live database. If the matching upload archive exists, it also replaces uploaded files."
read -r -p "Type RESTORE to continue: " answer
[[ $answer == RESTORE ]] || exit 1
compose(){ docker compose --profile tunnel "$@"; }
compose stop cloudflared web api || true
compose exec -T db pg_restore -U ledgerway -d ledgerway --clean --if-exists < "$dump"
if [[ -f $uploads ]]; then
  compose run --rm -T --no-deps api sh -c 'mkdir -p /app/data && find /app/data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -xzf - -C /app/data' < "$uploads"
else
  echo "No matching uploads archive found; uploaded files were left as-is." >&2
fi
compose up -d api web cloudflared
for service in api web; do
  for attempt in $(seq 1 40); do
    if [[ $service == api ]]; then path=/health; port=4000; else path=/; port=3000; fi
    if compose exec -T "$service" node -e "fetch('http://127.0.0.1:${port}${path}').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then break; fi
    if [[ $attempt -eq 40 ]]; then echo "$service did not become healthy after restore." >&2; exit 1; fi
    sleep 3
  done
done
echo "Restore completed. Check Docker and Cloudflare logs before reopening traffic."
