# StockSense — AI Inventory Forecasting

Predict stockouts 2–4 weeks ahead for Shopify / BigCommerce / WooCommerce stores.
Full app: store connect (OAuth), order/inventory sync, nightly AI forecasts,
risk dashboard, per-SKU settings, and daily email alerts.

## Architecture

```
Store (Shopify / BigCommerce / WooCommerce)
   │  OAuth install + webhooks (orders, inventory, uninstall)
   ▼
Node.js server (Express/TS)  ── serves /dashboard UI + REST API
   │  sync layer writes order_lines -> daily_sales, products/variants
   ▼
PostgreSQL ──► Python forecast worker (statsforecast, nightly 02:00)
                   │  writes forecasts + stock_risk
                   ▼
            Dashboard + daily email digest (Resend)
```

## Tech Stack

| Component | Language / Runtime | Frameworks & Key Libraries | Description |
|---|---|---|---|
| **Frontend (App / Dashboard)** | **HTML5, CSS3, JavaScript (ES6+)** | Vanilla JS, Canvas API, PWA (Service Worker) | Lightweight, responsive dashboard UI with interactive demand charts, store connection flows, and SKU drawer — zero build step required. |
| **Backend Server & API** | **TypeScript (Node.js)** | Express.js, Axios, node-cron, pg (node-postgres), Resend | Multi-platform OAuth, webhook ingestion, data sync pipelines, REST API endpoints, session auth, and scheduled alert digests. |
| **Forecast & ML Worker** | **Python 3** | StatsForecast (Nixtla), Pandas, NumPy, Psycopg2 | Background time-series prediction engine running AutoETS, Croston SBA, and moving average models to calculate stockout risks. |
| **Database** | **SQL** | PostgreSQL 16 | Relational schema storing stores, product variants, daily aggregated sales, forecast outputs, and sync job queues. |
| **DevOps & Infrastructure** | **YAML / Docker** | Docker, Docker Compose, ngrok / Cloudflare Tunnel | Containerized multi-service deployment (db + server + worker) with local tunnel support for webhooks. |

### Languages & Frameworks by Component

- **App / Frontend**:
  - **Language**: **JavaScript (ES6+) / HTML5 / CSS3**
  - **Framework / Libraries**: Vanilla (no external frontend framework required).
  - **Highlights**: Built with pure HTML/CSS/JS for high performance and zero build complexity. Features custom CSS dark-mode design tokens, native HTML5 `<canvas>` charting for 90-day sales and 8-week forecast curves, responsive layout, and Progressive Web App (PWA) support (`manifest.webmanifest`, `sw.js`).

- **Backend**:
  - **Language**: **TypeScript** (running on **Node.js**)
  - **Framework / Libraries**: **Express.js**, `pg` (PostgreSQL client), `axios` (platform API integrations), `jsonwebtoken` & `cookie-parser` (authentication), `node-cron` (scheduled syncs and alerts).
  - **Highlights**: Handles Shopify / BigCommerce / WooCommerce OAuth flows, raw-body HMAC webhook validation, initial backfill and incremental sync engines, and REST endpoints for the dashboard.

- **Forecasting & ML Worker**:
  - **Language**: **Python 3**
  - **Framework / Libraries**: **StatsForecast** (Nixtla), **Pandas**, **NumPy**, **Psycopg2**.
  - **Highlights**: High-performance statistical time-series forecasting (AutoETS for seasonal demand, Croston SBA for intermittent demand, moving average for sparse history). Computes days of cover, projected stockout dates, reorder points, and revenue at risk.

- **Database**:
  - **Language**: **SQL**
  - **Engine**: **PostgreSQL 16**
  - **Highlights**: Relational data model (`schema.sql`) maintaining multi-tenant store records, products/variants, daily sales rollups, forecasts, risk assessments, and job queue status.

## Repo layout

```
stocksense/
├── schema.sql                 # Postgres schema (auto-applied by docker-compose)
├── docker-compose.yml         # db + server + worker
├── .env.example               # copy to .env and fill in
├── server/                    # Node/Express/TypeScript
│   ├── src/
│   │   ├── index.ts           # app entry, cron (incremental sync, alerts)
│   │   ├── config.ts, db.ts
│   │   ├── platforms/         # adapter interface + shopify/bigcommerce/woocommerce
│   │   ├── routes/            # auth (OAuth flows), webhooks, api
│   │   ├── sync/sync.ts       # initial backfill, incremental sync, aggregation
│   │   └── alerts/email.ts    # daily digest via Resend
│   └── public/                # dashboard UI (index.html) + connect page
└── worker/
    ├── forecast_worker.py     # nightly forecasts + risk computation
    └── requirements.txt
```

## How to start on your laptop and phone

