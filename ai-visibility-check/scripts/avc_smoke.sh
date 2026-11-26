#!/usr/bin/env bash
# Post-deploy smoke test. Read-only or rejected requests only: no order is created,
# no payment, no email. Usage: avc_smoke.sh <base-url>
set -u
if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <base-url>   e.g. $0 https://example.com" >&2
  exit 2
fi
BASE="${1%/}"
FAILS=0
BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT

# check <label> <expected-status> <body-grep-or-empty> <curl args...>
check() {
  local label="$1" want="$2" pat="$3"; shift 3
  local code
  code="$(curl -sS -m 30 -o "$BODY" -w '%{http_code}' "$@" 2>/dev/null)" || code="000"
  if [ "$code" = "$want" ] && { [ -z "$pat" ] || grep -Eq "$pat" "$BODY"; }; then
    echo "PASS $label (HTTP $code)"
  else
    echo "FAIL $label (got HTTP $code, want $want${pat:+ with body matching $pat})"
    FAILS=$((FAILS + 1))
  fi
}

JSON=(-H 'Content-Type: application/json')
check "GET /health"                       200 ""  "$BASE/health"
check "GET /"                             200 ""  "$BASE/"
check "POST /api/polar/webhook bad sig"   401 ""  -X POST "${JSON[@]}" \
  -H 'webhook-id: smoke' -H 'webhook-timestamp: 1' -H 'webhook-signature: v1,invalid' \
  -d '{"type":"smoke"}' "$BASE/api/polar/webhook"
check "POST /api/intake non-US city"      400 ""  -X POST "${JSON[@]}" \
  -d '{"business":"Smoke Test","city":"Paris, FR","niche":"dentist","email":"smoke@example.invalid"}' \
  "$BASE/api/intake"
check "POST /api/check dentist Austin TX" 200 '"status": ?"instant"' -X POST "${JSON[@]}" \
  -d '{"business":"Smoke Test","city":"Austin, TX","niche":"dentist"}' "$BASE/api/check"

if [ "$FAILS" -ne 0 ]; then echo "SMOKE FAILED: $FAILS check(s)"; exit 1; fi
echo "SMOKE OK"
