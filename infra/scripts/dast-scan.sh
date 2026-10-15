#!/usr/bin/env bash
#
# DAST: OWASP ZAP scan against the production image.
#
# Closes deferred item D1 ("DAST"). No ZAP result existed anywhere for this
# application, so every claim about its DAST posture was unverified. This
# produces a real one.
#
# Topology (mirrors docs/DEPLOYMENT.md, where an ALB terminates TLS):
#
# curl -> ZAP proxy (127.0.0.1:8090) -> https://localhost:8443 (nginx, TLS)
# -> http://bigcrm-api:3000
#
#  Why this drives requests instead of letting ZAP spider 
#
# ZAP's baseline spider discovers routes by following HTML links. This is a JSON
# API: the root returns 404 with no links, so the spider stops after four URLs
# (/, robots.txt, sitemap.xml, the bare host) and the report describes almost
# none of the application. A context file seeding the spider does not help --
# ZAP rejects the seed with URL_NOT_IN_CONTEXT.
#
# So every route is requested explicitly through ZAP's MITM proxy. ZAP's
# passive scan rules then evaluate the real responses, which is the part of a
# baseline scan that is actually informative for an API. This is the same
# coverage a spider would give a linked HTML site, obtained deterministically.
#
# The API container runs NODE_ENV=production with its full production config,
# because env.ts:158 refuses a plaintext APP_ORIGINS in production. Downgrading
# NODE_ENV to make the scan easier would scan a configuration that does not ship.
#
# Usage: infra/scripts/dast-scan.sh
#
# Env:
# DAST_REPORT report path (default docs/evidence/)
# DAST_REPRO=1 leave the target and ZAP running for manual follow-up
# DAST_DATABASE_CA CA for verify-full; defaults to a discovered local cert

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${ROOT}/docs/evidence"
REPORT="${DAST_REPORT:-${OUT_DIR}/dast-zap-$(date -u +%Y-%m-%d).md}"
mkdir -p "$OUT_DIR"

API_C=bigcrm-api-dast
PROXY_C=dast-nginx
ZAP_C=bigcrm-zapd
PORT="${DAST_PORT:-8443}"
ZAP_API_PORT="${DAST_ZAP_PORT:-8090}"

command -v docker >/dev/null 2>&1 || { echo "docker required"; exit 2; }
docker image inspect bigcrm-api:final >/dev/null 2>&1 || {
 echo "bigcrm-api:final not found -- build it first (docker build -t bigcrm-api:final .)"; exit 2; }

