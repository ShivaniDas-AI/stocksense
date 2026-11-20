/**
 * Locations and stock per location.
 *
 * variants.current_stock is the store total the platform reports. Each store
 * has one default location; other locations (a warehouse, a second shop) get
 * their stock from the platform where it reports per location, or from
 * PUT /locations/{id}/inventory. The default location holds whatever part of
 * the total is not at another location, so the levels always add up.
 */
import { query, queryOne } from "../db";
import { boolField, intField, invalid, notFound, onlyFields, strField } from "./errors";
import { requireFeature, storePlan } from "../plans";

export async function ensureDefaultLocation(storeId: number) {
  let loc = await queryOne("SELECT * FROM locations WHERE store_id=$1 AND is_default", [storeId]);
  if (!loc) {
    loc = await queryOne(
      `INSERT INTO locations (store_id, name, is_default) VALUES ($1, 'Main location', true)
       ON CONFLICT DO NOTHING RETURNING *`,
      [storeId]
    );
    loc ||= await queryOne("SELECT * FROM locations WHERE store_id=$1 AND is_default", [storeId]);
  }
  return loc;
}

/** Recompute the default location's share so levels add up to each variant's total. */
export async function rebalanceDefaultLevels(storeId: number) {
  const def = await ensureDefaultLocation(storeId);
  await query(
    `INSERT INTO inventory_levels (variant_id, location_id, on_hand, updated_at)
     SELECT v.id, $2, GREATEST(COALESCE(v.current_stock, 0) - COALESCE(o.other, 0), 0), now()
       FROM variants v
       LEFT JOIN (SELECT il.variant_id, SUM(il.on_hand) AS other
                    FROM inventory_levels il JOIN locations l ON l.id = il.location_id
                   WHERE l.store_id = $1 AND NOT l.is_default GROUP BY il.variant_id) o ON o.variant_id = v.id
      WHERE v.store_id = $1
     ON CONFLICT (variant_id, location_id) DO UPDATE SET on_hand = EXCLUDED.on_hand, updated_at = now()`,
    [storeId, def.id]
  );
}

function locOut(l: any) {
  return {
    id: Number(l.id),
    name: l.name,
    external_id: l.external_id ?? null,
    is_default: l.is_default,
    active: l.active,
    units_on_hand: l.units != null ? Number(l.units) : undefined,
    skus_in_stock: l.skus != null ? Number(l.skus) : undefined,
  };
}

export async function listLocations(storeId: number) {
  await ensureDefaultLocation(storeId);
  const rows = await query(
    `SELECT l.*, COALESCE(SUM(il.on_hand),0) AS units, COUNT(*) FILTER (WHERE il.on_hand > 0) AS skus
       FROM locations l LEFT JOIN inventory_levels il ON il.location_id = l.id
      WHERE l.store_id = $1 GROUP BY l.id ORDER BY l.is_default DESC, l.name`,
    [storeId]
  );
  return rows.map(locOut);
}

export async function getLocation(storeId: number, id: number) {
  const l = await queryOne("SELECT * FROM locations WHERE id=$1 AND store_id=$2", [id, storeId]);
  if (!l) throw notFound("location", id);
  return l;
}

export async function createLocation(storeId: number, body: any) {
  onlyFields(body, ["name", "external_id"]);
  const plan = await storePlan(storeId);
  const count = await queryOne("SELECT COUNT(*)::int AS n FROM locations WHERE store_id=$1 AND active", [storeId]);
  await ensureDefaultLocation(storeId);
  if (plan.location_limit !== null && (count?.n ?? 0) + 1 > plan.location_limit) await requireFeature(storeId, "locations");
  const name = strField(body, "name", { required: true, max: 120 })!;
  const ext = strField(body, "external_id", { max: 120 });
  const row = await queryOne(
    "INSERT INTO locations (store_id, name, external_id) VALUES ($1,$2,$3) RETURNING *",
    [storeId, name, ext ?? null]
  ).catch((e) => {
    if (e.code === "23505") throw invalid("duplicate_external_id", "Another location already has this external_id.", "external_id");
    throw e;
  });
  return locOut(row);
}

export async function updateLocation(storeId: number, id: number, body: any) {
  onlyFields(body, ["name", "active", "external_id"]);
  const l = await getLocation(storeId, id);
  const name = strField(body, "name", { max: 120 });
  const active = boolField(body, "active");
  const ext = strField(body, "external_id", { max: 120 });
  if (l.is_default && active === false) throw invalid("default_location", "The default location cannot be turned off.", "active");
  const row = await queryOne(
    `UPDATE locations SET name = COALESCE($3, name), active = COALESCE($4, active),
       external_id = CASE WHEN $5::boolean THEN $6 ELSE external_id END
     WHERE id=$1 AND store_id=$2 RETURNING *`,
    [id, storeId, name ?? null, active ?? null, ext !== undefined, ext ?? null]
  );
  return locOut(row);
}

/** Stock levels at one location, with each variant's title and SKU. */
export async function locationInventory(storeId: number, id: number) {
  await getLocation(storeId, id);
  const rows = await query(
    `SELECT il.variant_id, il.on_hand, il.updated_at, v.sku, v.title
       FROM inventory_levels il JOIN variants v ON v.id = il.variant_id
      WHERE il.location_id = $1 AND v.store_id = $2 ORDER BY v.title`,
    [id, storeId]
  );
  return rows.map((r: any) => ({ variant_id: Number(r.variant_id), sku: r.sku, title: r.title, on_hand: Number(r.on_hand), updated_at: r.updated_at }));
}

