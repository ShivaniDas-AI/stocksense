/**
 * Demo data (Settings > Data & sync > Load demo data): realistic products,
 * 14 months of sales, two locations, suppliers with delivery history. It is
 * built so every feature has something to show: products to reorder now and
 * soon, an overstocked one, one that never sold, a sudden sales spike, a
 * supplier that got slower, and a retail location running short while the
 * warehouse has plenty. Everything is tagged demo and removable.
 */
import { query, queryOne } from "../db";
import { conflict } from "./errors";
import { queueForecast } from "./inventory";
import { ensureDefaultLocation } from "./locations";
import { aggregateDailySales } from "../sync/sync";

interface DemoVariant { key: string; title: string; sku: string; price: number; cost: number; rate: number; stock: number; retailShare: number; pattern?: "intermittent" | "spike" | "none" | "growing" }
interface DemoProduct { key: string; title: string; vendor: string; type: string; variants: DemoVariant[] }

const SUPPLIERS = [
  { name: "Loomcraft Mills", vendor: "Loomcraft", lead: 17, email: "orders@loomcraft.example", contact: "Asha Menon", terms: "Net 30", moq: 500, history: [16, 17, 18, 17, 24] },
  { name: "Northline Supply", vendor: "Northline", lead: 7, email: "po@northline.example", contact: "Jonas Berg", terms: "Net 15", moq: 0, history: [7, 6, 8, 7] },
  { name: "Volta Goods", vendor: "Volta", lead: 11, email: "sales@voltagoods.example", contact: "Lena Ortiz", terms: "Prepaid", moq: 250, history: [11, 12, 10] },
  { name: "Cedar & Co", vendor: "Cedar & Co", lead: 21, email: "hello@cedarco.example", contact: "Sam Okafor", terms: "Net 45", moq: 0, history: [20, 22, 21] },
];

const PRODUCTS: DemoProduct[] = [
  { key: "hoodie", title: "Midnight Hoodie", vendor: "Loomcraft", type: "Hoodies", variants: [
    { key: "hb-s", title: "Midnight Hoodie / Black / S", sku: "MH-BLK-S", price: 48, cost: 21, rate: 0.9, stock: 46, retailShare: 0.3 },
    { key: "hb-m", title: "Midnight Hoodie / Black / M", sku: "MH-BLK-M", price: 48, cost: 21, rate: 1.4, stock: 38, retailShare: 0.3 },
    { key: "hb-l", title: "Midnight Hoodie / Black / L", sku: "MH-BLK-L", price: 48, cost: 21, rate: 1.8, stock: 11, retailShare: 0.3 },
    { key: "hg-m", title: "Midnight Hoodie / Grey / M", sku: "MH-GRY-M", price: 48, cost: 21, rate: 0.7, stock: 64, retailShare: 0.3 },
  ] },
  { key: "tee", title: "Everyday Tee", vendor: "Loomcraft", type: "T-Shirts", variants: [
    { key: "tw-m", title: "Everyday Tee / White / M", sku: "ET-WHT-M", price: 22, cost: 7.5, rate: 3.2, stock: 260, retailShare: 0.45 },
    { key: "tw-l", title: "Everyday Tee / White / L", sku: "ET-WHT-L", price: 22, cost: 7.5, rate: 2.4, stock: 95, retailShare: 0.4 },
    { key: "tn-m", title: "Everyday Tee / Navy / M", sku: "ET-NVY-M", price: 22, cost: 7.5, rate: 1.6, stock: 130, retailShare: 0.35 },
  ] },
  { key: "beanie", title: "Wool Beanie", vendor: "Loomcraft", type: "Accessories", variants: [
    { key: "beanie", title: "Wool Beanie / Charcoal", sku: "WB-CHR", price: 26, cost: 9, rate: 0.35, stock: 240, retailShare: 0.5 },
  ] },
  { key: "cap", title: "Trail Cap", vendor: "Northline", type: "Accessories", variants: [
    { key: "cap", title: "Trail Cap / Olive", sku: "TC-OLV", price: 28, cost: 10, rate: 1.1, stock: 18, retailShare: 0.4 },
  ] },
  { key: "tote", title: "Canvas Tote", vendor: "Northline", type: "Bags", variants: [
    { key: "tote", title: "Canvas Tote / Natural", sku: "CT-NAT", price: 19, cost: 6, rate: 1.9, stock: 120, retailShare: 0.5 },
  ] },
  { key: "bottle", title: "Insulated Bottle", vendor: "Volta", type: "Accessories", variants: [
    { key: "bottle", title: "Insulated Bottle / 750 ml", sku: "IB-750", price: 32, cost: 12, rate: 1.2, stock: 70, retailShare: 0.3, pattern: "spike" },
  ] },
  { key: "mug", title: "Stoneware Mug", vendor: "Volta", type: "Home", variants: [
    { key: "mug", title: "Stoneware Mug / Sand", sku: "SM-SND", price: 18, cost: 5.5, rate: 2.1, stock: 75, retailShare: 0.35, pattern: "growing" },
  ] },
  { key: "candle", title: "Cedar Candle", vendor: "Cedar & Co", type: "Home", variants: [
    { key: "candle", title: "Cedar Candle / Large", sku: "CC-LRG", price: 34, cost: 11, rate: 0.25, stock: 9, retailShare: 0.6, pattern: "intermittent" },
  ] },
  { key: "planner", title: "Desk Planner", vendor: "Cedar & Co", type: "Stationery", variants: [
    { key: "planner", title: "Desk Planner / 2027", sku: "DP-2027", price: 24, cost: 8, rate: 0.9, stock: 52, retailShare: 0.2 },
  ] },
  { key: "sleeve", title: "Gift Card Sleeve", vendor: "Cedar & Co", type: "Stationery", variants: [
    { key: "sleeve", title: "Gift Card Sleeve", sku: "GCS-1", price: 4, cost: 1, rate: 0, stock: 300, retailShare: 0.5, pattern: "none" },
  ] },
];