Everything runs on the laptop. The phone app reaches it through the ngrok
tunnel at `https://shiftless-uncle-occupier.ngrok-free.dev`, so the laptop
must be on, awake and running the backend whenever you use the app.

**You need:** Docker Desktop, Node.js 20+, ngrok (signed in, with the fixed
domain) on the laptop, and the **Expo Go** app on the phone (Play Store or
App Store).

### 1. Start the backend (laptop, every time)

In a terminal in the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-stocksense.ps1
```

It starts Docker Desktop, the database, server and worker, waits for the
server, then starts the ngrok tunnel. It takes about 30 seconds and is safe to
run twice. Check it: http://localhost:3000/health shows `{"ok":true}`.

Optional, once: run it automatically at every Windows sign-in with
`powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1`
(see the next sections).

### 2. Use it on the laptop

| What | Address |
| --- | --- |
| Web dashboard | http://localhost:3000/dashboard |
| Connect a store | http://localhost:3000/ |
| API docs and live console | http://localhost:3000/docs |
| Mobile app in a browser | http://localhost:8081 (after step 3) |

### 3. Start the mobile app (laptop, second terminal)

The app is in the `mobile` folder; running Expo from the project root fails.

```powershell
cd mobile
npm install        # first time only
npx expo start
```

Keep this terminal open: Expo Go loads the app from it each time it opens.
Press **w** to open the app in the laptop's browser.

### 4. Open it on the phone

1. Put the phone on the same Wi-Fi as the laptop (or start Expo with
   `npx expo start --tunnel` to scan from any network).
2. Open **Expo Go** and scan the QR code in the terminal (on iPhone, scan it
   with the Camera app).
3. The first time, choose the platform on the Connect screen and paste the
   store's API token. After that the app opens on the dashboard and works on
   Wi-Fi or mobile data.

### If it does not work

| Symptom | Fix |
| --- | --- |
| "Cannot reach the server" | The backend or ngrok is down: run step 1 again |
| Phone cannot connect at all | Open the ngrok address above in the phone's browser; if it does not load, ngrok is not running on the laptop |
| QR code does not load the app | Phone and laptop are on different networks: use `npx expo start --tunnel` |
| "Session expired" | Connect the store again from the app |
| `ConfigError` about `package.json` | You ran Expo in the project root: `cd mobile` first |

To stop everything: `docker compose stop` in the project folder, close the
Expo terminal (Ctrl+C), and stop the tunnel with
`Stop-Process -Name ngrok` in PowerShell.

The app screens cover the dashboard, products, alerts and settings. Purchase
orders, suppliers, transfers, Ask StockSense and WhatsApp work through the API
(`/docs`) but have no app screens yet.

## Quick start (Docker)

```bash
cp .env.example .env     # fill in APP_URL, SESSION_SECRET, platform keys
docker compose up --build
```

- Connect page: http://localhost:3000/
- Dashboard:    http://localhost:3000/dashboard
- DB schema is applied automatically on first boot.
- The worker runs a forecast at container start, again within ~30s of any
  store finishing its first sync (the server queues a `forecast` job in
  `sync_jobs`), and then nightly at 02:00 UTC.

For OAuth installs and webhooks in dev, expose the server over HTTPS
(`ngrok http 3000` or `cloudflared tunnel`) and set that URL as `APP_URL`.

## Start automatically at Windows sign-in (local setup)

`scripts/start-stocksense.ps1` starts Docker Desktop if needed, runs
`docker compose up -d`, waits for `/health`, and starts the ngrok tunnel on
the fixed domain in the background. It is safe to run twice. Log:
`%LOCALAPPDATA%\StockSense\startup.log`.

Register it once so it runs at every sign-in (adds `StockSense.cmd` to your
Startup folder, no admin rights; `-Remove` undoes it):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

The containers already use `restart: unless-stopped`, so once Docker is up
they return on their own. Alternatively turn on Docker Desktop > Settings >
General > "Start Docker Desktop when you sign in", but ngrok still needs the
script.

## Quick start (no Docker, e.g. your EC2)

```bash
createdb stocksense && psql stocksense < schema.sql

# server
cd server && npm install && npm run build
DATABASE_URL=postgres://... APP_URL=https://... node dist/index.js

