#!/usr/bin/env bash
# End-to-end test of the public /v1 API against the local server.
# Creates a key through the app API (session), exercises every v1 route,
# checks errors and rate-limit headers, then revokes the key.
set -u
B=http://localhost:3000
SESSION=$(docker exec stocksense-server-1 node -e "const jwt=require('jsonwebtoken');require('dotenv').config();console.log(jwt.sign({storeId:6,stores:[1,6]},process.env.SESSION_SECRET,{expiresIn:'10m'}))")
pass=0; failn=0
check() { # name, expected status, actual status
  if [ "$2" = "$3" ]; then echo "PASS  $1 ($3)"; pass=$((pass+1)); else echo "FAIL  $1 expected $2 got $3"; failn=$((failn+1)); fi
}
j() { python -I -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

echo "== key management (session auth)"
CREATED=$(curl -s -X POST -H "Authorization: Bearer $SESSION" -H "Content-Type: application/json" -d '{"name":"E2E test"}' $B/api/keys)
KEY=$(echo "$CREATED" | j "d['key']")
KID=$(echo "$CREATED" | j "d['id']")
echo "created key id=$KID prefix=$(echo "$CREATED" | j "d['prefix']")"
LISTED=$(curl -s -H "Authorization: Bearer $SESSION" $B/api/keys | j "any(k['id']==$KID for k in d['items']) and all('key' not in k and 'key_hash' not in k for k in d['items'])")
check "key listed without secret" True "$LISTED"

echo "== auth"
check "no key -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' $B/v1/store)"
check "bad key -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer ss_live_nope_nope_nope_nope_nope' $B/v1/store)"
check "session token is not an API key -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $SESSION" $B/v1/store)"
check "X-API-Key header works" 200 "$(curl -s -o /dev/null -w '%{http_code}' -H "X-API-Key: $KEY" $B/v1/store)"
H="Authorization: Bearer $KEY"

echo "== reads"
echo "store:   $(curl -s -H "$H" $B/v1/store | j "d['data']")"
echo "summary: $(curl -s -H "$H" $B/v1/summary | j "{k: d['data'][k] for k in ('ready','run_date','counts','revenue_at_risk')}")"
echo "kpis:    $(curl -s -H "$H" $B/v1/summary | j "{k: d['data']['kpis'][k] for k in ('inventory_value','reorder_units','median_cover_days','next_stockout_date')}")"
PL=$(curl -s -H "$H" "$B/v1/products?limit=2")
echo "products page: total=$(echo "$PL" | j "d['total']") has_more=$(echo "$PL" | j "d['has_more']") next_offset=$(echo "$PL" | j "d['next_offset']")"
PID=$(echo "$PL" | j "d['data'][0]['id']")
check "numbers are numbers" True "$(echo "$PL" | j "isinstance(d['data'][0]['id'], int) and isinstance(d['data'][0]['revenue_at_risk'], (int,float))")"
check "filter risk_level=critical" True "$(curl -s -H "$H" "$B/v1/products?risk_level=critical" | j "all(p['risk_level']=='critical' for p in d['data'])")"
check "sort=revenue_at_risk descending" True "$(curl -s -H "$H" "$B/v1/products?sort=revenue_at_risk" | j "(lambda v: v==sorted(v, reverse=True))([p['revenue_at_risk'] for p in d['data']])")"
DET=$(curl -s -H "$H" "$B/v1/products/$PID")
echo "product $PID: $(echo "$DET" | j "{k: d['data'][k] for k in ('title','risk_level','stockout_date','reorder_quantity')} | {'forecast_days': len(d['data']['forecast']['daily']), 'history_days': len(d['data']['sales_history'])}")"

echo "== writes"
OLD=$(echo "$DET" | j "d['data']['settings']['lead_time_days']")
check "PATCH lead_time_days" 11 "$(curl -s -X PATCH -H "$H" -H 'Content-Type: application/json' -d '{"lead_time_days":11}' $B/v1/products/$PID | j "d['data']['settings']['lead_time_days']")"
curl -s -o /dev/null -X PATCH -H "$H" -H 'Content-Type: application/json' -d "{\"lead_time_days\":$OLD}" $B/v1/products/$PID
check "PATCH unknown field -> 400" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "$H" -H 'Content-Type: application/json' -d '{"price":1}' $B/v1/products/$PID)"
check "PATCH negative -> 400" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "$H" -H 'Content-Type: application/json' -d '{"safety_stock":-3}' $B/v1/products/$PID)"
check "bad JSON -> 400" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "$H" -H 'Content-Type: application/json' -d '{oops' $B/v1/products/$PID)"
check "other store's product -> 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -H "$H" $B/v1/products/1)"
check "bad risk_level -> 400" 400 "$(curl -s -o /dev/null -w '%{http_code}' -H "$H" "$B/v1/products?risk_level=urgent")"
check "unknown route -> 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -H "$H" $B/v1/nothing)"
echo "alerts: $(curl -s -H "$H" $B/v1/alerts | j "len(d['data'])") items"

echo "== forecast job"
JOB=$(curl -s -X POST -H "$H" $B/v1/forecasts)
JID=$(echo "$JOB" | j "d['data']['id']")
echo "queued job $JID status=$(echo "$JOB" | j "d['data']['status']")"
for i in $(seq 1 15); do S=$(curl -s -H "$H" $B/v1/forecasts/$JID | j "d['data']['status']"); [ "$S" = "done" ] || [ "$S" = "error" ] && break; sleep 3; done
check "forecast job finishes" done "$S"

echo "== headers"
curl -s -D - -o /dev/null -H "$H" $B/v1/store | grep -iE "x-request-id|x-ratelimit" | tr -d '\r'

echo "== revoke"
curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $SESSION" $B/api/keys/$KID
check "revoked key -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H "$H" $B/v1/store)"

echo "== docs"
check "GET /docs" 200 "$(curl -s -o /dev/null -w '%{http_code}' $B/docs)"
check "openapi.json valid with 9 operations" 9 "$(curl -s $B/v1/openapi.json | j "sum(1 for p in d['paths'].values() for m in p if m in ('get','post','patch','delete'))")"
echo
echo "RESULT: $pass passed, $failn failed"
