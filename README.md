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

## API (session-cookie auth; `?store_id=N` works in dev)

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
