/**
 * Transfer suggestions (guide chapter 10, Pro): find products where one
 * location has more cover than it needs while another is about to run short,
 * and suggest moving stock before paying for a new purchase order.
 */
import { query, queryOne } from "../db";
import { requireFeature } from "../plans";
import { conflict, intField, invalid, notFound, onlyFields, strField } from "./errors";
import { STATUS_SQL } from "./forecasts";
import { latestRunDate } from "./inventory";
import { demandShares, getLocation, moveStock, shareFor } from "./locations";
import { getForecastSettings } from "./settings";

const r1 = (v: number) => Math.round(v * 10) / 10;
const coverOf = (onHand: number, rate: number) => (rate > 0.001 ? r1(onHand / rate) : null);

export async function transferSuggestions(storeId: number) {
  await requireFeature(storeId, "transfers");
  const runDate = await latestRunDate(storeId);
  const locs = await query("SELECT * FROM locations WHERE store_id=$1 AND active ORDER BY is_default DESC, name", [storeId]);
  if (!runDate || locs.length < 2) {
    return { routes: [], message: locs.length < 2 ? "Transfers need at least two active locations." : "No forecast yet." };
  }
  const settings = await getForecastSettings(storeId);
  const shares = await demandShares(storeId);
  const rows = await query(
    `SELECT sr.variant_id, v.title, v.sku, f.avg_daily_demand, COALESCE(sr.lead_time_days, vs.lead_time_days) AS lt, ${STATUS_SQL} AS st
       FROM stock_risk sr JOIN variants v ON v.id = sr.variant_id JOIN variant_supply vs ON vs.variant_id = v.id
       LEFT JOIN forecasts f ON f.variant_id = sr.variant_id AND f.run_date = sr.run_date
      WHERE sr.store_id=$1 AND sr.run_date=$2 AND v.track_inventory AND COALESCE(f.avg_daily_demand,0) > 0.01`,
    [storeId, runDate]
  );
  const levels = await query(
    `SELECT il.variant_id, il.location_id, il.on_hand FROM inventory_levels il JOIN locations l ON l.id = il.location_id
      WHERE l.store_id=$1 AND l.active`,
    [storeId]
  );
  const lv = new Map<string, number>();
  for (const l of levels) lv.set(`${l.variant_id}:${l.location_id}`, Number(l.on_hand));

  const routes = new Map<string, any>();
  // Stock already planned to move does not count twice.
  const pending = await query(
    `SELECT tl.variant_id, t.from_location_id, t.to_location_id, tl.quantity FROM transfers t JOIN transfer_lines tl ON tl.transfer_id = t.id
      WHERE t.store_id=$1 AND t.status IN ('draft','shipped')`,
    [storeId]
  );
  for (const p of pending) {
    lv.set(`${p.variant_id}:${p.from_location_id}`, (lv.get(`${p.variant_id}:${p.from_location_id}`) ?? 0) - Number(p.quantity));
    lv.set(`${p.variant_id}:${p.to_location_id}`, (lv.get(`${p.variant_id}:${p.to_location_id}`) ?? 0) + Number(p.quantity));
  }

  for (const r of rows) {
    const vid = Number(r.variant_id);
    const avg = Number(r.avg_daily_demand);
    const lt = Number(r.lt);
    const per = locs.map((l: any) => {
      const rate = avg * shareFor(shares, vid, Number(l.id));
      const onHand = Math.max(lv.get(`${vid}:${l.id}`) ?? 0, 0);
      return { loc: l, rate, onHand, cover: rate > 0.001 ? onHand / rate : Infinity };
    });
    for (const dest of per) {
      if (dest.rate <= 0.001 || dest.cover >= lt) continue; // not about to run short
      const need = Math.ceil(dest.rate * (lt + 14) - dest.onHand); // bring it to lead time + 2 weeks
      if (need <= 0) continue;
      const sources = per
        .filter((s) => s !== dest)
        .map((s) => ({ ...s, surplus: Math.floor(s.onHand - s.rate * (lt + settings.coverage_days)) }))
        .filter((s) => s.surplus > 0)
        .sort((a, b) => b.surplus - a.surplus);
      const src = sources[0];
      if (!src) continue;
      const qty = Math.min(need, src.surplus);
      if (qty < 1) continue;
      src.onHand -= qty; // so the same surplus is not offered twice
      const key = `${src.loc.id}->${dest.loc.id}`;
      if (!routes.has(key)) {
        routes.set(key, {
          from_location: { id: Number(src.loc.id), name: src.loc.name },
          to_location: { id: Number(dest.loc.id), name: dest.loc.name },
          lines: [],
        });
      }
      routes.get(key).lines.push({
        variant_id: vid,
        title: r.title,
        sku: r.sku,
        status: r.st,
        quantity: qty,
        from: { on_hand: src.onHand + qty, cover_days_before: coverOf(src.onHand + qty, src.rate), cover_days_after: coverOf(src.onHand, src.rate) },
        to: { on_hand: dest.onHand, cover_days_before: coverOf(dest.onHand, dest.rate), cover_days_after: coverOf(dest.onHand + qty, dest.rate) },
      });
    }
  }
  const out = Array.from(routes.values()).map((rt) => ({ ...rt, name: `${rt.from_location.name} to ${rt.to_location.name}`, units: rt.lines.reduce((a: number, l: any) => a + l.quantity, 0) }));
  return { routes: out, message: out.length ? null : "No transfers needed: no location is about to run short while another has spare stock." };
}

