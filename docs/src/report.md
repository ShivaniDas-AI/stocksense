# StockSense Project Report

Nov 21, 2026 · @Pradeep

## Summary

StockSense predicts which products an online store will run out of, when, and how much to reorder, 2 to 8 weeks ahead. It connects to Shopify, BigCommerce and WooCommerce stores, copies their products, stock and orders, and runs a statistical forecast for every SKU each night and right after each sync.

The working product today is a web dashboard, an Android and iOS mobile app that also runs in a PC browser, and daily alerts by email. On top of the forecast it plans purchasing: suppliers, reorder quantities, purchase orders, alerts, multi-location transfers and promotions, all of it in the mobile app. Merchants' own systems can use the same features through a public REST API with signed webhooks. Ask StockSense answers questions in plain words with an OpenAI, Google Gemini or Claude key, and the main tasks also run from WhatsApp. Two stores are connected for testing, a Shopify development store and a BigCommerce sample store, plus a demo store with sample data.

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
| Public API | REST under `/api/v1`, OpenAPI 3.1 spec, Swagger UI at `/docs`, API keys hashed with SHA-256 |
| Forecast worker | Python 3.11, statsforecast (AutoETS, Croston SBA, moving average), pandas, numpy, psycopg2 |
| Database | PostgreSQL 16, versioned migrations in `schema_migrations` |
| Web dashboard | Plain HTML, CSS and JavaScript; installable as a PWA |
| Mobile app | Expo SDK 58, React Native 0.88, TypeScript, React Navigation, TanStack Query, react-native-svg charts |
| AI and messaging | OpenAI, Google Gemini or Claude (Anthropic) for Ask StockSense, one provider at a time; Meta WhatsApp Cloud API; Twilio for SMS; Slack incoming webhooks; resvg for chart images |
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

The app in the `mobile` folder is built with Expo (React Native and TypeScript), so one codebase runs on Android, iOS and a PC browser. It reads the same `/api/v1` data as the public API, so every status and number matches the server, and it signs in with a bearer token instead of a cookie. It has five tabs: Home, Orders, Alerts, WhatsApp and Settings.

| Screen | What it shows |
| --- | --- |
| Home | Reorder-now count and revenue at risk, a status bar across all products, six key numbers, weekly units sold and forecast, running low, and the product list with status filters, search and sort |
| Key number detail | Opens from any key number: headline figures with the change against the previous period, daily and weekly charts, breakdowns by category or band, and product tables. Covers sales, forecast, forecast accuracy, days of cover, cash in overstock, revenue protected and revenue at risk |
| Product | Recommended action, stock projection with its 80% range and reorder point, weekly demand, confidence and accuracy, supplier and lead time, editable reorder rules |
| Reorder | Suppliers side by side with lead time and arrival date, the quantity worked out line by line, and a button that creates the draft purchase order |
| Orders | Purchase orders by status with approve, send, receive and cancel, and supplier scorecards: lead time trend, on-time rate and fill rate |
| Alerts | The five alert types with what to do, open, resolved and dismissed views, dismiss and reopen, and a count on the tab |
| WhatsApp | Link a phone with a 6-digit code, approval rights per phone, the activity log, and a chat preview that runs the real assistant with menus, buttons and chart images |
| Ask StockSense | Questions in plain words with answers and charts from live data; shows the setup steps when no AI key is set |
| Settings | Stores on this phone, plan and usage, AI status, API keys, server address, log out |

The design uses a light neutral palette with one brand blue, uses colour only for meaning, and follows the phone's dark mode. Every screen has its own error screen, so a problem on one screen shows its message and a Try again button instead of a blank app. On Android the text uses the Inter font families without extra weights, and input bars stay above the keyboard and the navigation bar.

**How it reaches the server.** On a phone the app calls the ngrok address, which forwards to the server on the laptop. In a PC browser it calls `http://localhost:3000` directly. The address can be changed under Settings once the server has a permanent domain.

**Run it.** In a terminal, `cd mobile` first (Expo fails with a ConfigError in the project root), then run `npx expo start`, or `npx expo start -c` after an update to clear its cache. Scan the QR code with the Expo Go app on a phone on the same Wi-Fi, or press w to open `http://localhost:8081` in a browser.

