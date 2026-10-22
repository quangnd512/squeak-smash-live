#!/usr/bin/env bash
# Daily database backup. Run from the project folder (where docker-compose.yml is).
#   crontab -e   ->   15 2,14 * * *  cd /opt/squeak-smash/squeak-smash-live && ./scripts/backup.sh >> backups/backup.log 2>&1   (twice a day, UTC)
# Optional off-site copy: install rclone, run `rclone config`, then set RCLONE_REMOTE=myremote:squeak-backups in .env
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
mkdir -p backups
f="backups/squeak-$(date -u +%Y%m%d-%H%M%S).sql.gz"
docker compose exec -T db pg_dump -U squeak -d squeak --no-owner | gzip -9 > "$f.tmp"
# a backup that is almost empty is a failed backup
[ "$(stat -c %s "$f.tmp")" -gt 1000 ] || { echo "backup too small, something is wrong"; rm -f "$f.tmp"; exit 1; }
mv "$f.tmp" "$f"
echo "$(date -u +%FT%TZ) wrote $f ($(du -h "$f" | cut -f1))"
if [ -n "${RCLONE_REMOTE:-}" ]; then rclone copy "$f" "$RCLONE_REMOTE" && echo "copied off-site"; fi
# keep 10 days (14400 minutes) of backups, locally and off-site
find backups -name 'squeak-*.sql.gz' -mmin +14400 -delete
if [ -n "${RCLONE_REMOTE:-}" ]; then rclone delete "$RCLONE_REMOTE" --min-age 10d --include 'squeak-*.sql.gz' && echo "pruned off-site"; fi
