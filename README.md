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
