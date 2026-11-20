/**
 * Schema migrations, applied in order at server start. Each runs once and is
 * recorded in schema_migrations; every statement is also idempotent, so a
 * fresh database built from schema.sql converges to the same shape.
 */
import { pool } from "./db";

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_api_keys",
    sql: `
      CREATE TABLE IF NOT EXISTS api_keys (
        id            BIGSERIAL PRIMARY KEY,
        store_id      BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        prefix        TEXT NOT NULL,
        key_hash      TEXT NOT NULL UNIQUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at  TIMESTAMPTZ,
        revoked_at    TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_store ON api_keys (store_id);
    `,
  },
  {
    id: "002_plans_settings",
    sql: `
      ALTER TABLE stores
        ADD COLUMN IF NOT EXISTS name                TEXT,
        ADD COLUMN IF NOT EXISTS plan                TEXT NOT NULL DEFAULT 'pro',
        ADD COLUMN IF NOT EXISTS plan_interval       TEXT NOT NULL DEFAULT 'monthly',
        ADD COLUMN IF NOT EXISTS trial_ends_at       TIMESTAMPTZ DEFAULT (now() + interval '14 days'),
        ADD COLUMN IF NOT EXISTS is_demo             BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS forecasted_at       TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS alerts_evaluated_at TIMESTAMPTZ;

      -- Forecasting rules (Settings > Forecasting). Defaults match the user guide.
      CREATE TABLE IF NOT EXISTS store_settings (
        store_id               BIGINT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
        service_level          NUMERIC(4,3) NOT NULL DEFAULT 0.95 CHECK (service_level BETWEEN 0.5 AND 0.999),
        default_lead_time_days INT NOT NULL DEFAULT 14 CHECK (default_lead_time_days BETWEEN 1 AND 365),
        coverage_days          INT NOT NULL DEFAULT 60 CHECK (coverage_days BETWEEN 1 AND 365),
        overstock_days         INT NOT NULL DEFAULT 90 CHECK (overstock_days BETWEEN 7 AND 730),
        velocity_threshold     NUMERIC(4,2) NOT NULL DEFAULT 1.8 CHECK (velocity_threshold BETWEEN 1.1 AND 10),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Settings > Notifications.
      CREATE TABLE IF NOT EXISTS notification_settings (
        store_id          BIGINT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
        email_enabled     BOOLEAN NOT NULL DEFAULT true,
        alert_email       TEXT,
        slack_enabled     BOOLEAN NOT NULL DEFAULT false,
        slack_webhook_url TEXT,
        phone             TEXT,
        sms_enabled       BOOLEAN NOT NULL DEFAULT false,
        whatsapp_enabled  BOOLEAN NOT NULL DEFAULT false,
        urgent_only       BOOLEAN NOT NULL DEFAULT true,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'live';
    `,
  },
  {
    id: "003_catalog_locations",
    sql: `
      ALTER TABLE products
        ADD COLUMN IF NOT EXISTS vendor       TEXT,
        ADD COLUMN IF NOT EXISTS product_type TEXT,
        ADD COLUMN IF NOT EXISTS is_demo      BOOLEAN NOT NULL DEFAULT false;

      CREATE TABLE IF NOT EXISTS locations (
        id           BIGSERIAL PRIMARY KEY,
        store_id     BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        external_id  TEXT,
        is_default   BOOLEAN NOT NULL DEFAULT false,
        active       BOOLEAN NOT NULL DEFAULT true,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_external ON locations (store_id, external_id) WHERE external_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_default ON locations (store_id) WHERE is_default;

      -- Stock per location. variants.current_stock stays the store total.
      CREATE TABLE IF NOT EXISTS inventory_levels (
        variant_id   BIGINT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
        location_id  BIGINT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        on_hand      INT NOT NULL DEFAULT 0,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (variant_id, location_id)
      );

      ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS location_external_id TEXT;
    `,
  },
  {
    id: "004_suppliers",
    sql: `
      CREATE TABLE IF NOT EXISTS suppliers (
        id               BIGSERIAL PRIMARY KEY,
        store_id         BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        name             TEXT NOT NULL,
        website          TEXT,
        address          TEXT,
        contact_name     TEXT,
        email            TEXT,
        phone            TEXT,
        lead_time_days   INT NOT NULL DEFAULT 14 CHECK (lead_time_days BETWEEN 1 AND 365),
        min_order_value  NUMERIC(12,2),
        currency         TEXT,
        payment_terms    TEXT,
        notes            TEXT,
        is_demo          BOOLEAN NOT NULL DEFAULT false,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_name ON suppliers (store_id, lower(name));

      -- "Products: tick the vendors this supplier makes."
      CREATE TABLE IF NOT EXISTS supplier_vendors (
        store_id     BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        vendor       TEXT NOT NULL,
        supplier_id  BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
        PRIMARY KEY (store_id, vendor)
      );
      -- "Preferred for categories" (wins over the vendor match).
      CREATE TABLE IF NOT EXISTS supplier_categories (
        store_id     BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        category     TEXT NOT NULL,
        supplier_id  BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
        PRIMARY KEY (store_id, category)
      );

      -- Ordering rules per variant (product forecast page / reorder screen).
      ALTER TABLE variants
        ADD COLUMN IF NOT EXISTS supplier_id         BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS case_pack           INT NOT NULL DEFAULT 1 CHECK (case_pack >= 1),
        ADD COLUMN IF NOT EXISTS min_order_qty       INT NOT NULL DEFAULT 0 CHECK (min_order_qty >= 0),
        ADD COLUMN IF NOT EXISTS lead_time_override  INT CHECK (lead_time_override BETWEEN 1 AND 365);

      -- Keep lead times merchants already set through the app as overrides.
      UPDATE variants SET lead_time_override = lead_time_days
       WHERE lead_time_override IS NULL AND lead_time_days IS NOT NULL AND lead_time_days <> 14;
    `,
  },
  {
    id: "005_purchase_orders",
    sql: `
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id            BIGSERIAL PRIMARY KEY,
        store_id      BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        number        INT NOT NULL,
        supplier_id   BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
        supplier_name TEXT NOT NULL,                    -- kept if the supplier is deleted
        location_id   BIGINT REFERENCES locations(id) ON DELETE SET NULL,
        status        TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','approved','sent','partial','received','cancelled')),
        is_auto       BOOLEAN NOT NULL DEFAULT false,   -- kept up to date by "Refresh suggested drafts"
        auto_edited   BOOLEAN NOT NULL DEFAULT false,   -- edited by a person: no longer auto-updated
        expected_at   DATE,
        notes         TEXT,
        currency      TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        approved_at   TIMESTAMPTZ,
        sent_at       TIMESTAMPTZ,
        emailed_at    TIMESTAMPTZ,
        received_at   TIMESTAMPTZ,
        cancelled_at  TIMESTAMPTZ,
        platform_sync JSONB,                            -- result of writing received stock back to the platform
        UNIQUE (store_id, number)
      );
      CREATE INDEX IF NOT EXISTS idx_po_store_status ON purchase_orders (store_id, status);

      CREATE TABLE IF NOT EXISTS purchase_order_lines (
        id                 BIGSERIAL PRIMARY KEY,
        purchase_order_id  BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        variant_id         BIGINT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
        quantity           INT NOT NULL CHECK (quantity > 0),
        unit_cost          NUMERIC(12,2),
        received_qty       INT NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
        UNIQUE (purchase_order_id, variant_id)
      );

      -- Real lead times, recorded on every receipt. Forecasts use the 90-day
      -- average and switch to the latest when it was slower.
      CREATE TABLE IF NOT EXISTS supplier_receipts (
        id                 BIGSERIAL PRIMARY KEY,
        supplier_id        BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
        purchase_order_id  BIGINT REFERENCES purchase_orders(id) ON DELETE SET NULL,
        ordered_at         TIMESTAMPTZ NOT NULL,
        received_at        TIMESTAMPTZ NOT NULL,
        lead_time_days     NUMERIC(6,1) NOT NULL,
        on_time            BOOLEAN,
        fill_rate          NUMERIC(5,4)
      );
      CREATE INDEX IF NOT EXISTS idx_receipts_supplier ON supplier_receipts (supplier_id, received_at);
    `,
  },
  {
    id: "006_alerts_promotions_transfers",
    sql: `
      -- Alerts that open once per problem and close themselves (chapter 9).
      -- The older "alerts" table stays the daily-digest log.
      CREATE TABLE IF NOT EXISTS inventory_alerts (
        id                 BIGSERIAL PRIMARY KEY,
        store_id           BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        type               TEXT NOT NULL CHECK (type IN ('stockout_risk','reorder_point','velocity_shift','lead_time_drift','overstock')),
        variant_id         BIGINT REFERENCES variants(id) ON DELETE CASCADE,
        supplier_id        BIGINT REFERENCES suppliers(id) ON DELETE CASCADE,
        status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','resolved')),
        urgent             BOOLEAN NOT NULL DEFAULT false,
        title              TEXT NOT NULL,
        message            TEXT NOT NULL,
        revenue_at_risk    NUMERIC(12,2) NOT NULL DEFAULT 0,
        data               JSONB NOT NULL DEFAULT '{}'::jsonb,
        opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        dismissed_at       TIMESTAMPTZ,
        resolved_at        TIMESTAMPTZ,
        resolved_by_po_id  BIGINT REFERENCES purchase_orders(id) ON DELETE SET NULL,
        notified_at        TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_problem ON inventory_alerts
        (store_id, type, COALESCE(variant_id, 0), COALESCE(supplier_id, 0)) WHERE status <> 'resolved';
      CREATE INDEX IF NOT EXISTS idx_alerts_store_status ON inventory_alerts (store_id, status);

      CREATE TABLE IF NOT EXISTS promotions (
        id           BIGSERIAL PRIMARY KEY,
        store_id     BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        starts_on    DATE NOT NULL,
        ends_on      DATE NOT NULL,
        uplift_pct   NUMERIC(6,1) NOT NULL CHECK (uplift_pct > -100 AND uplift_pct <= 1000),
        scope        TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all','vendor','product_type')),
        scope_value  TEXT,
        source       TEXT NOT NULL DEFAULT 'manual',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (ends_on >= starts_on)
      );

      CREATE TABLE IF NOT EXISTS transfers (
        id                BIGSERIAL PRIMARY KEY,
        store_id          BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        number            INT NOT NULL,
        from_location_id  BIGINT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        to_location_id    BIGINT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','shipped','received','cancelled')),
        notes             TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        shipped_at        TIMESTAMPTZ,
        received_at       TIMESTAMPTZ,
        cancelled_at      TIMESTAMPTZ,
        UNIQUE (store_id, number),
        CHECK (from_location_id <> to_location_id)
      );
      CREATE TABLE IF NOT EXISTS transfer_lines (
        transfer_id  BIGINT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
        variant_id   BIGINT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
        quantity     INT NOT NULL CHECK (quantity > 0),
        PRIMARY KEY (transfer_id, variant_id)
      );
    `,
  },
  {
    id: "007_webhooks_out",
    sql: `
      CREATE TABLE IF NOT EXISTS webhook_endpoints (
        id           BIGSERIAL PRIMARY KEY,
        store_id     BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        url          TEXT NOT NULL,
        events       TEXT[] NOT NULL DEFAULT ARRAY['*'],
        secret       TEXT NOT NULL,
        description  TEXT,
        active       BOOLEAN NOT NULL DEFAULT true,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id                BIGSERIAL PRIMARY KEY,
        endpoint_id       BIGINT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
        event_id          TEXT NOT NULL,
        event             TEXT NOT NULL,
        payload           JSONB NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
        attempts          INT NOT NULL DEFAULT 0,
        next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_status_code  INT,
        last_error        TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        delivered_at      TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_due ON webhook_deliveries (status, next_attempt_at);
    `,
  },
  {
    id: "008_forecast_outputs",
    sql: `
      -- Guide-level outputs written by the forecast worker.
      ALTER TABLE stock_risk
        ADD COLUMN IF NOT EXISTS status          TEXT,
        ADD COLUMN IF NOT EXISTS safety_stock    NUMERIC(10,1),
        ADD COLUMN IF NOT EXISTS lead_time_days  INT,
        ADD COLUMN IF NOT EXISTS coverage_days   INT,
        ADD COLUMN IF NOT EXISTS on_order        INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS rate_14d        NUMERIC(10,3),
        ADD COLUMN IF NOT EXISTS confidence      TEXT,
        ADD COLUMN IF NOT EXISTS accuracy        NUMERIC(5,4),
        ADD COLUMN IF NOT EXISTS supplier_id     BIGINT,
        ADD COLUMN IF NOT EXISTS unit_cost       NUMERIC(12,2);
      CREATE INDEX IF NOT EXISTS idx_stock_risk_status ON stock_risk (store_id, run_date, status);
    `,
  },
  {
    id: "009_ask_whatsapp",
    sql: `
      CREATE TABLE IF NOT EXISTS ask_conversations (
        id          BIGSERIAL PRIMARY KEY,
        store_id    BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        title       TEXT NOT NULL DEFAULT 'New conversation',
        channel     TEXT NOT NULL DEFAULT 'app',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ask_messages (
        id               BIGSERIAL PRIMARY KEY,
        conversation_id  BIGINT NOT NULL REFERENCES ask_conversations(id) ON DELETE CASCADE,
        role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
        content          JSONB NOT NULL,     -- Claude content blocks, kept verbatim
        text             TEXT,               -- plain answer text for display
        charts           JSONB,              -- charts the answer refers to
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_ask_messages_conv ON ask_messages (conversation_id, id);

      CREATE TABLE IF NOT EXISTS whatsapp_link_codes (
        code        TEXT PRIMARY KEY,
        store_id    BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at  TIMESTAMPTZ NOT NULL,
        used_at     TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS whatsapp_numbers (
        id               BIGSERIAL PRIMARY KEY,
        store_id         BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        phone            TEXT NOT NULL UNIQUE,        -- E.164 digits, e.g. 919876543210
        role             TEXT NOT NULL DEFAULT 'can_approve' CHECK (role IN ('can_approve','view_only')),
        connected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_message_at  TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS whatsapp_sessions (
        phone       TEXT PRIMARY KEY,
        state       JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- Every change proposed over WhatsApp, and whether it was approved.
      CREATE TABLE IF NOT EXISTS whatsapp_actions (
        id          BIGSERIAL PRIMARY KEY,
        store_id    BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        phone       TEXT NOT NULL,
        source      TEXT NOT NULL CHECK (source IN ('menu','ai')),
        kind        TEXT NOT NULL,
        title       TEXT NOT NULL,
        summary     TEXT NOT NULL,
        payload     JSONB NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled','expired','failed')),
        result      JSONB,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at  TIMESTAMPTZ NOT NULL,
        decided_at  TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_wa_actions_store ON whatsapp_actions (store_id, created_at DESC);
    `,
  },
  {
    id: "010_views",
    sql: `
      -- Lead time per supplier: 90-day average of real deliveries, switching to
      -- the latest delivery when it was slower; the supplier's setting otherwise.
      CREATE OR REPLACE VIEW supplier_lead_stats AS
      SELECT s.id AS supplier_id, s.store_id, s.lead_time_days AS default_lead_time,
             r90.avg_days, r90.stddev_days, COALESCE(r90.n, 0)::int AS deliveries_90d,
             last.lead_time_days AS latest_days, last.received_at AS latest_received_at,
             CASE WHEN r90.avg_days IS NULL THEN s.lead_time_days
                  WHEN last.lead_time_days > r90.avg_days THEN CEIL(last.lead_time_days)::int
                  ELSE CEIL(r90.avg_days)::int END AS effective_days
        FROM suppliers s
        LEFT JOIN LATERAL (
          SELECT AVG(lead_time_days) AS avg_days, STDDEV_SAMP(lead_time_days) AS stddev_days, COUNT(*) AS n
            FROM supplier_receipts r WHERE r.supplier_id = s.id AND r.received_at > now() - interval '90 days'
        ) r90 ON true
        LEFT JOIN LATERAL (
          SELECT lead_time_days, received_at FROM supplier_receipts r
           WHERE r.supplier_id = s.id ORDER BY received_at DESC LIMIT 1
        ) last ON true;

      -- Everything the forecast and reorder maths need per variant: which
      -- supplier (product choice > category preference > vendor match), the
      -- lead time to plan on, ordering rules and stock already on order.
      CREATE OR REPLACE VIEW variant_supply AS
      SELECT v.id AS variant_id, v.store_id, p.vendor, p.product_type AS category,
             COALESCE(v.supplier_id, sc.supplier_id, sv.supplier_id) AS supplier_id,
             CASE WHEN v.supplier_id IS NOT NULL THEN 'product'
                  WHEN sc.supplier_id IS NOT NULL THEN 'category'
                  WHEN sv.supplier_id IS NOT NULL THEN 'vendor' END AS supplier_source,
             COALESCE(v.lead_time_override, sls.effective_days, ss.default_lead_time_days, 14) AS lead_time_days,
             CASE WHEN v.lead_time_override IS NOT NULL THEN 'product'
                  WHEN sls.supplier_id IS NOT NULL AND sls.deliveries_90d > 0 THEN 'deliveries'
                  WHEN sls.supplier_id IS NOT NULL THEN 'supplier'
                  ELSE 'store_default' END AS lead_time_source,
             COALESCE(sls.stddev_days, 0)::float AS lead_time_stddev,
             v.case_pack, v.min_order_qty, v.cost AS unit_cost,
             COALESCE(oo.on_order, 0)::int AS on_order,
             COALESCE(oo.in_draft, 0)::int AS in_draft,
             oo.next_expected_at
        FROM variants v
        JOIN products p ON p.id = v.product_id
        LEFT JOIN supplier_categories sc ON sc.store_id = v.store_id AND sc.category = p.product_type
        LEFT JOIN supplier_vendors sv ON sv.store_id = v.store_id AND sv.vendor = p.vendor
        LEFT JOIN store_settings ss ON ss.store_id = v.store_id
        LEFT JOIN supplier_lead_stats sls ON sls.supplier_id = COALESCE(v.supplier_id, sc.supplier_id, sv.supplier_id)
        LEFT JOIN LATERAL (
          SELECT SUM(GREATEST(l.quantity - l.received_qty, 0)) FILTER (WHERE po.status IN ('approved','sent','partial')) AS on_order,
                 SUM(l.quantity) FILTER (WHERE po.status = 'draft') AS in_draft,
                 MIN(po.expected_at) FILTER (WHERE po.status IN ('approved','sent','partial')) AS next_expected_at
            FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id
           WHERE l.variant_id = v.id
        ) oo ON true;
    `,
  },
];

export async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query("SELECT id FROM schema_migrations")).rows.map((r: any) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
        await client.query("COMMIT");
        console.log(`[schema] applied ${m.id}`);
      } catch (e: any) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${m.id} failed: ${e.message}`);
      }
    }
  } finally {
    client.release();
  }
}
