/**
 * Suppliers (guide chapter 8): lead times, contacts, ordering terms, which
 * vendors they make and which categories they are preferred for.
 *
 * Which supplier a product uses:
 *   1. a supplier chosen for the product (forecast page or reorder screen),
 *   2. else its category's preferred supplier,
 *   3. else the supplier that makes its vendor.
 * The variant_supply view applies this order.
 */
import { query, queryOne } from "../db";
import { hasFeature } from "../plans";
import { intField, invalid, notFound, numField, onlyFields, strField } from "./errors";
import { queueForecast } from "./inventory";

const FIELDS = [
  "name", "website", "address", "contact_name", "email", "phone", "lead_time_days",
  "min_order_value", "currency", "payment_terms", "notes", "vendors", "categories",
];

const n = (v: any) => (v === null || v === undefined ? null : Number(v));

function stringList(body: any, field: string): string[] | undefined {
  const v = body?.[field];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw invalid("invalid_value", `${field} must be a list of names.`, field);
  return Array.from(new Set(v.map((s: string) => s.trim()).filter(Boolean)));
}

async function supplierOut(storeId: number, s: any, opts: { detail?: boolean } = {}) {
  const stats = await queryOne("SELECT * FROM supplier_lead_stats WHERE supplier_id=$1", [s.id]);
  const vendors = (await query("SELECT vendor FROM supplier_vendors WHERE supplier_id=$1 ORDER BY vendor", [s.id])).map((r: any) => r.vendor);
  const categories = (await query("SELECT category FROM supplier_categories WHERE supplier_id=$1 ORDER BY category", [s.id])).map((r: any) => r.category);
  const products = await queryOne("SELECT COUNT(*)::int AS n FROM variant_supply WHERE supplier_id=$1", [s.id]);

  const avg = n(stats?.avg_days);
  const latest = n(stats?.latest_days);
  // Arrow on the lead time badge: slower or faster than the 90-day average.
  const trend = avg && latest ? (latest > avg * 1.1 ? "slower" : latest < avg * 0.9 ? "faster" : "steady") : null;

  const out: any = {
    id: Number(s.id),
    name: s.name,
    website: s.website,
    address: s.address,
    contact_name: s.contact_name,
    email: s.email,
    phone: s.phone,
    lead_time_days: Number(s.lead_time_days),
    lead_time_90d_days: avg !== null ? Math.round(avg * 10) / 10 : null,
    lead_time_latest_days: latest,
    lead_time_effective_days: Number(stats?.effective_days ?? s.lead_time_days),
    lead_time_trend: trend,
    deliveries_90d: Number(stats?.deliveries_90d ?? 0),
    min_order_value: n(s.min_order_value),
    currency: s.currency,
    payment_terms: s.payment_terms,
    notes: s.notes,
    vendors,
    categories,
    product_count: products?.n ?? 0,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };

  // Supplier scorecards are a Pro feature.
  if (await hasFeature(storeId, "supplier_scorecards")) {
    const sc = await queryOne(
      `SELECT AVG(CASE WHEN on_time THEN 1.0 ELSE 0.0 END) FILTER (WHERE on_time IS NOT NULL) AS on_time,
              AVG(fill_rate) AS fill
         FROM supplier_receipts WHERE supplier_id=$1 AND received_at > now() - interval '180 days'`,
      [s.id]
    );
    const open = await queryOne(
      `SELECT COALESCE(SUM(GREATEST(l.quantity - l.received_qty,0) * COALESCE(l.unit_cost,0)),0)::float AS v
         FROM purchase_orders po JOIN purchase_order_lines l ON l.purchase_order_id = po.id
        WHERE po.supplier_id=$1 AND po.status IN ('approved','sent','partial')`,
      [s.id]
    );
    out.scorecard = {
      on_time_rate: sc?.on_time != null ? Math.round(Number(sc.on_time) * 1000) / 1000 : null,
      fill_rate: sc?.fill != null ? Math.round(Number(sc.fill) * 1000) / 1000 : null,
      open_order_value: Math.round(Number(open?.v ?? 0) * 100) / 100,
    };
  }

  if (opts.detail) {
    out.lead_time_history = (
      await query(
        `SELECT r.purchase_order_id, po.number, r.ordered_at, r.received_at, r.lead_time_days, r.on_time, r.fill_rate
           FROM supplier_receipts r LEFT JOIN purchase_orders po ON po.id = r.purchase_order_id
          WHERE r.supplier_id=$1 ORDER BY r.received_at DESC LIMIT 20`,
        [s.id]
      )
    ).map((r: any) => ({
      purchase_order_id: n(r.purchase_order_id),
      purchase_order_number: r.number ? `PO-${r.number}` : null,
      ordered_at: r.ordered_at,
      received_at: r.received_at,
      lead_time_days: Number(r.lead_time_days),
      on_time: r.on_time,
      fill_rate: n(r.fill_rate),
    }));
  }
  return out;
}

