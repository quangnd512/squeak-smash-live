#!/usr/bin/env bash
# Restore a backup:  ./scripts/restore.sh backups/squeak-20261020-031500.sql.gz
# WARNING: replaces the current database content.
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -eq 1 ] || { echo "usage: $0 backup.sql.gz"; exit 1; }
read -r -p "This REPLACES the live database. Type YES to continue: " a; [ "$a" = "YES" ] || exit 1
docker compose stop api
docker compose exec -T db psql -U squeak -d postgres -c "drop database if exists squeak" -c "create database squeak owner squeak"
gunzip -c "$1" | docker compose exec -T db psql -U squeak -d squeak -v ON_ERROR_STOP=1 >/dev/null
docker compose start api
echo restored
