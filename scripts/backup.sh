#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
umask 077
backup_dir="$(pwd)/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$backup_dir"
running="$(docker compose ps --status running --services)"
restart_server=false
if [[ $'\n'"$running"$'\n' == *$'\nserver\n'* ]]; then restart_server=true; fi
cleanup() { if $restart_server; then docker compose start server; fi; }
trap cleanup EXIT
if $restart_server; then
  server_id="$(docker compose ps -q server)"
  docker compose stop server
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$server_id")"
  [[ $exit_code == 0 ]] || { printf 'Server did not stop cleanly (exit %s); backup aborted. Check logs.\n' "$exit_code" >&2; exit 1; }
fi
docker compose exec -T postgres pg_dump -U ninesync -d ninesync -Fc > "$backup_dir/database.dump"
docker compose run --rm -T --no-deps --entrypoint tar server -C /app/data -czf - blobs > "$backup_dir/blobs.tar.gz"
install -m 0600 .env "$backup_dir/server.env"
(
  cd "$backup_dir"
  sha256sum database.dump blobs.tar.gz server.env > SHA256SUMS
)
printf '%s\n' 'Complete' > "$backup_dir/COMPLETE"
printf 'Backup completed: %s\n' "$backup_dir"
printf '%s\n' 'This backup contains passwords and Vault data. Store it privately outside this VPS as well.'