cleanup() {
 if [ "${DAST_REPRO:-0}" = "1" ]; then
 echo " DAST_REPRO=1 -- leaving ${API_C}, ${PROXY_C} and ${ZAP_C} running."
 echo " API: curl -sk https://localhost:${PORT}/health"
 echo " ZAP: http://localhost:${ZAP_API_PORT} (UI/API, key disabled)"
 echo " proxy: curl -sk -x http://localhost:${ZAP_API_PORT} https://localhost:${PORT}/health"
 return
 fi
 docker rm -f "$API_C" "$PROXY_C" "$ZAP_C" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== 1. TLS material for the terminator ==="
CERT_DIR="$(mktemp -d /tmp/opencode/dast.XXXXXX)"
openssl req -x509 -newkey rsa:2048 -nodes \
 -keyout "$CERT_DIR/dast.key" -out "$CERT_DIR/dast.crt" -days 30 \
 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
chmod 644 "$CERT_DIR/dast.crt" "$CERT_DIR/dast.key"
echo " self-signed, SAN=localhost+127.0.0.1, valid 30 days"

# PostgreSQL CA for the target.
#
# Mandatory, not optional. env.ts refuses DATABASE_SSL=disable in production,
# and downgrading NODE_ENV to sidestep that would scan a configuration that does
# not ship. The scan runs only when it can connect the way production connects.
DB_CA="${DAST_DATABASE_CA:-}"
if [ -z "$DB_CA" ]; then
 for candidate in \
 "${ROOT}/infra/dast/db-ca.crt" \
 /tmp/opencode/pgcerts/ca.crt \
 "${HOME}/.bigcrm/db-ca.crt"; do
 [ -f "$candidate" ] && { DB_CA="$candidate"; break; }
 done
fi
[ -n "$DB_CA" ] && [ -f "$DB_CA" ] || {
 echo " no PostgreSQL CA found."
 echo " Set DAST_DATABASE_CA=/path/to/ca.crt (or place it at infra/dast/db-ca.crt)."
 echo " Production requires verify-full, so the scan will not run with less."
 exit 2; }
cp "$DB_CA" "$CERT_DIR/db-ca.crt"
chmod 644 "$CERT_DIR/db-ca.crt"
echo " database TLS: verify-full (CA from $DB_CA)"

echo
echo "=== 2. Start the target (${API_C}) with production settings ==="
docker rm -f "$API_C" >/dev/null 2>&1 || true
# `--network-alias bigcrm-api` is what the terminator's proxy_pass targets;
# without it nginx fails at startup with "host not found in upstream".
docker run -d --name "$API_C" --network bigcrm_default --network-alias bigcrm-api \
 -v "$CERT_DIR/db-ca.crt:/certs/db-ca.crt:ro" \
 -e NODE_ENV=production \
 -e PORT=3000 -e HOST=0.0.0.0 -e LOG_LEVEL=warn \
 -e DATABASE_URL="${DAST_DATABASE_URL:-postgres://bigcrm:bigcrm_dev_password@db:5432/bigcrm}" \
 -e DATABASE_SSL=verify-full \
 -e DATABASE_SSL_CA_FILE=/certs/db-ca.crt \
 -e JWT_ISSUER=bigcrm.dast -e JWT_AUDIENCE=bigcrm.dast.api \
 -e JWT_ACCESS_SECRET='dast-access-secret-0123456789abcdef0123456789abcdefghij' \
 -e JWT_REFRESH_SECRET='dast-refresh-secret-0123456789abcdef0123456789abcdefghij' \
 -e SECRETS_PEPPER='dast-pepper-0123456789abcdef0123456789abcdefghijklmn' \
 -e STORAGE_SIGNING_SECRET='dast-storage-secret-0123456789abcdef0123456789abcdef' \
 -e APP_ORIGINS="https://localhost:${PORT}" \
 bigcrm-api:final >/dev/null 2>&1

for _ in $(seq 1 60); do
 H=$(docker exec "$API_C" node -e \
 "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))" \
 2>/dev/null)
 [ -n "$H" ] && break
 sleep 1
done
echo " health: ${H:-DID NOT START}"

echo
echo "=== 3. Start the TLS terminator (${PROXY_C}) ==="
docker rm -f "$PROXY_C" >/dev/null 2>&1 || true
docker run -d --name "$PROXY_C" --network bigcrm_default -p "${PORT}:8443" \
 -v "${ROOT}/infra/dast/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
 -v "$CERT_DIR/dast.crt:/etc/nginx/certs/dast.crt:ro" \
 -v "$CERT_DIR/dast.key:/etc/nginx/certs/dast.key:ro" \
 nginx:1.27-alpine >/dev/null 2>&1
for _ in $(seq 1 30); do
 [ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 2 "https://localhost:${PORT}/health" 2>/dev/null)" = "200" ] && break
 sleep 1
done
HOP=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://localhost:${PORT}/health" 2>/dev/null)
echo " https://localhost:${PORT}/health -> ${HOP}"
[ "$HOP" = "200" ] || { echo "target did not come up"; exit 2; }

echo " production headers present through the chain:"
curl -sIk "https://localhost:${PORT}/health" | grep -iE '^strict-transport-security|^content-security-policy|^permissions-policy' \
 | cut -c1-100 | sed 's/^/ /'

echo
echo "=== 4. Start ZAP (${ZAP_C}) as a daemon and MITM proxy ==="
docker pull ghcr.io/zaproxy/zaproxy:stable >/dev/null 2>&1 || {
 echo "could not pull ghcr.io/zaproxy/zaproxy:stable"; exit 2; }
echo " ghcr.io/zaproxy/zaproxy:stable"

# ZAP's working directory holds ~180 MB of vendored HUD JavaScript and its own
# caches. That is scanner state, not evidence, so it goes to a temp dir rather
# than into the repository -- leaving it under docs/evidence/ also put it under
# ESLint's feet and produced 107 parse errors unrelated to this codebase.
ZAP_HOME="${TMPDIR:-/tmp}/bigcrm-zap-home"
mkdir -p "$ZAP_HOME"
docker rm -f "$ZAP_C" >/dev/null 2>&1 || true
docker run -d --name "$ZAP_C" --network host \
 -v "$ZAP_HOME:/zap/wrk" \
 --entrypoint /zap/zap.sh \
 ghcr.io/zaproxy/zaproxy:stable \
 -daemon -host 127.0.0.1 -port "$ZAP_API_PORT" -dir /zap/wrk -silent \
 -config api.disablekey=true >/dev/null 2>&1

ZAP_UP=""
for _ in $(seq 1 90); do
 ZAP_UP=$(curl -s --max-time 3 "http://127.0.0.1:${ZAP_API_PORT}/JSON/core/view/version/" 2>/dev/null)
 [ -n "$ZAP_UP" ] && break
 sleep 2
done
echo " version: ${ZAP_UP:-NOT RESPONDING}"
[ -n "$ZAP_UP" ] || { echo "ZAP did not start"; exit 2; }

echo
echo "=== 5. Drive the API surface through the ZAP proxy ==="
# Every route is requested twice: unauthenticated, and with a credential-shaped
# body. The second form matters because several passive rules (including the
# authentication-identified rule and the login-CSRF check) only fire on a
# request that looks like a login. All responses are recorded and passively
# scanned by ZAP; no active fuzzing is performed by this script.
# The API prefix is `/api/v1`, not `/v1` -- the earlier list used the wrong one and
# every driven request hit the 404 handler, so the report described the 404
# handler 68 times rather than the application. The list below is generated from
# the actual routers, not from memory: an API whose routes are asserted by
# memory is an API whose scan covers nothing.
ROUTES=(
 # `/`, `/robots.txt` and `/sitemap.xml` were listed here until 2026-10-12 and
 # have never existed on this server: `routes/v1/health.ts` implements `/health`
 # and `/ready` and nothing else is mounted at the root. The SPA, robots.txt and
 # the sitemap belong to the edge that fronts the API, not to the API container.
 # They were harmless dead entries until the 404 liveness check added below
 # started flagging them, which is the check doing its job.
 /health /ready
 /api/v1/auth/register /api/v1/auth/login /api/v1/auth/refresh /api/v1/auth/logout
 /api/v1/auth/logout-all /api/v1/auth/me /api/v1/auth/sessions
 /api/v1/auth/password /api/v1/auth/password/forgot /api/v1/auth/password/reset
 /api/v1/auth/verify-email /api/v1/auth/verify-email/resend
 /api/v1/auth/mfa/status /api/v1/auth/mfa/enroll /api/v1/auth/mfa/enroll/confirm
 /api/v1/auth/mfa/challenge /api/v1/auth/mfa/recovery-codes /api/v1/auth/mfa/disable
 /api/v1/org/ /api/v1/org/roles /api/v1/org/members
 /api/v1/org/invitations /api/v1/org/invitations/preview /api/v1/org/invitations/accept
 /api/v1/org/teams /api/v1/org/members/transfer-ownership
 /api/v1/contacts /api/v1/companies /api/v1/leads /api/v1/deals
 /api/v1/pipelines /api/v1/pipeline_stages /api/v1/tasks /api/v1/notes /api/v1/tags
 /api/v1/deals/stage /api/v1/leads/convert
 # Second wave (2026-10-12): reports, custom fields, attachments, transfers,
 # audit, notifications, activities, saved views. These are the
 # paths added after the first scan -- a scan whose route list predates the
 # code it scans proves nothing about the new surface. Path-parameter routes
 # get a fixed well-formed UUID so the request exercises real routing and
 # parameter handling rather than failing at a generic 400 first.
 # Calendar (2026-10-14): month agenda, invitee directory and meeting
 # scheduling/invites. POST-only routes are covered by the anonymous-POST
 # half of the scan like every other state-changing path below.
 /api/v1/reports/pipeline /api/v1/reports/lead-funnel
 /api/v1/reports/task-load /api/v1/reports/overview
 /api/v1/custom-fields/contacts /api/v1/custom-fields/contacts/00000000-0000-0000-0000-000000000001
 /api/v1/attachments/contacts/00000000-0000-0000-0000-000000000001
 /api/v1/transfers/exports
 /api/v1/org/audit-logs
 /api/v1/notifications
 /api/v1/activities/contact/00000000-0000-0000-0000-000000000001
 /api/v1/views
 /api/v1/calendar /api/v1/calendar/invitees
)
PRX="http://127.0.0.1:${ZAP_API_PORT}"
n=0
missing=""
MISSING_N=0
for path in "${ROUTES[@]}"; do
 # Capture the status rather than discarding it. A route that does not exist
 # in the image under scan answers 404, and a scan that quietly requests 14
 # routes the image has never heard of reports "all clear" while having
 # examined nothing. That is how the first re-run of this script produced a
 # clean bill of health against an image built the day before those routes
 # existed.
 code=$(curl -sk -x "$PRX" -o /dev/null -w '%{http_code}' --max-time 8 \
 "https://localhost:${PORT}${path}" 2>/dev/null)
 if [ "$code" = "404" ]; then
 missing="${missing} ${path}"
 MISSING_N=$((MISSING_N + 1))
 fi
 # The CSRF guard (middleware/security.ts) rejects a state-changing request
 # with no Origin, so the POST carries the target's own configured origin --
 # what a real browser client sends.
 curl -sk -x "$PRX" -o /dev/null --max-time 8 \
 -H 'Content-Type: application/json' -H "Origin: https://localhost:${PORT}" \
 -d '{"email":"pentester@example.com","password":"Password1!","orgName":"DAST"}' \
 "https://localhost:${PORT}${path}" 2>/dev/null
 n=$((n + 2))
done
echo " ${#ROUTES[@]} routes × (GET + anonymous POST) = ${n} requests sent through the proxy"
if [ "$MISSING_N" -gt 0 ]; then
 echo
 echo " !! ${MISSING_N} route(s) answered 404 -- they do not exist in the image being scanned."
 echo " The scan below is NOT evidence for these routes. Rebuild the image first:"
 for m in $missing; do echo " ${m}"; done
 echo " docker build -t bigcrm-api:final ."
 SCAN_INVALID=1
else
 echo " every scanned route exists in the image (no 404s)"
 SCAN_INVALID=0
fi
echo " waiting for passive scanning to settle..."
sleep 10

echo
echo "=== 6. Collect alerts ==="
ALERTS_JSON="${OUT_DIR}/zap-alerts.json"
curl -s --max-time 60 "http://127.0.0.1:${ZAP_API_PORT}/JSON/core/view/alerts/?baseFormat=json" \
 > "$ALERTS_JSON" 2>/dev/null
python3 - "$ALERTS_JSON" "$OUT_DIR/zap-baseline.json" "$OUT_DIR/zap-baseline.html" \
 "http://127.0.0.1:${ZAP_API_PORT}" <<'PY'
import json, os, sys, urllib.request

alerts_path, json_path, html_path, base = sys.argv[1:5]
try:
 data = json.load(open(alerts_path))
except Exception as e:
 print(f" could not read alerts: {e}"); sys.exit(1)
alerts = data.get("alerts", [])
json.dump({"alerts": alerts}, open(json_path, "w"), indent=2)

# The HTML report is what a human reads during a release gate. ZAP generates it
# from the same alert set, so the two cannot drift apart.
try:
 with urllib.request.urlopen(f"{base}/OTHER/core/other/htmlreport/", timeout=120) as r:
 open(html_path, "wb").write(r.read())
 print(f" html report: {html_path}")
except Exception as e:
 print(f" html report unavailable: {e}")
PY

echo
echo "=== 7. Summarise ==="
COVERAGE="${n}" ALERTS_JSON="$ALERTS_JSON" python3 - "$REPORT" "$PORT" <<'PY'
import json, os, sys, collections

report, port = sys.argv[1], sys.argv[2]
path = os.environ.get("ALERTS_JSON", "")
coverage_raw = os.environ.get("COVERAGE", "?")
try:
 coverage = int(coverage_raw)
except (TypeError, ValueError):
 coverage = None

try:
 alerts = json.load(open(path)).get("alerts", [])
except Exception:
 alerts = []

# Group by (alert, risk, confidence). Deduplicating on the alert name alone
# would hide that the same finding appears on many routes, which is exactly the
# information that tells an operator how wide the exposure is.
groups = collections.defaultdict(list)
for a in alerts:
 groups[(a.get("alert", "?"), a.get("risk", "?"), a.get("confidence", "?"))].append(a)

order = {"High": 0, "Medium": 1, "Low": 2, "Informational": 3, "None": 4}
rows = sorted(groups.items(), key=lambda kv: (order.get(kv[0][1], 9), -len(kv[1])))

counts = collections.Counter(a.get("risk", "?") for a in alerts)

lines = [
 "# DAST -- OWASP ZAP scan",
 "",
 f"Target: `https://localhost:{port}` (nginx TLS terminator -> `bigcrm-api:final`,",
 "`NODE_ENV=production`, PostgreSQL over `verify-full`).",
 "Scanner: `ghcr.io/zaproxy/zaproxy:stable`, passive scan rules at WARN threshold.",
 "",
 "Every route was requested through ZAP's MITM proxy rather than left to the",
 "spider. ZAP's spider discovers routes by following HTML links; this API returns",
 "JSON and a 404 root, so a spidered baseline covered four URLs and said nothing",
 "about the application. Driving the requests directly is what makes this report",
 "describe the real surface.",
 "",
 "| Metric | Value |",
 "|---|---|",
 f"| Requests sent through the proxy | {coverage_raw} |",
 f"| Routes driven | {(coverage // 2) if coverage is not None else '?'} (each requested anonymously, then with a credential-shaped body) |",
 f"| Distinct URLs raising an alert | {len({a.get('url') for a in alerts})} |",
 f"| Total alert instances | {len(alerts)} |",
 "",
 "| Risk | Instances |",
 "|---|---:|",
]
for r in ("High", "Medium", "Low", "Informational"):
 if counts.get(r):
 lines.append(f"| {r} | {counts[r]} |")
lines.append("")

if rows:
 lines += ["## Findings", ""]
 for (name, risk, conf), items in rows:
 urls = sorted({i.get("url", "?") for i in items})
 lines += [f"### {name}", "",
 f"- **Risk:** {risk} - **Confidence:** {conf} - **Instances:** {len(items)}",
 f"- **Evidence:** `{(items[0].get('evidence') or '').strip()[:160]}`",
 f"- **First seen on:** `{urls[0]}`" + (f" (+{len(urls) - 1} more)" if len(urls) > 1 else ""),
 ""]
 sol = (items[0].get("solution") or "").strip()
 if sol:
 lines += ["> " + sol.split("\n")[0][:400], ""]
else:
 lines += ["**No alerts raised.**", ""]

lines += [
 "## What this scan can and cannot establish",
 "",
 "- **Can:** that the production image, behind a TLS terminator and with its",
 " production headers (HSTS, CSP, X-Frame-Options, nosniff, referrer policy,",
 " permissions policy), does not trip ZAP's passive rules on the routes reachable",
 " without credentials; that response headers, cache directives and cookie flags",
 " behave as configured; that no server banner leaks implementation detail.",
 "- **Cannot:** prove the absence of broken access control. Every authenticated",
 " route returned 401 to the scanner, which is correct, but it also means those",
 " handlers were never exercised. Tenant isolation is covered by the cross-tenant",
 " suite in `server/src/tests` and by the 14 scenarios of RULE 224.",
 "- **Cannot:** cover the React SPA. This scan targets the API. The client is",
 " same-origin with no server-rendered surface, so DOM-XSS would not appear here.",
 " That gap is recorded in docs/PROJECT_STATUS.md rather than left implicit.",
 "- **Passive only.** This script sends no fuzzed payloads; it evaluates the",
 " responses to well-formed requests. An authenticated active scan against a",
 " seeded tenant is a separate, larger exercise and is not claimed here.",
 "",
 "## Reproduce",
 "",
 "```bash",
 "docker build -t bigcrm-api:final .",
 "infra/scripts/dast-scan.sh",
 "DAST_REPRO=1 infra/scripts/dast-scan.sh # leave target + ZAP up for manual probing",
 "```",
 "",
]
open(report, "w").write("\n".join(lines) + "\n")

print(f" alerts: {len(alerts)} instances across {len(rows)} distinct findings")
for (name, risk, conf), items in rows:
 print(f" {len(items):3d} {risk:14s} {name[:66]}")
print(f" report: {report}")
PY

echo
echo " raw: ${ALERTS_JSON}"

if [ "${SCAN_INVALID:-0}" != "0" ]; then
 echo
 echo "RESULT: INVALID -- ${MISSING_N} route(s) did not exist in the scanned image."
 echo " The alert counts above are not evidence for the whole surface."
 exit 1
fi
echo
echo "RESULT: valid -- all ${#ROUTES[@]} scanned routes existed in the scanned image."
