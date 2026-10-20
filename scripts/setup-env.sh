#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ -e .env ]]; then
  printf '%s\n' '.env already exists; left unchanged. Edit it with: nano .env' >&2
  exit 1
fi
command -v openssl >/dev/null || { printf '%s\n' 'Install openssl first: sudo apt install -y openssl' >&2; exit 1; }
umask 077
db_password="$(openssl rand -hex 24)"
server_secret="$(openssl rand -hex 32)"
admin_password="$(openssl rand -hex 16)"
# Generated credentials use only hex characters and are safe in dotenv and URLs.
printf '%s\n' \
  'NINESYNC_PORT=3001' \
  "NINESYNC_DB_PASSWORD=$db_password" \
  "NINESYNC_SERVER_SECRET=$server_secret" \
  'NINESYNC_ADMIN_USERNAME=admin' \
  "NINESYNC_ADMIN_PASSWORD=$admin_password" \
  'NINESYNC_COOKIE_SECURE=false' \
  'NINESYNC_DOMAIN=' > .env
printf '%s\n' 'Created .env with random credentials (permissions 600).' 'Read/edit credentials locally with: nano .env' 'Keep this file private. Do not overwrite it when updating.'