/**
 * Set stock at a non-default location (for warehouses or systems the store
 * platform does not report). Store totals change by the same amount; the
 * default location keeps its own count.
 */
export async function setLocationInventory(storeId: number, id: number, body: any) {
  onlyFields(body, ["levels"]);
  const l = await getLocation(storeId, id);
  if (!Array.isArray(body.levels) || !body.levels.length) throw invalid("missing_field", "Send levels: [{variant_id, on_hand}].", "levels");
  if (body.levels.length > 1000) throw invalid("too_many", "Send at most 1000 levels per request.", "levels");
  const updated: number[] = [];
  for (const [i, lv] of body.levels.entries()) {
    const vid = intField(lv, "variant_id", { required: true, min: 1 })!;
    const onHand = intField(lv, "on_hand", { required: true, min: 0 })!;
    const v = await queryOne("SELECT id FROM variants WHERE id=$1 AND store_id=$2", [vid, storeId]);
    if (!v) throw invalid("unknown_variant", `levels[${i}].variant_id ${vid} is not a product variant in this store.`, `levels[${i}].variant_id`);
    const prev = await queryOne("SELECT on_hand FROM inventory_levels WHERE variant_id=$1 AND location_id=$2", [vid, id]);
    const delta = onHand - Number(prev?.on_hand ?? 0);
    await query(
      `INSERT INTO inventory_levels (variant_id, location_id, on_hand) VALUES ($1,$2,$3)
       ON CONFLICT (variant_id, location_id) DO UPDATE SET on_hand = EXCLUDED.on_hand, updated_at = now()`,
      [vid, id, onHand]
    );
    if (!l.is_default && delta !== 0) {
      await query("UPDATE variants SET current_stock = COALESCE(current_stock,0) + $2 WHERE id=$1", [vid, delta]);
    } else if (l.is_default) {
      // Setting the default location directly: totals follow.
      await query(
        `UPDATE variants v SET current_stock = (SELECT COALESCE(SUM(on_hand),0) FROM inventory_levels WHERE variant_id = v.id) WHERE v.id=$1`,
        [vid]
      );
    }
    updated.push(vid);
  }
  return { location_id: id, updated: updated.length };
}

/** Move stock between two locations (transfer receipt). Totals do not change. */
export async function moveStock(variantId: number, fromId: number, toId: number, qty: number) {
  await query(
    `INSERT INTO inventory_levels (variant_id, location_id, on_hand) VALUES ($1,$2,0)
     ON CONFLICT DO NOTHING`,
    [variantId, toId]
  );
  await query("UPDATE inventory_levels SET on_hand = GREATEST(on_hand - $3, 0), updated_at = now() WHERE variant_id=$1 AND location_id=$2", [variantId, fromId, qty]);
  await query("UPDATE inventory_levels SET on_hand = on_hand + $3, updated_at = now() WHERE variant_id=$1 AND location_id=$2", [variantId, toId, qty]);
}

/** Add received stock at a location; store total rises too. */
export async function addStock(variantId: number, locationId: number, qty: number) {
  await query(
    `INSERT INTO inventory_levels (variant_id, location_id, on_hand) VALUES ($1,$2,$3)
     ON CONFLICT (variant_id, location_id) DO UPDATE SET on_hand = inventory_levels.on_hand + EXCLUDED.on_hand, updated_at = now()`,
    [variantId, locationId, qty]
  );
  await query("UPDATE variants SET current_stock = COALESCE(current_stock,0) + $2 WHERE id=$1", [variantId, qty]);
}

/**
 * Share of each variant's demand per location over the last 90 days, from
 * where orders were placed. Sales with no known location count for the
 * default location. Variants with no sales split evenly.
 */
export async function demandShares(storeId: number): Promise<Map<number, Map<number, number>>> {
  const def = await ensureDefaultLocation(storeId);
  const locs = await query("SELECT id, external_id FROM locations WHERE store_id=$1 AND active", [storeId]);
  const rows = await query(
    `SELECT v.id AS variant_id, COALESCE(l.id, $2) AS location_id, SUM(ol.quantity)::float AS units
       FROM order_lines ol
       JOIN variants v ON v.store_id = ol.store_id AND v.external_id = ol.variant_external_id
       LEFT JOIN locations l ON l.store_id = ol.store_id AND l.external_id = ol.location_external_id AND l.active
      WHERE ol.store_id = $1 AND ol.ordered_at > now() - interval '90 days'
      GROUP BY 1, 2`,
    [storeId, def.id]
  );
  const totals = new Map<number, number>();
  for (const r of rows) totals.set(Number(r.variant_id), (totals.get(Number(r.variant_id)) || 0) + Number(r.units));
  const shares = new Map<number, Map<number, number>>();
  for (const r of rows) {
    const vid = Number(r.variant_id);
    const t = totals.get(vid) || 0;
    if (!t) continue;
    if (!shares.has(vid)) shares.set(vid, new Map());
    shares.get(vid)!.set(Number(r.location_id), Number(r.units) / t);
  }
  (shares as any).even = new Map(locs.map((l: any) => [Number(l.id), 1 / locs.length]));
  return shares;
}

export function shareFor(shares: Map<number, Map<number, number>>, variantId: number, locationId: number): number {
  const m = shares.get(variantId);
  if (m) return m.get(locationId) ?? 0;
  return ((shares as any).even as Map<number, number>)?.get(locationId) ?? 0;
}
