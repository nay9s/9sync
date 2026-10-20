#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 2 || $2 != --confirm-restore ]]; then
  printf '%s\n' 'Usage: sudo bash scripts/restore-backup.sh /absolute/path/to/backup --confirm-restore' 'This replaces the current 9sync database and attachment storage with the backup.' >&2
  exit 1
fi
backup_dir="$(cd "$1" && pwd)"
for file in COMPLETE SHA256SUMS database.dump blobs.tar.gz server.env; do
  [[ -f "$backup_dir/$file" ]] || { printf 'Missing backup file: %s\n' "$file" >&2; exit 1; }
done
(cd "$backup_dir" && sha256sum -c SHA256SUMS)
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f .env ]] || { printf '%s\n' 'Restore server.env to .env first. See docs/OPERATIONS.md.' >&2; exit 1; }
docker compose stop server
# Never auto-start the application on a failed restore.
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -U ninesync -d ninesync --clean --if-exists --exit-on-error --no-owner < "$backup_dir/database.dump"
docker compose run --rm -T --no-deps --entrypoint sh server -c 'mkdir -p /app/data/blobs && find /app/data/blobs -mindepth 1 -maxdepth 1 -type f -delete && tar -xzf - -C /app/data' < "$backup_dir/blobs.tar.gz"
docker compose up -d --wait server
printf '%s\n' 'Restore completed. Verify /api/health, admin login, and files before reconnecting Vaults.'