# worker: either keep it running (polls for newly connected stores + nightly run)
cd worker && pip install -r requirements.txt
DATABASE_URL=postgres://... python forecast_worker.py --loop
# ...or use system cron for the nightly run plus a frequent queue check:
#   0 2 * * *   DATABASE_URL=postgres://... python /path/to/forecast_worker.py
#   * * * * *   DATABASE_URL=postgres://... python /path/to/forecast_worker.py --queued
```

## Mobile app (`mobile/`)

An Expo (React Native + TypeScript) app for Android and iOS that uses the same
REST API as the dashboard. It signs in with a bearer token: the token-connect
endpoints return `token` in their JSON, and the API accepts
`Authorization: Bearer <token>` as well as the session cookie.

```bash
cd mobile && npm install
npx expo start            # scan the QR code with the Expo Go app on your phone
```

- The server URL is in `mobile/src/config.ts` (the ngrok tunnel while the
  server runs on your laptop) and can be changed in the app under Settings.
- Screens: connect (BigCommerce / Shopify / WooCommerce token), dashboard
  with summary cards, risk filters and search, product detail with the
  sales + forecast chart and reorder settings, alerts, and settings with a
  store switcher.
- Installable build: `npm install -g eas-cli && eas build -p android --profile preview`
  produces an APK through Expo's free build service.

## Platform app setup

**BigCommerce** (devtools.bigcommerce.com → Create app)
- Auth callback: `{APP_URL}/auth/bigcommerce/callback`
- Load callback: `{APP_URL}/auth/bigcommerce/load`
- OAuth scopes: Orders read-only, Products read-only
- Put Client ID/Secret in `.env` (`BC_CLIENT_ID`, `BC_CLIENT_SECRET`)

**Shopify** (partners.shopify.com → Create app)
- Redirect URL: `{APP_URL}/auth/shopify/callback`
- Scopes requested: `read_products,read_orders,read_inventory`
  (read_orders beyond 60 days needs "read all orders" access approval)
- Put API key/secret in `.env`; merchants connect at `/` or via `/auth/shopify?shop=x.myshopify.com`

**WooCommerce** — no app registration. Merchant pastes site URL + REST API
consumer key/secret (WooCommerce → Settings → Advanced → REST API, Read access)
on the connect page.

## How forecasting works (per SKU, nightly)

| Demand pattern | Model |
|---|---|
| <60 days history or <10 sale days | 28-day moving average |
| >60% zero-demand days (intermittent) | Croston SBA |
| Regular demand | AutoETS (weekly seasonality) |

Derived per SKU: days of cover, projected stockout date, reorder point
(lead-time demand + safety stock), suggested reorder quantity, revenue at risk.

Risk levels: **critical** (stocks out before a reorder can arrive) /
**low_stock** (at/below reorder point) / **healthy** / **overstocked**
(>120 days cover) / **no_demand** / **untracked** (the platform does not
track stock for the product, so only the demand forecast and reorder quantity
are known; the dashboard explains how to turn tracking on). Lead time and
safety stock are editable per SKU in the dashboard drawer.

## REST API (`/api/v1`) and webhooks

The API from chapter 14 of the user guide, plus every other feature in the
guide. Base URL `{APP_URL}/api/v1` (also served at `/v1` for earlier
integrations). Interactive docs with a live console: `{APP_URL}/docs`;
spec: `{APP_URL}/api/v1/openapi.json`.

- **Keys (Pro):** `ss_live_...` reads and writes; **sandbox** `ss_test_...` reads
  live data but rolls back every write (responses say `"sandbox": true`). Create
  and revoke with the app session (`POST /api/v1/api-keys {name, sandbox}`, or
  the mobile app's Settings > API keys). Only a SHA-256 hash is stored; the full
  key is shown once; each key sees one store. The StockSense app's own session
  token is also accepted, without the Pro requirement.
- **Auth:** `Authorization: Bearer <key>` or `X-API-Key: <key>`. 120 requests a
  minute per key (`X-RateLimit-*`, `429` + `Retry-After`).
- **Shapes:** `{ "data": {...} }`; lists `{ "data": [...], "page", "limit", "total", "has_more" }`;
  errors `{ "error": { "type", "code", "message", "field"? } }`; `402` = not in the plan;
  every response has `X-Request-Id`. Writes run in one transaction.

| Area | Endpoints |
| --- | --- |
| Forecasts | `GET /forecasts?status=&location_id=&q=&sort=&limit=(≤250)&page=`, `GET /forecasts.csv`, `GET /forecasts/{variantId}` (daily series, 80% band, stock curve), `PATCH /forecasts/{variantId}/settings`, `POST /forecasts/rebuild`, `GET /jobs/{id}` |
| Reorder | `GET /reorder/{variantId}?supplier_id=&coverage_days=&lead_time_days=&case_pack=&min_order_qty=`, `POST /reorder/{variantId}/preferences`, `POST /reorder/{variantId}/purchase-order` |
| Purchase orders | `GET/POST /purchase-orders`, `GET/PATCH /purchase-orders/{id}`, `POST /purchase-orders/{id} {"action": "approve"\|"send"\|"cancel"\|"receive"}`, `GET /purchase-orders/{id}/csv`, `POST /purchase-orders/refresh-drafts` |
| Suppliers | `GET /suppliers`, `POST /suppliers` (create, or update with `id`), `GET/PATCH/DELETE /suppliers/{id}`, `GET /vendors`, `GET /categories` |
| Alerts | `GET /alerts?status=open\|dismissed\|resolved&type=`, `GET /alerts/{id}`, `POST /alerts/{id} {"action": "dismiss"\|"reopen"}`, `POST /alerts/check` |
| Locations, transfers | `GET/POST /locations`, `PATCH /locations/{id}`, `GET/PUT /locations/{id}/inventory`, `GET /transfers/suggestions`, `GET/POST /transfers`, `GET /transfers/{id}`, `POST /transfers/{id} {"action": "ship"\|"receive"\|"cancel"}` |
| Insights, plan | `GET /dashboard?location_id=`, `GET /summary`, `GET /store`, `GET /plan` |
| Settings | `GET/PATCH /settings/forecasting`, `GET/PATCH /settings/notifications`, `POST /settings/notifications/test`, `GET/POST /promotions`, `PATCH/DELETE /promotions/{id}` |
| Webhooks | `GET/POST /webhooks`, `PATCH/DELETE /webhooks/{id}`, `POST /webhooks/{id}/test`, `GET /webhooks/{id}/deliveries` |
| Data & sync | `GET /data/status`, `POST /data/rebuild`, `POST /data/reimport`, `POST/DELETE /data/demo` |
| Ask StockSense | `POST /ask`, `GET /ask/usage`, `GET/POST/DELETE /ask/conversations`, `GET/PATCH/DELETE /ask/conversations/{id}`, `POST /ask/conversations/{id}/messages` |
| WhatsApp | `GET /whatsapp`, `POST /whatsapp/link-codes`, `GET /whatsapp/numbers`, `PATCH/DELETE /whatsapp/numbers/{id}`, `GET /whatsapp/activity`, `POST /whatsapp/simulate` |
| Products (v1 shape) | `GET /products`, `GET/PATCH /products/{id}` |

**Webhooks** (Pro): events `alert.stockout_risk`, `alert.reorder_point`,
`alert.velocity_shift`, `alert.lead_time_drift`, `alert.overstock`,
`purchase_order.approved`, `purchase_order.sent`, `purchase_order.received`
(or `*`). Each delivery carries `X-StockSense-Timestamp` and
`X-StockSense-Signature: sha256=hex(HMAC_SHA256(secret, timestamp + "." + body))`;
failures are retried after 30 s, 5 min, 30 min and 2 h.

```bash
curl -H "Authorization: Bearer ss_live_..." "$APP_URL/api/v1/forecasts?status=reorder_now"
curl -X POST -H "Authorization: Bearer ss_live_..." -H "Content-Type: application/json" \
  -d '{"supplier_id": 3, "lines": [{"variant_id": 41, "quantity": 120}]}' "$APP_URL/api/v1/purchase-orders"
