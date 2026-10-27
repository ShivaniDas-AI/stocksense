-- StockSense — core database schema (PostgreSQL)
-- Platform-agnostic: works for Shopify, BigCommerce, WooCommerce connections.

CREATE TABLE stores (
    id              BIGSERIAL PRIMARY KEY,
    platform        TEXT NOT NULL CHECK (platform IN ('shopify', 'bigcommerce', 'woocommerce')),
    store_domain    TEXT NOT NULL,              -- e.g. myshop.myshopify.com
    store_hash      TEXT,                       -- BigCommerce store hash
    access_token    TEXT NOT NULL,              -- encrypt at rest in production
    currency        TEXT DEFAULT 'USD',
    timezone        TEXT DEFAULT 'UTC',
    sync_status     TEXT DEFAULT 'pending',     -- pending | syncing | ready | error
    installed_at    TIMESTAMPTZ DEFAULT now(),
    uninstalled_at  TIMESTAMPTZ,
    UNIQUE (platform, store_domain)
);

CREATE TABLE products (
    id              BIGSERIAL PRIMARY KEY,
    store_id        BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    external_id     TEXT NOT NULL,              -- platform product id
    title           TEXT NOT NULL,
    image_url       TEXT,
    status          TEXT DEFAULT 'active',
    UNIQUE (store_id, external_id)
);

CREATE TABLE variants (
    id              BIGSERIAL PRIMARY KEY,
    store_id        BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    product_id      BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    external_id     TEXT NOT NULL,              -- platform variant id
    sku             TEXT,
    title           TEXT,                       -- e.g. "Air Max 90 - Black / 42"
    price           NUMERIC(12,2),
    cost            NUMERIC(12,2),              -- unit cost if available (for revenue-at-risk)
    current_stock   INTEGER DEFAULT 0,
    inventory_item_id TEXT,                     -- Shopify inventory_item_id / BC inventory ref
    lead_time_days  INTEGER DEFAULT 14,         -- merchant-editable per SKU
    safety_stock    INTEGER DEFAULT 0,          -- merchant-editable
    track_inventory BOOLEAN DEFAULT TRUE,
    UNIQUE (store_id, external_id)
);

-- Daily units sold per variant. This is the forecasting input.
-- Aggregated from raw orders; one row per variant per day with sales.
CREATE TABLE daily_sales (
    store_id        BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    variant_id      BIGINT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
    sale_date       DATE NOT NULL,
    units_sold      INTEGER NOT NULL DEFAULT 0,
    revenue         NUMERIC(12,2) DEFAULT 0,
    PRIMARY KEY (variant_id, sale_date)
);
CREATE INDEX idx_daily_sales_store_date ON daily_sales (store_id, sale_date);

-- Raw order lines kept thin — only what aggregation needs.
-- Lets us re-aggregate if logic changes; prune rows older than 24 months.
CREATE TABLE order_lines (
    id              BIGSERIAL PRIMARY KEY,
    store_id        BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    external_order_id TEXT NOT NULL,
    variant_external_id TEXT NOT NULL,
    quantity        INTEGER NOT NULL,
    line_revenue    NUMERIC(12,2),
    ordered_at      TIMESTAMPTZ NOT NULL,
    UNIQUE (store_id, external_order_id, variant_external_id)
);
CREATE INDEX idx_order_lines_store_time ON order_lines (store_id, ordered_at);

-- Output of the nightly forecast job. Replaced per run.
CREATE TABLE forecasts (
    id              BIGSERIAL PRIMARY KEY,
    store_id        BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    variant_id      BIGINT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
    run_date        DATE NOT NULL,
    model_used      TEXT NOT NULL,              -- AutoETS | CrostonSBA | SMA | naive
    horizon_days    INTEGER NOT NULL DEFAULT 56,
    -- JSON array of 56 daily point forecasts: [{"d":"2026-10-23","y":3.2}, ...]
    daily_forecast  JSONB NOT NULL,
    avg_daily_demand NUMERIC(10,3) NOT NULL,    -- mean forecast demand/day over horizon
    UNIQUE (variant_id, run_date)
);

-- Derived risk per variant per run — what the dashboard reads.
CREATE TABLE stock_risk (
    id              BIGSERIAL PRIMARY KEY,
    store_id        BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    variant_id      BIGINT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
    run_date        DATE NOT NULL,
    current_stock   INTEGER NOT NULL,
    days_of_stock   NUMERIC(8,1),               -- NULL = no demand, effectively infinite
    stockout_date   DATE,                       -- projected date stock hits 0
    reorder_point   INTEGER,                    -- lead_time demand + safety stock
    reorder_qty     INTEGER,                    -- suggested order quantity
    revenue_at_risk NUMERIC(12,2),              -- lost revenue if not reordered
    -- 'untracked' = the platform does not track stock for this variant, so only
    -- the demand forecast and reorder quantity are known.
    risk_level      TEXT NOT NULL CHECK (risk_level IN ('critical','low_stock','healthy','overstocked','no_demand','untracked')),
    UNIQUE (variant_id, run_date)
);
CREATE INDEX idx_stock_risk_store_run ON stock_risk (store_id, run_date, risk_level);

-- Alert log: what we notified, so we don't repeat daily.
CREATE TABLE alerts (
    id              BIGSERIAL PRIMARY KEY,
    store_id        BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    variant_id      BIGINT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
    alert_type      TEXT NOT NULL,              -- stockout_risk | reorder_now
    risk_level      TEXT NOT NULL,
    sent_at         TIMESTAMPTZ DEFAULT now(),
    channel         TEXT DEFAULT 'email',
    acknowledged    BOOLEAN DEFAULT FALSE
);

CREATE TABLE sync_jobs (
    id              BIGSERIAL PRIMARY KEY,
    store_id        BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    job_type        TEXT NOT NULL,              -- initial_sync | incremental | forecast
    -- The server queues a 'forecast' job when a store's initial sync finishes;
    -- the worker picks it up within ~30s so the dashboard fills right away.
    status          TEXT NOT NULL DEFAULT 'queued',
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    error           TEXT
);
