# StockSense Project Report

Oct 28, 2026 · @Pradeep

## Summary

StockSense predicts which products an online store will run out of, when, and how much to reorder, 2 to 8 weeks ahead. It connects to Shopify, BigCommerce and WooCommerce stores, copies their products, stock and orders, and runs a statistical forecast for every SKU each night and right after each sync.

The working product today is a web dashboard, an Android and iOS mobile app that also runs in a PC browser, and a daily email digest. Two stores are connected for testing: a Shopify development store and a BigCommerce sample store, which currently shows 1 critical SKU out of 4 forecast.

Everything runs on one Windows laptop in Docker, exposed through an ngrok tunnel, so it stops when the laptop shuts down. The code is on GitHub at [ShivaniDas-AI/stocksense](https://github.com/ShivaniDas-AI/stocksense).

## How it works

A store goes from connected to forecast in about a minute, then stays current through webhooks and two nightly jobs.

1. **Connect.** The merchant links a store by OAuth or by pasting an API token on the web connect page or in the mobile app. The server checks the token against the platform before saving it.
2. **Backfill.** The server pulls every product and variant with its stock level, then 18 months of paid orders, and rolls the order lines up into units sold per SKU per day.
3. **Forecast.** When the sync finishes the server queues a forecast job. The Python worker picks it up within 30 seconds, forecasts 56 days of demand per SKU and writes a risk level for each.
4. **Stay current.** Store webhooks for new orders and stock changes trigger a 3-day incremental sync after a 60-second debounce, followed by a fresh forecast. A safety sync runs at 01:30 and a full forecast at 02:00 UTC.
5. **Act.** The dashboard and mobile app show at-risk SKUs, stockout dates and reorder quantities. A digest email goes out at 08:00 listing critical and low-stock items, at most once a week per item.

## Architecture and tech stack

The system is three Docker containers plus two front ends, all on one laptop today.

&#91;embedded content: StockSense architecture · 7 parts\]

The server owns everything that talks to the outside world; the worker only reads and writes the database, and the `sync_jobs` table is the queue between them, so no message broker is needed.

| Layer | Technology |
| --- | --- |
| Server | Node.js 20, Express, TypeScript, pg, axios, jsonwebtoken, node-cron |
| Forecast worker | Python 3.11, statsforecast, pandas, numpy, psycopg2 |
| Database | PostgreSQL 16 |
| Web dashboard | Plain HTML, CSS and JavaScript; installable as a PWA |
| Mobile app | Expo SDK 58, React Native 0.88, TypeScript, React Navigation, TanStack Query |
| Infrastructure | Docker Compose, ngrok tunnel, Resend for email, GitHub for code |
| Store APIs | Shopify Admin REST, BigCommerce V2 and V3, WooCommerce REST v3 |

## Forecasting and KPIs

Each SKU gets the simplest model its sales history supports, a 56-day daily forecast, and one of six risk levels. No paid AI service is involved, so forecasting has no per-request cost.

| Sales history of the SKU | Model used |
| --- | --- |
| Under 60 days, or under 10 days with a sale | 28-day moving average |
| More than 60% of days with zero sales | Croston SBA, built for intermittent demand |
| Regular demand | AutoETS with weekly seasonality |

| Risk level | Rule |
| --- | --- |
| Critical | Projected to run out before a reorder placed today can arrive (days of cover at or below lead time) |
| Low stock | Stock at or below the reorder point (lead-time demand plus safety stock) |
| Healthy | Enough cover for the lead time |
| Overstocked | More than 120 days of cover |
| No demand | Forecast demand under 0.01 units a day |
| Untracked | The store does not track stock for this SKU, so only demand and reorder quantity are known |

The dashboard and app show these KPIs, computed on the server for the latest forecast run. Money figures use retail price because the platforms do not supply unit cost.

| KPI | Definition |
| --- | --- |
| SKUs at risk | Critical plus low-stock SKUs |
| Revenue at risk | Sales lost over the 8-week horizon if at-risk SKUs are not reordered |
| Next stockout | Earliest projected stockout date among at-risk SKUs, with the product name |
| Sales, 30 days | Revenue and units sold in the last 30 days, with change against the previous 30 |
| Forecast, 30 days | Units and revenue the forecasts expect over the next 30 days |
| Inventory value | Units on hand across tracked SKUs, at retail price |
| Days of cover | Median days of stock across tracked SKUs with demand, plus the share that are healthy |
| Reorder now | Suggested purchase units and value for critical and low-stock SKUs |
| Overstock | Overstocked SKUs, and the units and value beyond 120 days of demand |
| Sell-through, 30 days | Units sold in 30 days divided by units sold plus on hand |

## Mobile app

The app in the `mobile` folder is built with Expo (React Native and TypeScript), so one codebase runs on Android, iOS and a PC browser. It uses the same REST API as the web dashboard and signs in with a bearer token instead of a cookie.

| Screen | What it shows |
| --- | --- |
| Connect | Platform picker and token fields for BigCommerce, Shopify or WooCommerce, with help on where to find each token |
| Dashboard | Stockout hero card, six KPI tiles, filter chips with counts, search, product cards with risk colour and key metrics |
| Product | Stock, cover, stockout and reorder tiles, a 90-day sales and 8-week forecast chart, lead time and safety stock steppers |
| Alerts | Items from the daily digest, with a dismiss action |
| Settings | Store switcher, server address with a connection test, log out |

The design uses a light neutral palette with one brand blue, colour only for risk meaning, and switches to dark mode with the phone.

**How it reaches the server.** On a phone the app calls the ngrok address, which forwards to the server on the laptop. In a PC browser it calls `http://localhost:3000` directly. The address can be changed under Settings once the server has a permanent domain.

**Run it.** From the `mobile` folder run `npx expo start`. Scan the QR code with the Expo Go app on a phone on the same Wi-Fi, or open `http://localhost:8081` in a browser.

**Build an installable APK.** Run `npx eas-cli build -p android --profile preview`. Expo's free cloud build service produces the file; no Android Studio is needed.

## Work completed

Seven commits on 27 October 2026 took the project from a dashboard stuck on "Syncing" to a working web and mobile product.

| Commit | Change |
| --- | --- |
| [92b0547](https://github.com/ShivaniDas-AI/stocksense/commit/92b0547) | Fixed the phone crash after connecting or switching stores, when the dashboard rendered before its data reloaded |
| [203fe91](https://github.com/ShivaniDas-AI/stocksense/commit/203fe91) | Fixed store switching, which always failed because store ids were stored as text; the browser build now calls the local server directly |
| [246e697](https://github.com/ShivaniDas-AI/stocksense/commit/246e697) | Mobile app runs in a PC browser: web packages, browser storage fallback, CORS on the server |
| [083035e](https://github.com/ShivaniDas-AI/stocksense/commit/083035e) | Professional redesign of every app screen and ten server-computed inventory KPIs |
| [e76d35f](https://github.com/ShivaniDas-AI/stocksense/commit/e76d35f) | Removed a navigation error after the first login |
| [58eeccf](https://github.com/ShivaniDas-AI/stocksense/commit/58eeccf) | First version of the Expo mobile app, plus bearer-token login on the server |
| [69a83ee](https://github.com/ShivaniDas-AI/stocksense/commit/69a83ee) | Initial import; forecast runs right after a sync instead of overnight; untracked products are forecast; dashboard explains each waiting state; `.env` kept out of git |

The root cause of the original stuck dashboard was twofold. The worker only ran at 02:00 UTC, and all sample products had inventory tracking off, so nothing qualified for a forecast.

## Running it

The backend runs only while the laptop is on, and it stopped after each shutdown because Docker Desktop was set not to start at sign-in. A start-up script now brings everything back in about 30 seconds.

`scripts/start-stocksense.ps1` does four things and is safe to run twice:

1. Starts Docker Desktop if it is not running and waits for the engine.
2. Runs `docker compose up -d` for the database, server and worker.
3. Waits for `http://localhost:3000/health` to answer.
4. Starts the ngrok tunnel on the fixed domain in the background.

It logs each step to `%LOCALAPPDATA%\StockSense\startup.log`. A test run on 28 October brought the containers up in 26 seconds and the public address answered `{"ok":true}`.

- [ ] Register the script to run at every sign-in, from the project folder: `powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1` (adds `StockSense.cmd` to the Startup folder; `-Remove` undoes it)

| Address | Used by |
| --- | --- |
| `http://localhost:3000/dashboard` | Web dashboard on this PC |
| `https://shiftless-uncle-occupier.ngrok-free.dev` | Phone app, store webhooks and OAuth callbacks |
| `http://localhost:8081` | Mobile app in a PC browser, while `npx expo start` runs |

Limits of this setup: nothing works while the laptop is off or asleep, store webhooks sent during that time are lost until the 01:30 safety sync catches up, and the database lives only in a Docker volume on this machine.

## Reference

Everything an engineer needs to configure, call or debug the system is on this page: environment variables, the REST API, the database tables and a runbook for the problems seen so far.

### Configuration (.env)

| Variable | Purpose | Default |
| --- | --- | --- |
| `APP_URL` | Public HTTPS address of the server; used in OAuth callbacks, webhook registration and email links | `http://localhost:3000` |
| `PORT` | Port the server listens on | `3000` |
| `SESSION_SECRET` | Key that signs the session cookie and the app's bearer token | `dev-secret-change-me` (change it) |
| `DATABASE_URL` | Postgres connection string; Docker Compose injects its own | `postgres://stocksense:stocksense@localhost:5432/stocksense` |
| `BC_CLIENT_ID`, `BC_CLIENT_SECRET` | BigCommerce app credentials for OAuth installs | empty |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | Shopify app credentials for OAuth installs and webhook signature checks | empty |
| `RESEND_API_KEY` | Resend key for the daily email digest; empty disables email | empty |
| `ALERT_FROM_EMAIL`, `ALERT_TO_EMAIL` | Sender and recipient of the digest (one recipient for all stores today) | `alerts@stocksense.app`, empty |
| `ALERT_DIGEST_HOUR` | Hour of the daily digest, server local time | `8` |
| `BACKFILL_MONTHS` | Months of order history pulled on first connect | `18` |

### REST API

All `/api` routes need a session: the `ss_session` cookie set by the web connect flow, or `Authorization: Bearer <token>` for the app. Ids from Postgres arrive as strings.

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Liveness check, returns `{"ok":true}` |
| `GET /api/store` | Active store: platform, domain, currency, sync status and last sync error |
| `GET /api/summary` | Header counts, revenue at risk, forecast job state and the `kpis` block |
| `GET /api/risks?level=a,b&q=text&limit=100&offset=0` | Risk rows for the latest run, filtered by level and name or SKU |
| `GET /api/variants/:id` | One variant with 90 days of sales, the latest forecast curve and risk |
| `PATCH /api/variants/:id` | Update `lead_time_days` and `safety_stock` |
| `GET /api/alerts` | Last 50 digest alerts for the store |
| `POST /api/alerts/:id/ack` | Mark an alert as seen |
| `GET /auth/stores` | Stores connected on this device, with the active one |
| `POST /auth/switch` | Make another connected store active; returns a new token |
| `POST /auth/shopify/token-connect`, `POST /auth/bigcommerce/token-connect`, `POST /auth/woocommerce/connect` | Connect a store with pasted credentials; validate them first; return `token` |
| `GET /auth/shopify?shop=x.myshopify.com`, `GET /auth/shopify/callback`, `GET /auth/bigcommerce/callback`, `GET /auth/bigcommerce/load` | OAuth install and load flows |
| `POST /webhooks/{shopify,bigcommerce,woocommerce}/:storeId` | Platform webhooks; Shopify is HMAC-verified; each schedules a debounced incremental sync |

### Database tables

| Table | Holds |
| --- | --- |
| `stores` | One row per connected store: platform, domain, access token, currency, sync status, install and uninstall times |
| `products`, `variants` | Catalogue as synced; variants carry SKU, price, current stock, tracking flag, and the merchant-set lead time and safety stock |
| `order_lines` | Thin copy of paid order lines, kept so daily sales can be rebuilt |
| `daily_sales` | Units and revenue per variant per day; the forecasting input |
| `forecasts` | Per variant per run: model used and 56 daily point forecasts as JSON |
| `stock_risk` | Per variant per run: stock, days of cover, stockout date, reorder point and quantity, revenue at risk, risk level |
| `alerts` | Digest log, so an item is not emailed twice within 7 days |
| `sync_jobs` | History of initial syncs and the queue of forecast jobs between server and worker |

### Runbook

| Symptom | Cause and fix |
| --- | --- |
| Dashboard shows "Cannot reach the server" | Docker or ngrok is down. Run `scripts\start-stocksense.ps1` or check `docker ps` and the ngrok tab |
| Store stays on "Syncing" for minutes | Check `docker logs stocksense-server-1` for the platform API error; a wrong token sets `sync_status` to `error`, which the dashboard shows |
| "Forecast ran but produced no results" | The store has no paid orders in the backfill window, or no variant has sales in the last 365 days |
| Products show as untracked | Inventory tracking is off in the store admin; the next webhook or nightly sync picks up the change, then a forecast follows |
| Webhooks never arrive | `APP_URL` changed (ngrok restart); reconnect the store so webhooks re-register with the new address |
| App shows "Session expired" | The 30-day token lapsed or `SESSION_SECRET` changed; connect again |
| Worker logs a traceback | The worker catches per-store failures and continues; see `docker logs stocksense-worker-1`. The queued job is marked `error` with the message |
| Need to re-run a forecast now | Insert a queued job: `INSERT INTO sync_jobs (store_id, job_type, status) VALUES (<id>, 'forecast', 'queued')`; the worker picks it up within 30 seconds |

## What is required to go live

Going live means real merchants can connect a store and trust the numbers without you being present. That needs an always-on server, a fixed domain, hardened security, approved store listings, a published app, and a few legal and operating basics. Everything below is free or close to it except the two store accounts.

### 1. Hosting and domain

| Requirement | Why | Free option |
| --- | --- | --- |
| Always-on server for Docker (server, worker, database) | Webhooks, nightly forecasts and the app must work when the laptop is off | Oracle Cloud Always Free VM (4 ARM cores, 24 GB) or Google Cloud e2-micro |
| Fixed domain with HTTPS | Store platforms require HTTPS callbacks; the app needs a stable address | DuckDNS subdomain plus Caddy for automatic certificates; a custom domain is about 10 USD a year |
| Managed Postgres or a backed-up volume | The database is the product; a lost volume loses every store | Neon or Supabase free tier with automatic backups, or nightly `pg_dump` to object storage |
| Set `APP_URL` to the new domain and reconnect stores | Webhook addresses and OAuth callbacks are registered with the old ngrok URL | Rerun connect for each store after the move |
| Point the mobile app at the domain | Today it defaults to the ngrok tunnel | Change `DEFAULT_API_URL` in `mobile/src/config.ts` and rebuild |

### 2. Security hardening

- [ ] Encrypt `stores.access_token` at rest (pgcrypto or application-level AES with a key outside the database)
- [ ] Generate a long random `SESSION_SECRET` and keep `.env` out of the repository (already ignored)
- [ ] Rate-limit the connect endpoints and validate WooCommerce keys with a test call before saving
- [ ] Restrict CORS to the app's own origins instead of reflecting any origin
- [ ] Add request logging with a request id, and an error tracker such as Sentry (free tier)
- [ ] Run the containers as a non-root user and keep Docker images updated

### 3. Store platform approval

| Platform | What is needed before merchants can install |
| --- | --- |
| Shopify | Public app in the Partner dashboard, the three mandatory GDPR webhooks (`customers/data_request`, `customers/redact`, `shop/redact`), "read all orders" approval for history older than 60 days, migration from REST to the GraphQL Admin API, app review |
| BigCommerce | App registered at devtools.bigcommerce.com with auth and load callbacks on the live domain, marketplace listing review; store-level API tokens keep working for private use without a listing |
| WooCommerce | No approval; merchants paste REST keys. A WordPress plugin that creates the keys automatically would improve onboarding |

### 4. Mobile app release

- [ ] Google Play developer account (one-time 25 USD) and, for iPhone, an Apple developer account (99 USD a year)
- [ ] EAS production build (`eas build -p android --profile production`) giving a signed `.aab`; keep the signing credentials Expo stores for you
- [ ] App icon, splash screen, screenshots and a store listing description
- [ ] Privacy policy URL, required by both stores and by Shopify
- [ ] Push notifications for new critical items (expo-notifications plus a device token table on the server)
- [ ] Crash reporting in the app (Sentry for Expo)

### 5. Product completeness

- [ ] Per-store owner email captured at connect, so the daily digest reaches the right merchant
- [ ] Unit cost per SKU (synced where the platform provides it, else editable) so inventory value and reorder spend are at cost
- [ ] Multi-location stock for stores with several warehouses
- [ ] Automated tests for the sync adapters, risk computation and API, run in GitHub Actions on every push
- [ ] A job queue (BullMQ or similar) once the number of stores makes in-process webhook syncs a bottleneck

### 6. Operations

- [ ] Uptime check on `/health` (UptimeRobot free tier) with an alert to your phone
- [ ] Nightly database backup and a tested restore
- [ ] Log retention for the server and worker (Docker logging driver with rotation)
- [ ] A support email address shown in the app and store listings
- [ ] Terms of service and a data retention statement (order lines older than 24 months can be pruned)

### Estimated cost to run live

| Item | Monthly cost |
| --- | --- |
| Server and worker on an always-free VM | 0 |
| Postgres on Neon free tier | 0 |
| Domain (optional, custom) | about 1 |
| Email via Resend, under 3,000 messages | 0 |
| Error tracking and uptime monitoring, free tiers | 0 |
| Google Play registration | 25 once |
| Apple developer program (only for iPhone) | about 8, billed 99 a year |

## Known gaps and next steps

The biggest gap is hosting: until the backend moves off the laptop, real merchants cannot rely on it. The free path is an Oracle Cloud Always Free VM running the same Docker Compose file, with Caddy for HTTPS and a free DuckDNS subdomain.

- [ ] Move the backend to an always-on host and point the app's server address at its domain
- [ ] Encrypt store access tokens in the database; today they are stored as plain text
- [ ] Store an owner email per store; alerts currently go to one address from the config file
- [ ] Add Shopify's mandatory GDPR webhooks before any Shopify App Store submission
- [ ] Validate WooCommerce keys before saving, and rate-limit the connect endpoints
- [ ] Sync unit cost, so inventory value and reorder spend use cost instead of retail price
- [ ] Push notifications on the phone for new critical items
- [ ] Bring the web dashboard onto the new app design
- [ ] Add automated tests; there are none today
- [ ] Build a signed APK and publish to Google Play (one-time 25 USD fee)

Running cost today is zero: all software is open source, forecasting uses no paid API, and email uses Resend's free tier of 3,000 messages a month.