**Build an installable APK.** Run `npx eas-cli build -p android --profile preview`. Expo's free cloud build service produces the file; no Android Studio is needed.

## Planning features

On 20 November 2026 every feature in the StockSense user guide was built on top of the forecast, and on 21 November the mobile app gained screens for them. Each one works in the app, through the public API and, where it makes sense, on WhatsApp. The store's plan decides which features are switched on.

| Feature | What it does |
| --- | --- |
| Forecast statuses | Every SKU is marked reorder now, watch, healthy, overstocked, no sales or untracked. Each forecast carries an 80% range, safety stock, days of cover, and a confidence and accuracy score from a 4-week backtest |
| Reorder plans | Suggested quantity covers demand over the lead time and the coverage period plus safety stock, minus stock on hand and on order, rounded up to the supplier's minimum order and case pack. Safety stock is `z × √(LT × σd² + d² × σLT²)` |
| Suppliers | Lead time, minimum order, case pack and contact per supplier; a preferred supplier per vendor or category; lead time measured from real receipts |
| Purchase orders | Draft, approve, send (emailed to the supplier with a CSV), receive. Receiving updates stock and the supplier's measured lead time. Scale and Pro get automatic drafts for reorder-now items |
| Alerts | Five types: stockout risk, reorder point, velocity shift, lead time drift and overstock. An alert opens once per problem, closes itself when the problem is gone and records the purchase order that fixed it |
| Locations and transfers | Stock per location; Pro suggests transfers from locations with surplus to locations running short, then tracks ship and receive |
| Promotions | A planned uplift is applied to the forecast for the promotion's dates |
| Notifications | Email, Slack, SMS and WhatsApp, chosen per alert type |
| Demo store | A one-click sample store with history, suppliers and locations, for trying the product without a real store |

| Plan | Price | Limits and extras |
| --- | --- | --- |
| Launch | 15 USD a month | 500 SKUs, 1 location, weekly forecast rebuild, no Ask StockSense |
| Scale | 45 USD a month | 10,000 SKUs, unlimited locations, nightly rebuild, draft purchase orders, all alert types, SMS and WhatsApp alerts, 100 Ask questions a month |
| Pro | 120 USD a month | Unlimited SKUs, hourly rebuild, unlimited Ask questions, transfers, supplier scorecards, API keys and webhooks |

Plan limits are enforced on the server. A request for a feature outside the plan gets a `402` response that names the plan needed. Billing itself is not connected yet, so the plan is set per store in the database.

## REST API and webhooks

The public API lets a merchant's own systems read forecasts and run the planning features. It lives at `{APP_URL}/api/v1` (also `/v1`), has 79 operations described in an OpenAPI 3.1 spec at `/api/v1/openapi.json`, and an interactive console at `/docs` where a key can be pasted to try every call.

- **Keys.** API keys are a Pro feature. A live key starts `ss_live_` and can read and write. A sandbox key starts `ss_test_`: it reads live data, but every write is rolled back and the response says `"sandbox": true`. Keys are created in the app's Settings, API keys, shown once, and stored only as a SHA-256 hash. Each key sees one store.
- **Auth and limits.** Send `Authorization: Bearer <key>` or `X-API-Key: <key>`. Each key gets 120 requests a minute, reported in `X-RateLimit-*` headers; over the limit the API answers `429` with `Retry-After`.
- **Shapes.** One object comes back as `{"data": {...}}`; lists add `page`, `limit`, `total` and `has_more`. Errors are `{"error": {"type", "code", "message", "field"}}`. Every response has an `X-Request-Id`. Each write runs in one database transaction.