async function nextNumber(storeId: number) {
  await query("SELECT pg_advisory_xact_lock(43, $1::int)", [storeId]);
  return Number((await queryOne("SELECT COALESCE(MAX(number), 1000) + 1 AS n FROM transfers WHERE store_id=$1", [storeId])).n);
}

async function transferOut(t: any) {
  const lines = await query(
    `SELECT tl.*, v.title, v.sku FROM transfer_lines tl JOIN variants v ON v.id = tl.variant_id WHERE tl.transfer_id=$1 ORDER BY v.title`,
    [t.id]
  );
  const from = await queryOne("SELECT id, name FROM locations WHERE id=$1", [t.from_location_id]);
  const to = await queryOne("SELECT id, name FROM locations WHERE id=$1", [t.to_location_id]);
  return {
    id: Number(t.id),
    number: `T-${t.number}`,
    status: t.status,
    from_location: { id: Number(from.id), name: from.name },
    to_location: { id: Number(to.id), name: to.name },
    lines: lines.map((l: any) => ({ variant_id: Number(l.variant_id), title: l.title, sku: l.sku, quantity: Number(l.quantity) })),
    units: lines.reduce((a: number, l: any) => a + Number(l.quantity), 0),
    notes: t.notes,
    created_at: t.created_at,
    shipped_at: t.shipped_at,
    received_at: t.received_at,
    cancelled_at: t.cancelled_at,
  };
}

export async function getTransfer(storeId: number, id: number) {
  const t = await queryOne("SELECT * FROM transfers WHERE id=$1 AND store_id=$2", [id, storeId]);
  if (!t) throw notFound("transfer", id);
  return transferOut(t);
}

