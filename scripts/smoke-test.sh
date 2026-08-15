#!/bin/sh
set -eu

PROJECT_NAME="lunatv-source-sync-smoke"
SMOKE_PORT="${SMOKE_PORT:-3017}"
BASE_URL="http://127.0.0.1:${SMOKE_PORT}"
SMOKE_TMP="$(mktemp -d)"

cleanup() {
  docker compose -p "$PROJECT_NAME" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$SMOKE_TMP"
}
trap cleanup EXIT INT TERM

export PORT="$SMOKE_PORT"
export ADMIN_USERNAME="smoke-admin"
export ADMIN_PASSWORD="smoke-password"
export SESSION_SECRET="smoke-session-secret-at-least-32-characters"
export SECURE_COOKIES=false
export TRUST_PROXY=false
export DATA_DIR="$SMOKE_TMP/data"
mkdir -p "$DATA_DIR"

docker compose -p "$PROJECT_NAME" up -d --build

attempt=0
until curl -fsS "$BASE_URL/health" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    docker compose -p "$PROJECT_NAME" logs
    echo "smoke: service did not become healthy" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS -c "$SMOKE_TMP/cookies" -H 'content-type: application/json' \
  -d '{"username":"smoke-admin","password":"smoke-password"}' \
  "$BASE_URL/api/auth/login" >"$SMOKE_TMP/login.json"
CSRF_TOKEN="$(node -e "const f=require('fs');const x=JSON.parse(f.readFileSync(process.argv[1]));if(!x.csrfToken)process.exit(1);process.stdout.write(x.csrfToken)" "$SMOKE_TMP/login.json")"

curl -fsS -b "$SMOKE_TMP/cookies" "$BASE_URL/api/admin/subscription-examples" >"$SMOKE_TMP/subscriptions.json"
SUBSCRIPTION_TOKEN="$(node -e "const f=require('fs');const x=JSON.parse(f.readFileSync(process.argv[1]));const t=new URL(x.normalJson).searchParams.get('token');if(!t)process.exit(1);process.stdout.write(t)" "$SMOKE_TMP/subscriptions.json")"

curl -fsS -b "$SMOKE_TMP/cookies" -H "x-csrf-token: $CSRF_TOKEN" -H 'content-type: application/json' \
  -d '{"api_site":{"smoke":{"name":"Smoke Source","api":"https://example.com/api.php/provide/vod"}}}' \
  "$BASE_URL/api/admin/import/apply" >"$SMOKE_TMP/import.json"
node -e "const f=require('fs');const x=JSON.parse(f.readFileSync(process.argv[1]));if(x.inserted!==1||x.invalid!==0)process.exit(1)" "$SMOKE_TMP/import.json"

curl -fsS "$BASE_URL/api/source?ac=list&source=normal&format=json&proxy=0&token=$SUBSCRIPTION_TOKEN" >"$SMOKE_TMP/source.json"
node -e "const f=require('fs');const x=JSON.parse(f.readFileSync(process.argv[1]));if(!x.api_site?.smoke)process.exit(1)" "$SMOKE_TMP/source.json"
curl -fsS "$BASE_URL/api/source?ac=list&source=normal&format=base58&proxy=0&token=$SUBSCRIPTION_TOKEN" >"$SMOKE_TMP/source.base58"
node -e "const f=require('fs');const x=f.readFileSync(process.argv[1],'utf8');if(!x||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(x))process.exit(1)" "$SMOKE_TMP/source.base58"

curl -fsSI -X OPTIONS "$BASE_URL/api/source" >"$SMOKE_TMP/cors.headers"
grep -qi '^access-control-allow-origin: \*' "$SMOKE_TMP/cors.headers"
[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/source?source=invalid&token=$SUBSCRIPTION_TOKEN")" = 400 ]
[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/source?format=invalid&token=$SUBSCRIPTION_TOKEN")" = 400 ]

echo "smoke: login, CSRF import, JSON, Base58, CORS, and validation checks passed"