| Area | Main endpoints |
| --- | --- |
| Forecasts | `GET /forecasts`, `GET /forecasts.csv`, `GET /forecasts/{variantId}`, `PATCH /forecasts/{variantId}/settings`, `POST /forecasts/rebuild`, `GET /jobs/{id}` |
| Reorder | `GET /reorder/{variantId}`, `POST /reorder/{variantId}/preferences`, `POST /reorder/{variantId}/purchase-order` |
| Purchase orders | `GET/POST /purchase-orders`, `GET/PATCH /purchase-orders/{id}`, `POST /purchase-orders/{id}` with approve, send, cancel or receive, `GET /purchase-orders/{id}/csv` |
| Suppliers | `GET/POST /suppliers`, `GET/PATCH/DELETE /suppliers/{id}`, `GET /vendors`, `GET /categories` |
| Alerts | `GET /alerts`, `GET /alerts/{id}`, `POST /alerts/{id}` with dismiss or reopen, `POST /alerts/check` |
| Locations and transfers | `GET/POST /locations`, `GET/PUT /locations/{id}/inventory`, `GET /transfers/suggestions`, `GET/POST /transfers`, `POST /transfers/{id}` with ship, receive or cancel |
| Insights and settings | `GET /dashboard`, `GET /kpis/{metric}` (the detail behind each key number), `GET /summary`, `GET /store`, `GET /plan`, `GET/PATCH /settings/forecasting`, `GET/PATCH /settings/notifications`, promotions |
| Webhooks | `GET/POST /webhooks`, `PATCH/DELETE /webhooks/{id}`, `POST /webhooks/{id}/test`, `GET /webhooks/{id}/deliveries` |
| Data | `GET /data/status`, `POST /data/rebuild`, `POST /data/reimport`, `POST/DELETE /data/demo` |
| Ask and WhatsApp | `POST /ask`, the `/ask/conversations` routes, `/whatsapp` settings, link codes, numbers, activity and a simulator |

**Outgoing webhooks** (Pro) notify the merchant's systems of eight events: the five alert types plus `purchase_order.approved`, `purchase_order.sent` and `purchase_order.received`. Each delivery is signed: `X-StockSense-Signature` is `sha256=` followed by the hex HMAC-SHA256 of the timestamp, a dot and the body, using the endpoint's secret. Failed deliveries are retried after 30 seconds, 5 minutes, 30 minutes and 2 hours, and every attempt is listed under the endpoint's deliveries.

A test script, `server/test/api_e2e.py`, runs 107 end-to-end checks against the demo store, and all of them pass.

## Ask StockSense

Ask StockSense answers questions about the store in plain words, in the app and on WhatsApp, such as "what should I reorder this week?" or "why is the blue mug flagged?". It works with any one of three AI providers: OpenAI (in use today, model `gpt-6-luna`), Google Gemini or Claude.

- **Grounded in live data.** The model does not guess numbers. It calls ten read tools on the store's own data: overview, forecasts, one forecast, reorder plan, suppliers, alerts, purchase orders, transfer suggestions, a chart, and drafting a purchase order. At most 8 tool rounds run per question.
- **Charts.** Answers can include a projected-stock, weekly-demand or days-of-cover chart. On WhatsApp the chart is sent as an image.
- **Safe actions.** The only write is a purchase order draft, which is never sent to the supplier; the merchant reviews and approves it.
- **Conversations** are saved, can be renamed and deleted, and continue where they left off.
- **Limits.** Scale includes 100 questions a month and Pro is unlimited; `GET /ask/usage` shows what is left.

It needs one key in `.env`: `OPENAI_API_KEY`, `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`; with several, `AI_PROVIDER` picks one. Each provider moves on to its next current model if one is unavailable, and a key pasted on the wrong line is detected and explained in the app. A test question on 21 November was answered correctly in about 5 seconds. Without a key, Ask shows the setup steps and everything else keeps working.

## WhatsApp assistant

The WhatsApp assistant gives the store owner and staff the main features from a chat, with menus and buttons like a banking bot, through Meta's WhatsApp Cloud API.

1. **Link a phone.** In Settings, WhatsApp, the owner creates a 6-digit link code and sends `link <code>` from the phone within 10 minutes. Each number is either view only or can approve changes.
2. **Use the menu.** Today's summary, reorder now, product forecast (search by name or SKU, with a stock chart), purchase orders, suppliers, add a supplier, alerts, transfers, Ask StockSense AI, and settings and help. Typing a question goes to Ask StockSense.
3. **Approve changes.** Every change (a draft order, approving or sending an order, receiving, a new supplier, a transfer) is shown first and runs only when an approving number taps Approve within 30 minutes. Every action is kept in an activity log in the app.
4. **Alerts.** New alerts can be sent to linked numbers. Outside WhatsApp's 24-hour reply window this needs an approved message template, set in `WHATSAPP_ALERT_TEMPLATE`.