```

**Server settings for the optional parts** (`.env`): `ANTHROPIC_API_KEY`
(Ask StockSense and AI answers on WhatsApp; `ASK_MODEL` overrides the model),
`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_NUMBER`,
`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ALERT_TEMPLATE`
(the Meta webhook URL is `{APP_URL}/webhooks/whatsapp`), `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (SMS alerts), `RESEND_API_KEY` (email alerts
and purchase orders to suppliers). Without them those features report that
they are not configured; everything else works.

**Tests:** `python -I server/test/api_e2e.py` runs 107 end-to-end checks against
a demo store (start the server with `WEBHOOKS_ALLOW_HTTP=true docker compose up -d server`
so the local webhook receiver can be used).

## App API (session-cookie or session bearer auth; `?store_id=N` works in dev)

- `GET /api/store` — store + sync status
- `GET /api/summary` — header cards (SKUs tracked, at risk, critical, revenue at risk)
- `GET /api/risks?level=critical,low_stock&q=term` — risk table
- `GET /api/variants/:id` — detail: 90d history + forecast curve + risk
- `PATCH /api/variants/:id` — `{lead_time_days, safety_stock}`
- `GET /api/alerts`, `POST /api/alerts/:id/ack`

## Costs

Everything runs free: Postgres (Neon/Supabase free tier or your EC2),
server+worker on the same small VM, Resend free tier for alert emails.
No LLM is needed for forecasting.

## Production hardening checklist (before marketplace submission)

- Encrypt `stores.access_token` at rest (e.g. pgcrypto or app-level AES)
- Per-store owner email (add `owner_email` to stores; capture on install)
- GDPR webhooks for Shopify (`customers/data_request`, `customers/redact`, `shop/redact`)
- Switch Shopify REST calls to GraphQL Admin API before REST deprecation applies to new apps
- Rate-limit `/auth/woocommerce/connect`; validate Woo credentials with a test call before saving
- Move incremental syncs to a job queue (BullMQ) once store count grows