export async function listSuppliers(storeId: number, opts: { q?: string; page?: number; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 250);
  const page = Math.max(opts.page ?? 1, 1);
  const params: any[] = [storeId];
  let where = "store_id=$1";
  if (opts.q) {
    params.push(`%${opts.q}%`);
    where += ` AND (name ILIKE $2 OR email ILIKE $2 OR contact_name ILIKE $2)`;
  }
  const total = (await queryOne(`SELECT COUNT(*)::int AS n FROM suppliers WHERE ${where}`, params))?.n ?? 0;
  params.push(limit, (page - 1) * limit);
  const rows = await query(`SELECT * FROM suppliers WHERE ${where} ORDER BY name LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const data = [];
  for (const r of rows) data.push(await supplierOut(storeId, r));
  return { data, page, limit, total, has_more: page * limit < total };
}

export async function getSupplierRow(storeId: number, id: number) {
  const s = await queryOne("SELECT * FROM suppliers WHERE id=$1 AND store_id=$2", [id, storeId]);
  if (!s) throw notFound("supplier", id);
  return s;
}

export async function getSupplier(storeId: number, id: number) {
  return supplierOut(storeId, await getSupplierRow(storeId, id), { detail: true });
}

function validateSupplier(body: any, creating: boolean) {
  onlyFields(body, creating ? FIELDS : [...FIELDS, "id"]);
  const v = {
    name: strField(body, "name", { required: creating, max: 120 }),
    website: strField(body, "website", { max: 300 }),
    address: strField(body, "address", { max: 500 }),
    contact_name: strField(body, "contact_name", { max: 120 }),
    email: strField(body, "email", { max: 200 }),
    phone: strField(body, "phone", { max: 40 }),
    lead_time_days: intField(body, "lead_time_days", { required: creating, min: 1, max: 365 }),
    min_order_value: numField(body, "min_order_value", { min: 0 }),
    currency: strField(body, "currency", { max: 3 }),
    payment_terms: strField(body, "payment_terms", { max: 120 }),
    notes: strField(body, "notes", { max: 2000 }),
    vendors: stringList(body, "vendors"),
    categories: stringList(body, "categories"),
  };
  if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) {
    throw invalid("invalid_email", "email is not a valid address. Purchase orders are emailed here.", "email");
  }
  if (v.website && !/^https?:\/\/\S+$/i.test(v.website)) throw invalid("invalid_url", "website must start with http:// or https://.", "website");
  if (v.currency && !/^[A-Za-z]{3}$/.test(v.currency)) throw invalid("invalid_currency", "currency must be a 3-letter code such as USD or INR.", "currency");
  if (v.currency) v.currency = v.currency.toUpperCase();
  return v;
}

async function setMappings(storeId: number, supplierId: number, vendors?: string[], categories?: string[]) {
  if (vendors) {
    await query("DELETE FROM supplier_vendors WHERE supplier_id=$1", [supplierId]);
    for (const vendor of vendors) {
      await query(
        `INSERT INTO supplier_vendors (store_id, vendor, supplier_id) VALUES ($1,$2,$3)
         ON CONFLICT (store_id, vendor) DO UPDATE SET supplier_id = EXCLUDED.supplier_id`,
        [storeId, vendor, supplierId]
      );
    }
  }
  if (categories) {
    await query("DELETE FROM supplier_categories WHERE supplier_id=$1", [supplierId]);
    for (const category of categories) {
      await query(
        `INSERT INTO supplier_categories (store_id, category, supplier_id) VALUES ($1,$2,$3)
         ON CONFLICT (store_id, category) DO UPDATE SET supplier_id = EXCLUDED.supplier_id`,
        [storeId, category, supplierId]
      );
    }
  }
}

function uniqueName<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e.code === "23505") throw invalid("duplicate_name", "A supplier with this name already exists.", "name");
    throw e;
  });
}

export async function createSupplier(storeId: number, body: any) {
  const v = validateSupplier(body, true);
  const s = await uniqueName(
    queryOne(
      `INSERT INTO suppliers (store_id, name, website, address, contact_name, email, phone, lead_time_days,
         min_order_value, currency, payment_terms, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [storeId, v.name, v.website ?? null, v.address ?? null, v.contact_name ?? null, v.email ?? null, v.phone ?? null,
        v.lead_time_days, v.min_order_value ?? null, v.currency ?? null, v.payment_terms ?? null, v.notes ?? null]
    )
  );
  await setMappings(storeId, Number(s!.id), v.vendors, v.categories);
  if (v.vendors?.length || v.categories?.length) await queueForecast(storeId);
  return getSupplier(storeId, Number(s!.id));
}