/** Small deterministic PRNG so demo data is the same every time. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poisson(lambda: number, r: () => number) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L && k < 200);
  return k - 1;
}

export async function loadDemoData(storeId: number) {
  const existing = await queryOne("SELECT COUNT(*)::int AS n FROM products WHERE store_id=$1 AND is_demo", [storeId]);
  if (existing?.n) throw conflict("demo_loaded", "Demo data is already loaded. Remove it first to load it again.");
  const store = await queryOne("SELECT is_demo FROM stores WHERE id=$1", [storeId]);

  // Locations: the default one plus a retail shop.
  const def = await ensureDefaultLocation(storeId);
  if (store?.is_demo) await query("UPDATE locations SET name='Wholesale Warehouse' WHERE id=$1", [def.id]);
  const retail = await queryOne(
    `INSERT INTO locations (store_id, name, external_id) VALUES ($1, 'Retail Store', 'demo-retail')
     ON CONFLICT (store_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET active = true RETURNING id`,
    [storeId]
  );

  // Suppliers with their vendors and delivery history (Loomcraft's last delivery was slow).
  const supplierIds = new Map<string, number>();
  for (const s of SUPPLIERS) {
    const row = await queryOne(
      `INSERT INTO suppliers (store_id, name, email, contact_name, lead_time_days, payment_terms, min_order_value, currency, is_demo, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',true,'Demo supplier') RETURNING id`,
      [storeId, s.name, s.email, s.contact, s.lead, s.terms, s.moq || null]
    );
    supplierIds.set(s.vendor, Number(row!.id));
    await query(
      `INSERT INTO supplier_vendors (store_id, vendor, supplier_id) VALUES ($1,$2,$3)
       ON CONFLICT (store_id, vendor) DO UPDATE SET supplier_id = EXCLUDED.supplier_id`,
      [storeId, s.vendor, row!.id]
    );
    const n = s.history.length;
    for (let i = 0; i < n; i++) {
      const daysAgo = 10 + (n - 1 - i) * 18; // oldest first, latest ~10 days ago
      await query(
        `INSERT INTO supplier_receipts (supplier_id, ordered_at, received_at, lead_time_days, on_time, fill_rate)
         VALUES ($1, now() - ($2 || ' days')::interval, now() - ($3 || ' days')::interval, $4, $5, $6)`,
        [row!.id, String(daysAgo + s.history[i]), String(daysAgo), s.history[i], s.history[i] <= s.lead + 1, i === n - 1 && s.vendor === "Loomcraft" ? 0.94 : 1]
      );
    }
  }
  // Hoodies are packed in 6s, and Loomcraft is also preferred for the whole Hoodies category.
  await query(
    "INSERT INTO supplier_categories (store_id, category, supplier_id) VALUES ($1,'Hoodies',$2) ON CONFLICT (store_id, category) DO UPDATE SET supplier_id = EXCLUDED.supplier_id",
    [storeId, supplierIds.get("Loomcraft")]
  );

  const r = rng(20261120);
  const DAYS = 420;
  const lines: { oid: string; vext: string; qty: number; rev: number; at: string; loc: string | null }[] = [];
  let variantCount = 0;

  for (const p of PRODUCTS) {
    const prod = await queryOne(
      `INSERT INTO products (store_id, external_id, title, vendor, product_type, status, is_demo)
       VALUES ($1,$2,$3,$4,$5,'active',true) RETURNING id`,
      [storeId, `demo-p-${p.key}`, p.title, p.vendor, p.type]
    );
    for (const v of p.variants) {
      const ext = `demo-v-${v.key}`;
      const casePack = p.type === "Hoodies" ? 6 : p.type === "T-Shirts" ? 12 : 1;
      const row = await queryOne(
        `INSERT INTO variants (store_id, product_id, external_id, sku, title, price, cost, current_stock, track_inventory, case_pack)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9) RETURNING id`,
        [storeId, prod!.id, ext, v.sku, v.title, v.price, v.cost, v.stock, casePack]
      );
      variantCount++;
      // Stock split: the retail store is short on the fastest tee, flush elsewhere.
      const retailStock = v.key === "tw-m" ? 4 : Math.round(v.stock * v.retailShare * 0.8);
      await query("INSERT INTO inventory_levels (variant_id, location_id, on_hand) VALUES ($1,$2,$3)", [row!.id, retail!.id, retailStock]);
      await query("INSERT INTO inventory_levels (variant_id, location_id, on_hand) VALUES ($1,$2,$3)", [row!.id, def.id, Math.max(v.stock - retailStock, 0)]);

      if (v.pattern === "none") continue; // never sold
      for (let d = DAYS; d >= 1; d--) {
        const date = new Date(Date.now() - d * 86_400_000);
        const dow = date.getUTCDay();
        const weekly = dow === 0 || dow === 6 ? 1.35 : dow === 1 ? 0.85 : 1;
        const yearly = 1 + 0.25 * Math.sin(((date.getUTCMonth() - 2) / 12) * 2 * Math.PI); // busier around Nov-Dec
        let lambda = v.rate * weekly * yearly;
        if (v.pattern === "growing") lambda *= 0.6 + 0.6 * ((DAYS - d) / DAYS);
        if (v.pattern === "spike" && d <= 3) lambda *= 4.5;
        let qty: number;
        if (v.pattern === "intermittent") qty = r() < 0.12 ? 1 + Math.floor(r() * 3) : 0;
        else qty = poisson(lambda, r);
        if (!qty) continue;
        const atRetail = r() < v.retailShare;
        lines.push({
          oid: `demo-o-${v.key}-${d}`,
          vext: ext,
          qty,
          rev: Math.round(qty * v.price * 100) / 100,
          at: new Date(date.getTime() - Math.floor(r() * 10) * 3_600_000).toISOString(),
          loc: atRetail ? "demo-retail" : null,
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i += 1000) {
    const c = lines.slice(i, i + 1000);
    await query(
      `INSERT INTO order_lines (store_id, external_order_id, variant_external_id, quantity, line_revenue, ordered_at, location_external_id)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::int[], $5::numeric[], $6::timestamptz[], $7::text[])
       ON CONFLICT DO NOTHING`,
      [storeId, c.map((l) => l.oid), c.map((l) => l.vext), c.map((l) => l.qty), c.map((l) => l.rev), c.map((l) => l.at), c.map((l) => l.loc)]
    );
  }
  await aggregateDailySales(storeId);
  await query("UPDATE stores SET sync_status='ready' WHERE id=$1 AND sync_status IN ('pending','error')", [storeId]);

  // A planned promotion so forecasts show a lift.
  await query(
    `INSERT INTO promotions (store_id, name, starts_on, ends_on, uplift_pct, scope, scope_value, source)
     VALUES ($1, 'Black Friday', CURRENT_DATE + 7, CURRENT_DATE + 10, 60, 'all', NULL, 'demo')`,
    [storeId]
  );
  const job = await queueForecast(storeId);
  return {
    loaded: true,
    products: PRODUCTS.length,
    variants: variantCount,
    order_lines: lines.length,
    suppliers: SUPPLIERS.length,
    locations: 2,
    forecast_job_id: Number(job.id),
    message: "Demo data loaded. Forecasts are being built and appear within a minute.",
  };
}

export async function removeDemoData(storeId: number) {
  const n = await queryOne("SELECT COUNT(*)::int AS n FROM products WHERE store_id=$1 AND is_demo", [storeId]);
  if (!n?.n) throw conflict("no_demo_data", "There is no demo data to remove.");
  await query(
    `DELETE FROM purchase_orders po WHERE po.store_id=$1 AND (po.supplier_id IN (SELECT id FROM suppliers WHERE store_id=$1 AND is_demo)
       OR NOT EXISTS (SELECT 1 FROM purchase_order_lines l JOIN variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
                       WHERE l.purchase_order_id = po.id AND NOT p.is_demo))`,
    [storeId]
  );
  await query("DELETE FROM transfers WHERE store_id=$1 AND (from_location_id IN (SELECT id FROM locations WHERE store_id=$1 AND external_id LIKE 'demo-%') OR to_location_id IN (SELECT id FROM locations WHERE store_id=$1 AND external_id LIKE 'demo-%'))", [storeId]);
  await query("DELETE FROM products WHERE store_id=$1 AND is_demo", [storeId]);
  await query("DELETE FROM order_lines WHERE store_id=$1 AND variant_external_id LIKE 'demo-%'", [storeId]);
  await query("DELETE FROM suppliers WHERE store_id=$1 AND is_demo", [storeId]);
  await query("DELETE FROM locations WHERE store_id=$1 AND external_id LIKE 'demo-%'", [storeId]);
  await query("DELETE FROM promotions WHERE store_id=$1 AND source='demo'", [storeId]);
  const job = await queueForecast(storeId);
  return { removed: true, products: n.n, forecast_job_id: Number(job.id) };
}
