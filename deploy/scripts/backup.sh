#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
BACKUP_DIR=${BACKUP_DIR:-$ROOT_DIR/backups}
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
chmod 600 .env 2>/dev/null || true
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dump="$BACKUP_DIR/ledgerway-${stamp}.dump"
files="$BACKUP_DIR/ledgerway-${stamp}-uploads.tar.gz"
dump_tmp="$dump.partial"
files_tmp="$files.partial"
cleanup(){ rm -f "$dump_tmp" "$files_tmp"; }
trap cleanup EXIT

docker compose exec -T db pg_dump -U ledgerway -d ledgerway -Fc > "$dump_tmp"
docker compose exec -T api tar -czf - -C /app/data . > "$files_tmp"
mv "$dump_tmp" "$dump"
mv "$files_tmp" "$files"
trap - EXIT
echo "Created database backup: $dump"
echo "Created upload backup:   $files"
echo "Copy both files to separate, access-controlled off-host storage."