export async function updateSupplier(storeId: number, id: number, body: any) {
  await getSupplierRow(storeId, id);
  const v = validateSupplier(body, false);
  const cols: [string, any][] = (
    ["name", "website", "address", "contact_name", "email", "phone", "lead_time_days", "min_order_value", "currency", "payment_terms", "notes"] as const
  )
    .filter((k) => (v as any)[k] !== undefined)
    .map((k) => [k, (v as any)[k]]);
  if (v.name === null) throw invalid("missing_field", "name cannot be empty.", "name");
  if (cols.length) {
    const sets = cols.map(([k], i) => `${k} = $${i + 3}`).join(", ");
    await uniqueName(query(`UPDATE suppliers SET ${sets}, updated_at = now() WHERE id=$1 AND store_id=$2`, [id, storeId, ...cols.map((c) => c[1])]));
  }
  await setMappings(storeId, id, v.vendors, v.categories);
  // Lead time or product assignment changes move reorder points: rebuild.
  if (v.lead_time_days !== undefined || v.vendors || v.categories) await queueForecast(storeId);
  return getSupplier(storeId, id);
}

/** POST /suppliers from the guide: create, or update when id is given. */
export async function upsertSupplier(storeId: number, body: any) {
  if (body && body.id !== undefined && body.id !== null) {
    const id = intField(body, "id", { min: 1 })!;
    const { id: _ignored, ...rest } = body;
    return { created: false, supplier: await updateSupplier(storeId, id, rest) };
  }
  return { created: true, supplier: await createSupplier(storeId, body) };
}

/** Deleting unassigns its products; its purchase orders are kept. */
export async function deleteSupplier(storeId: number, id: number) {
  const s = await getSupplierRow(storeId, id);
  const affected = await queryOne("SELECT COUNT(*)::int AS n FROM variant_supply WHERE supplier_id=$1", [id]);
  await query("DELETE FROM suppliers WHERE id=$1 AND store_id=$2", [id, storeId]);
  await queueForecast(storeId);
  return { id, name: s.name, deleted: true, products_unassigned: affected?.n ?? 0 };
}

/** Distinct product vendors with their product counts and assigned supplier. */
export async function listVendors(storeId: number) {
  const rows = await query(
    `SELECT p.vendor, COUNT(DISTINCT v.id)::int AS variants, sv.supplier_id, s.name AS supplier_name
       FROM products p JOIN variants v ON v.product_id = p.id
       LEFT JOIN supplier_vendors sv ON sv.store_id = p.store_id AND sv.vendor = p.vendor
       LEFT JOIN suppliers s ON s.id = sv.supplier_id
      WHERE p.store_id=$1 AND p.vendor IS NOT NULL AND p.vendor <> ''
      GROUP BY p.vendor, sv.supplier_id, s.name ORDER BY p.vendor`,
    [storeId]
  );
  return rows.map((r: any) => ({ vendor: r.vendor, variants: r.variants, supplier_id: n(r.supplier_id), supplier_name: r.supplier_name }));
}

/** Product categories (product type) with counts and preferred supplier. */
export async function listCategories(storeId: number) {
  const rows = await query(
    `SELECT p.product_type AS category, COUNT(DISTINCT v.id)::int AS variants, sc.supplier_id, s.name AS supplier_name
       FROM products p JOIN variants v ON v.product_id = p.id
       LEFT JOIN supplier_categories sc ON sc.store_id = p.store_id AND sc.category = p.product_type
       LEFT JOIN suppliers s ON s.id = sc.supplier_id
      WHERE p.store_id=$1 AND p.product_type IS NOT NULL AND p.product_type <> ''
      GROUP BY p.product_type, sc.supplier_id, s.name ORDER BY p.product_type`,
    [storeId]
  );
  return rows.map((r: any) => ({ category: r.category, variants: r.variants, supplier_id: n(r.supplier_id), supplier_name: r.supplier_name }));
}

/**
 * Create a supplier for every product vendor that has none yet, using the
 * store's default lead time. Runs after each import.
 */
export async function createSuppliersFromVendors(storeId: number): Promise<number> {
  const rows = await query(
    `SELECT DISTINCT p.vendor FROM products p
      WHERE p.store_id=$1 AND p.vendor IS NOT NULL AND p.vendor <> ''
        AND NOT EXISTS (SELECT 1 FROM supplier_vendors sv WHERE sv.store_id = p.store_id AND sv.vendor = p.vendor)`,
    [storeId]
  );
  const settings = await queryOne("SELECT default_lead_time_days FROM store_settings WHERE store_id=$1", [storeId]);
  let created = 0;
  for (const r of rows) {
    const s = await queryOne(
      `INSERT INTO suppliers (store_id, name, lead_time_days) VALUES ($1,$2,$3)
       ON CONFLICT (store_id, lower(name)) DO UPDATE SET updated_at = suppliers.updated_at RETURNING id, (xmax = 0) AS inserted`,
      [storeId, r.vendor, settings?.default_lead_time_days ?? 14]
    );
    await query(
      "INSERT INTO supplier_vendors (store_id, vendor, supplier_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [storeId, r.vendor, s!.id]
    );
    if (s!.inserted) created++;
  }
  return created;
}
