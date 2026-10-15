#!/usr/bin/env bash
#
# Load / performance harness (item 5).
#
# Starts the production image against the seeded database, runs
# `load-test.mjs`, and tears everything down. The point of doing it in one
# script is that the numbers in docs/evidence/ must come from the configuration
# that ships: NODE_ENV=production, PostgreSQL over verify-full, the real image.
# A load test run against PGlite or a dev server would describe neither.
#
# Requirements:
#   - a running PostgreSQL reachable at LOAD_DB_URL (default: the `bigcrm-db`
#     container from the dev topology, database `bigcrm`, already seeded by
#     `server/seed/load.ts`)
#   - the production image built: docker build -t bigcrm-api:final .
#
# Usage: infra/scripts/load-test.sh
#
# Env:
#   LOAD_DB_URL         connection string for the seeded database
#   LOAD_DB_CA          CA cert for verify-full (default: /tmp/opencode/pgcerts/ca.crt)
#   LOAD_DURATION       seconds per scenario (default 10)
#   LOAD_CONCURRENCY    parallel workers (default 20)
#   LOAD_REPRO=1        leave the target running after the test

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
API_C=bigcrm-api-load
PORT="${LOAD_PORT:-3200}"
DB_URL="${LOAD_DB_URL:-postgres://bigcrm:bigcrm_dev_password@bigcrm-db:5432/bigcrm}"
DB_CA="${LOAD_DB_CA:-/tmp/opencode/pgcerts/ca.crt}"

command -v docker >/dev/null 2>&1 || { echo "docker required"; exit 2; }
docker image inspect bigcrm-api:final >/dev/null 2>&1 || {
  echo "bigcrm-api:final not found — build it first: docker build -t bigcrm-api:final ."; exit 2; }
[ -f "$DB_CA" ] || { echo "CA not found at $DB_CA — set LOAD_DB_CA"; exit 2; }

cleanup() {
  if [ "${LOAD_REPRO:-0}" = "1" ]; then
    echo "  LOAD_REPRO=1 — leaving ${API_C} running on :${PORT}"
    return
  fi
  docker rm -f "$API_C" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== starting the target with production settings ==="
docker rm -f "$API_C" >/dev/null 2>&1 || true
# Rate limits are lifted for the load run, and the report says so.
#
# The production default is 1000 requests per 15 minutes per IP. A harness
# driving 20 concurrent workers trips that in under a second, and then measures
# the rate limiter rather than the application — which is exactly what the first
# run did (100% 429s after the warmup). The list endpoints additionally sit
# behind `searchLimiter` (default 60 per window), so lifting only the global
# limiter still 429s every authenticated scenario, as the second run showed.
# Abuse controls are covered by the
# security suite; throughput is measured with them lifted, and the numbers must
# not be read as achievable under the default limits.
docker run -d --name "$API_C" --network bigcrm_default -p "127.0.0.1:${PORT}:3000" \
  -v "$DB_CA:/certs/db-ca.crt:ro" \
  -e NODE_ENV=production \
  -e PORT=3000 -e HOST=0.0.0.0 -e LOG_LEVEL=error \
  -e DATABASE_URL="$DB_URL" \
  -e DATABASE_SSL=verify-full \
  -e DATABASE_SSL_CA_FILE=/certs/db-ca.crt \
  -e JWT_ISSUER=bigcrm.load -e JWT_AUDIENCE=bigcrm.load.api \
  -e JWT_ACCESS_SECRET='load-access-secret-0123456789abcdef0123456789abcdefghij' \
  -e JWT_REFRESH_SECRET='load-refresh-secret-0123456789abcdef0123456789abcdefghij' \
  -e SECRETS_PEPPER='load-pepper-0123456789abcdef0123456789abcdefghijklmn' \
  -e STORAGE_SIGNING_SECRET='load-storage-secret-0123456789abcdef0123456789abcdef' \
  -e APP_ORIGINS='https://app.load.example' \
  -e DB_POOL_MAX="${LOAD_DB_POOL:-20}" \
  -e RATE_LIMIT_GLOBAL_MAX="${LOAD_RATE_LIMIT_MAX:-100000}" \
  -e RATE_LIMIT_SEARCH_MAX=10000 \
  -e RATE_LIMIT_EXPORT_MAX=1000 \
  -e RATE_LIMIT_UPLOAD_MAX=1000 \
  -e RATE_LIMIT_AUTH_WINDOW_MS=1000 \
  -e RATE_LIMIT_GLOBAL_WINDOW_MS=1000 \
  bigcrm-api:final >/dev/null 2>&1

for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null)" = "200" ] && break
  sleep 1
done
H=$(curl -s --max-time 3 "http://127.0.0.1:${PORT}/health" 2>/dev/null)
echo "  health: ${H:-DID NOT START}"
[ -n "$H" ] || { docker logs "$API_C" 2>&1 | tail -5; exit 2; }

echo
echo "=== seeding check ==="
docker exec "$API_C" node -e "
fetch('http://127.0.0.1:3000/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json','origin':'https://app.load.example'},
 body:JSON.stringify({email:'owner0@seed.test',password:'Seed-Password-Strong!42'})})
 .then(async r=>{console.log('  login probe: '+r.status+(r.ok?' (seeded)':' — DATABASE IS NOT SEEDED'));process.exit(r.ok?0:1)})
 .catch(e=>{console.log('  login probe failed: '+e.message);process.exit(1)})
" || {
  echo "  seed the database first:  cd server && node --experimental-strip-types --env-file=<env> seed/load.ts"
  exit 2
}

echo
echo "=== running the harness ==="
LOAD_BASE_URL="http://127.0.0.1:${PORT}" \
LOAD_DURATION="${LOAD_DURATION:-10}" \
LOAD_CONCURRENCY="${LOAD_CONCURRENCY:-20}" \
node "$ROOT/infra/scripts/load-test.mjs"
RC=$?

echo
echo "=== container resource use during the run ==="
docker stats --no-stream --format "  {{.Name}}  cpu={{.CPUPerc}}  mem={{.MemUsage}}" "$API_C" 2>/dev/null || true

exit $RC