The Meta webhook URL is `{APP_URL}/webhooks/whatsapp`, verified with `WHATSAPP_VERIFY_TOKEN` and signed with `WHATSAPP_APP_SECRET`. Until the Meta credentials are set, the full assistant can be tried through `POST /api/v1/whatsapp/simulate`, which returns the replies the bot would send.

## Work completed

Eighteen commits between 27 October and 21 November 2026 took the project from a dashboard stuck on "Syncing" to a working web and mobile product with a public API, AI answers and a WhatsApp assistant.

| Commit | Change |
| --- | --- |
| [a7888a5](https://github.com/ShivaniDas-AI/stocksense/commit/a7888a5) | Ask StockSense runs on an OpenAI key; tested with a real question |
| [9d788fd](https://github.com/ShivaniDas-AI/stocksense/commit/9d788fd) | Google Gemini as an AI provider, and detection of keys pasted on the wrong line |
| [64c9a6c](https://github.com/ShivaniDas-AI/stocksense/commit/64c9a6c) | Fixed the BigCommerce crash on the Orders screens (warnings shown as objects), per-screen error screens, Android font and keyboard fixes |
| [b999cb6](https://github.com/ShivaniDas-AI/stocksense/commit/b999cb6) | Key number detail screens with figures, charts and tables, and the `/kpis/{metric}` endpoint |
| [21ad7a5](https://github.com/ShivaniDas-AI/stocksense/commit/21ad7a5) | Mobile app moved to the v1 data, with Orders, Reorder, Alerts, WhatsApp and Ask screens; BigCommerce product names include the product |
| [12d45b7](https://github.com/ShivaniDas-AI/stocksense/commit/12d45b7) | Step-by-step guide in the README to start on the laptop and phone |
| [75f3987](https://github.com/ShivaniDas-AI/stocksense/commit/75f3987) | This report updated with the API, webhooks, WhatsApp and Ask StockSense |
| [bf0ee20](https://github.com/ShivaniDas-AI/stocksense/commit/bf0ee20) | Built every feature in the user guide behind `/api/v1`: forecast statuses and backtests, reorder plans, suppliers, purchase orders, alerts, locations and transfers, promotions, plans, outgoing webhooks, Ask StockSense, the WhatsApp assistant and 107 end-to-end tests |
| [2eafe3a](https://github.com/ShivaniDas-AI/stocksense/commit/2eafe3a) | First public API (v1) with API keys, rate limits and interactive docs at `/docs` |
| [6f694d9](https://github.com/ShivaniDas-AI/stocksense/commit/6f694d9) | Refined mobile app design; this report as a PDF with go-live requirements |
| [6c95173](https://github.com/ShivaniDas-AI/stocksense/commit/6c95173) | Start-up script that brings the local backend up after sign-in |
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
| `RESEND_API_KEY` | Resend key for email alerts and purchase orders emailed to suppliers; empty disables email | empty |
| `ALERT_FROM_EMAIL`, `ALERT_TO_EMAIL` | Sender of all email, and the fallback recipient when a store has no alert email set | `alerts@stocksense.app`, empty |
| `ALERT_DIGEST_HOUR` | Hour of the daily digest, server local time | `8` |
| `BACKFILL_MONTHS` | Months of order history pulled on first connect | `18` |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | OpenAI key for Ask StockSense and AI answers on WhatsApp (set today); optional model | empty; first of `gpt-6-luna`, `gpt-6.1-terra` that works |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Google Gemini key from aistudio.google.com/apikey; optional model | empty; first stable Flash model that works |
| `ANTHROPIC_API_KEY`, `ASK_MODEL` | Claude key (starts with sk-ant-); optional model | empty, `claude-opus-5-5` |
| `AI_PROVIDER` | Which AI to use when several keys are set: `openai`, `gemini` or `anthropic` | OpenAI, then Gemini, then Claude |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_NUMBER` | Meta WhatsApp Cloud API access token, sending number id and the number shown to merchants | empty |
| `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | Meta webhook verification token and the app secret that signs incoming messages | empty |
| `WHATSAPP_ALERT_TEMPLATE` | Approved template with one body variable, for alerts outside the 24-hour window | empty |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Twilio credentials and sending number for SMS alerts | empty |
| `WEBHOOKS_ALLOW_HTTP` | Local testing only: lets outgoing webhooks go to plain `http://` addresses | `false` |

### REST API

There are two APIs. The public API under `/api/v1` is described in the REST API and webhooks section and in full at `/docs`. The routes below are the app's own: all `/api` routes need a session, either the `ss_session` cookie set by the web connect flow or `Authorization: Bearer <token>` for the app. Ids from Postgres arrive as strings.

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
| `products`, `variants` | Catalogue as synced; variants carry SKU, price, stock, tracking flag, supplier, case pack, minimum order and lead time override |
| `order_lines` | Thin copy of paid order lines, with the location they shipped from, kept so daily sales can be rebuilt |
| `daily_sales` | Units and revenue per variant per day; the forecasting input |
| `forecasts` | Per variant per run: model used and 56 daily point forecasts as JSON |
| `stock_risk` | Per variant per run: status, stock, on order, safety stock, reorder point and quantity, days of cover, stockout date, confidence, accuracy, revenue at risk |
| `alerts` | Digest log, so an item is not emailed twice within 7 days |
| `sync_jobs` | History of syncs and the queue of forecast jobs between server and worker |
| `store_settings`, `notification_settings` | Plan, forecasting settings and alert channels per store |
| `locations`, `inventory_levels` | Warehouses and shops, and stock per variant per location |
| `suppliers`, `supplier_vendors`, `supplier_categories`, `supplier_receipts` | Suppliers, the vendors and categories they supply, and receipts that measure real lead time |
| `purchase_orders`, `purchase_order_lines` | Purchase orders from draft to received |
| `inventory_alerts` | The five alert types with open, dismissed and resolved status |
| `promotions`, `transfers`, `transfer_lines` | Planned promotions and stock moves between locations |
| `api_keys`, `webhook_endpoints`, `webhook_deliveries` | Hashed API keys, outgoing webhook endpoints and every delivery attempt |
| `ask_conversations`, `ask_messages` | Ask StockSense conversations, in the app and on WhatsApp |
| `whatsapp_link_codes`, `whatsapp_numbers`, `whatsapp_sessions`, `whatsapp_actions` | Linking codes, linked phones and roles, chat state, and the approval and activity log |
| `schema_migrations` | Which database migrations have run |

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
| Need to re-run a forecast now | Call `POST /api/v1/forecasts/rebuild`, or insert a queued job: `INSERT INTO sync_jobs (store_id, job_type, status) VALUES (<id>, 'forecast', 'queued')`; the worker picks it up within 30 seconds |
| API answers `401` | The key is missing, mistyped or revoked; create a new one in Settings, API keys |
| API answers `402` | The feature is not in the store's plan; the message names the plan needed |
| API answers `429` | More than 120 requests a minute on one key; wait for `Retry-After` seconds |
| A webhook endpoint gets nothing | Check `GET /api/v1/webhooks/{id}/deliveries` for the status code and error; endpoints must be HTTPS unless `WEBHOOKS_ALLOW_HTTP=true` |
| Ask shows "Needs key" or "Wrong key" | No AI key, or a key on the wrong line of `.env` (for example an OpenAI key on `ANTHROPIC_API_KEY`). Fix it, then run `docker compose up -d --force-recreate server` |
| WhatsApp says it is not configured | The `WHATSAPP_*` values are empty in `.env`; until then use the chat preview in the app |
| WhatsApp approval says it expired | Approvals are valid for 30 minutes; start again from the menu |
| `ConfigError` about `package.json` when starting the app | Expo was started in the project root; `cd mobile` first |
| App shows a blank page after an update | Expo's cache is out of date; stop it with Ctrl+C and run `npx expo start -c` in the `mobile` folder |
| A screen shows "This screen hit a problem" | That screen crashed and the message names the cause; tap Try again, and report the message if it repeats |

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

- [ ] Owner email captured at connect for every store, so alerts reach the right merchant (a per-store alert email exists in notification settings; it is not asked for at connect yet)
- [ ] Unit cost per SKU synced where the platform provides it (it can be entered today) so inventory value and reorder spend are at cost
- [ ] Billing through Shopify Billing and a payment provider for other platforms; plans are set by hand today
- [ ] Unit tests for the sync adapters and the worker, and the 107-check API test run in GitHub Actions on every push
- [ ] A job queue (BullMQ or similar) once the number of stores makes in-process webhook syncs a bottleneck

### 6. Operations

- [ ] Uptime check on `/health` (UptimeRobot free tier) with an alert to your phone
- [ ] Nightly database backup and a tested restore
- [ ] Log retention for the server and worker (Docker logging driver with rotation)
- [ ] A support email address shown in the app and store listings
- [ ] Terms of service and a data retention statement (order lines older than 24 months can be pruned)

### 7. API, AI and WhatsApp

- [ ] Publish the API docs at the live domain and keep `WEBHOOKS_ALLOW_HTTP` off, so outgoing webhooks only go to HTTPS
- [ ] Keep one AI key for Ask StockSense (OpenAI is set today; Gemini or Claude also work) and set a monthly spend limit in that provider's console
- [ ] Meta Business account, a WhatsApp Business phone number and a Cloud API app; set the `WHATSAPP_*` values and the webhook URL `{APP_URL}/webhooks/whatsapp`
- [ ] Meta business verification and an approved alert template for messages outside the 24-hour window
- [ ] Twilio account and sending number for SMS alerts, if SMS is offered
- [ ] Shopify scopes `read_locations` and `write_inventory` approved, so locations and stock adjustments work on Shopify
- [ ] Terms that cover AI answers, name the AI provider that processes store data, and cover messages sent on the merchant's behalf

### Estimated cost to run live

| Item | Monthly cost |
| --- | --- |
| Server and worker on an always-free VM | 0 |
| Postgres on Neon free tier | 0 |
| Domain (optional, custom) | about 1 |
| Email via Resend, under 3,000 messages | 0 |
| Error tracking and uptime monitoring, free tiers | 0 |
| Ask StockSense on OpenAI `gpt-6-luna` | pay per use: about 0.10 USD per million input tokens, a fraction of a cent a question; set a monthly limit |
| WhatsApp Cloud API | replies inside 24 hours are free; alert templates are charged per message by Meta, by country |
| SMS via Twilio (optional) | per message, by country |
| Google Play registration | 25 once |
| Apple developer program (only for iPhone) | about 8, billed 99 a year |

## Known gaps and next steps

The biggest gap is hosting: until the backend moves off the laptop, real merchants cannot rely on it. The free path is an Oracle Cloud Always Free VM running the same Docker Compose file, with Caddy for HTTPS and a free DuckDNS subdomain.

- [ ] Move the backend to an always-on host and point the app's server address at its domain
- [ ] Encrypt store access tokens in the database; today they are stored as plain text
- [ ] Ask for an owner email at connect; alerts fall back to one address from the config file
- [ ] Add Shopify's mandatory GDPR webhooks before any Shopify App Store submission
- [ ] Validate WooCommerce keys before saving, and rate-limit the connect endpoints
- [ ] Sync unit cost, so inventory value and reorder spend use cost instead of retail price
- [ ] Connect billing; plans are set per store in the database today
- [ ] Create draft transfers in Shopify itself; transfers are tracked in StockSense only and have no app screen yet
- [ ] Detect past promotions automatically from sales spikes; today promotions are entered by hand
- [ ] Set up the Meta account so the WhatsApp assistant runs live; today it is used through the chat preview in the app
- [ ] Test the app on a real phone build; it was checked in a browser at phone size and through the phone's server traffic, not on an Android emulator
- [ ] Bring the web dashboard onto the new design and planning features; the mobile app already has them
- [ ] Push notifications on the phone for new critical items
- [ ] Build a signed APK and publish to Google Play (one-time 25 USD fee)

Hosting costs nothing today: all software is open source, forecasting uses no paid API, and email uses Resend's free tier of 3,000 messages a month. Ask StockSense now runs on the OpenAI key and is billed per question by OpenAI, a fraction of a cent each on `gpt-6-luna`. WhatsApp alert templates and SMS add usage-based costs once their accounts are set up.