export async function listTransfers(storeId: number, opts: { status?: string; page?: number; limit?: number } = {}) {
  await requireFeature(storeId, "transfers");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 250);
  const page = Math.max(opts.page ?? 1, 1);
  const params: any[] = [storeId];
  let where = "store_id=$1";
  if (opts.status) {
    if (!["draft", "shipped", "received", "cancelled"].includes(opts.status)) throw invalid("invalid_status", "status must be draft, shipped, received or cancelled.", "status");
    params.push(opts.status); where += " AND status=$2";
  }
  const total = (await queryOne(`SELECT COUNT(*)::int AS n FROM transfers WHERE ${where}`, params))?.n ?? 0;
  params.push(limit, (page - 1) * limit);
  const rows = await query(`SELECT * FROM transfers WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const data = [];
  for (const r of rows) data.push(await transferOut(r));
  return { data, page, limit, total, has_more: page * limit < total };
}

/** Create draft transfer (the "Create draft transfer" button). */
export async function createTransfer(storeId: number, body: any) {
  await requireFeature(storeId, "transfers");
  onlyFields(body, ["from_location_id", "to_location_id", "lines", "notes"]);
  const fromId = intField(body, "from_location_id", { required: true, min: 1 })!;
  const toId = intField(body, "to_location_id", { required: true, min: 1 })!;
  if (fromId === toId) throw invalid("same_location", "from_location_id and to_location_id must differ.", "to_location_id");
  await getLocation(storeId, fromId);
  await getLocation(storeId, toId);
  if (!Array.isArray(body.lines) || !body.lines.length) throw invalid("missing_field", "lines must list at least one {variant_id, quantity}.", "lines");
  const lines: { variant_id: number; quantity: number }[] = [];
  for (const [i, l] of body.lines.entries()) {
    const vid = intField(l, "variant_id", { required: true, min: 1 })!;
    const qty = intField(l, "quantity", { required: true, min: 1 })!;
    const lvl = await queryOne(
      `SELECT v.id, COALESCE(il.on_hand,0) AS on_hand FROM variants v
         LEFT JOIN inventory_levels il ON il.variant_id = v.id AND il.location_id = $3
        WHERE v.id=$1 AND v.store_id=$2`,
      [vid, storeId, fromId]
    );
    if (!lvl) throw invalid("unknown_variant", `lines[${i}].variant_id ${vid} is not in this store.`, `lines[${i}].variant_id`);
    if (qty > Number(lvl.on_hand)) throw invalid("not_enough_stock", `lines[${i}]: only ${lvl.on_hand} units of variant ${vid} at the source location.`, `lines[${i}].quantity`);
    if (lines.some((x) => x.variant_id === vid)) throw invalid("duplicate_line", `lines[${i}]: variant ${vid} appears twice.`, `lines[${i}].variant_id`);
    lines.push({ variant_id: vid, quantity: qty });
  }
  const number = await nextNumber(storeId);
  const t = await queryOne(
    "INSERT INTO transfers (store_id, number, from_location_id, to_location_id, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [storeId, number, fromId, toId, strField(body, "notes", { max: 1000 }) ?? null]
  );
  for (const l of lines) await query("INSERT INTO transfer_lines (transfer_id, variant_id, quantity) VALUES ($1,$2,$3)", [t.id, l.variant_id, l.quantity]);
  return transferOut(t);
}

/** POST /transfers/:id {"action": "ship" | "receive" | "cancel"}; receiving moves the stock. */
export async function transferAction(storeId: number, id: number, body: any) {
  await requireFeature(storeId, "transfers");
  onlyFields(body, ["action"]);
  const action = strField(body, "action", { required: true });
  const t = await queryOne("SELECT * FROM transfers WHERE id=$1 AND store_id=$2 FOR UPDATE", [id, storeId]);
  if (!t) throw notFound("transfer", id);
  const need = (allowed: string[]) => {
    if (!allowed.includes(t.status)) throw conflict("invalid_transition", `T-${t.number} is ${t.status}; ${action} needs ${allowed.join(" or ")}.`);
  };
  if (action === "ship") {
    need(["draft"]);
    await query("UPDATE transfers SET status='shipped', shipped_at=now() WHERE id=$1", [id]);
  } else if (action === "receive") {
    need(["draft", "shipped"]);
    const lines = await query("SELECT * FROM transfer_lines WHERE transfer_id=$1", [id]);
    for (const l of lines) await moveStock(Number(l.variant_id), Number(t.from_location_id), Number(t.to_location_id), Number(l.quantity));
    await query("UPDATE transfers SET status='received', received_at=now(), shipped_at=COALESCE(shipped_at, now()) WHERE id=$1", [id]);
  } else if (action === "cancel") {
    need(["draft", "shipped"]);
    await query("UPDATE transfers SET status='cancelled', cancelled_at=now() WHERE id=$1", [id]);
  } else {
    throw invalid("invalid_action", "action must be ship, receive or cancel.", "action");
  }
  return getTransfer(storeId, id);
}
