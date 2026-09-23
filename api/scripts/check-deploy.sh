#!/usr/bin/env bash
# Run after every deploy/restart of shorts-api.
# Verifies: app is listening, .env PORT matches nginx's proxy_pass, and PM2 isn't crash-looping.
set -euo pipefail

ENV_FILE="$(dirname "$0")/../.env"
NGINX_CONF="/etc/nginx/sites-available/shorts-api"

port="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)"
echo "api/.env PORT=$port"

if [ -f "$NGINX_CONF" ]; then
  nginx_port="$(grep -oP 'proxy_pass http://127\.0\.0\.1:\K[0-9]+' "$NGINX_CONF" || true)"
  echo "nginx proxy_pass port=$nginx_port"
  if [ -n "$nginx_port" ] && [ "$nginx_port" != "$port" ]; then
    echo "MISMATCH: api/.env PORT ($port) != nginx proxy_pass port ($nginx_port)" >&2
    exit 1
  fi
fi

if ! curl -sf "http://127.0.0.1:${port}/health" | grep -q '"ok":true'; then
  echo "FAIL: http://127.0.0.1:${port}/health did not return {\"ok\":true}" >&2
  exit 1
fi

restarts="$(pm2 jlist | node -e "process.stdin.on('data',d=>{const p=JSON.parse(d).find(p=>p.name==='shorts-api');process.stdout.write(String(p?.pm2_env?.restart_time??0))})")"
if [ "$restarts" -gt 3 ]; then
  echo "WARNING: shorts-api has restarted $restarts times — check 'pm2 logs shorts-api'" >&2
fi

echo "OK: shorts-api is healthy on port $port"
