#!/usr/bin/env bash
# Make Caddy refuse everyone who is not Cloudflare. Use this ONLY after the site works behind Cloudflare (orange cloud),
# then set BEHIND_CLOUDFLARE=true in .env and run `docker compose up -d`.
# Why: with BEHIND_CLOUDFLARE=true the app trusts the CF-Connecting-IP header; this rule makes sure nobody can fake it
# by talking to your server directly. (Docker bypasses ufw, so the rule lives in Caddy instead.)
# Re-run every few months; Cloudflare's list changes rarely.
set -euo pipefail
cd "$(dirname "$0")/.."
v4=$(curl -fsS https://www.cloudflare.com/ips-v4 | tr '\n' ' ')
v6=$(curl -fsS https://www.cloudflare.com/ips-v6 | tr '\n' ' ')
[ -n "$v4" ] && [ -n "$v6" ] || { echo "could not download the Cloudflare ranges"; exit 1; }
cat > caddy.d/10-cloudflare.caddy <<CADDY
@notcf not remote_ip $v4 $v6
respond @notcf "Forbidden" 403
CADDY
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
echo "done. Test: curl -m 5 -k https://YOUR_SERVER_IP/ --resolve $(grep -m1 '^DOMAIN=' .env | cut -d= -f2):443:YOUR_SERVER_IP  -> must say Forbidden"
