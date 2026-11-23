"""
StockSense forecast worker.

For every store, per product variant (guide chapter 15):
  1. Daily sales history (last 365 days, zero-filled).
  2. Method by history:
       - under 60 days or under 10 days with a sale  -> 28-day moving average ("SMA")
       - more than 60% of days without a sale        -> Croston SBA (intermittent)
       - otherwise                                    -> AutoETS with weekly seasonality
  3. 56 days of daily forecast with an 80% range, lifted on planned promotion days.
  4. Accuracy: re-forecast the last 4 weeks and compare weekly totals with real sales -> confidence.
  5. With the store's forecasting settings and the supplier's lead time:
       safety stock  = z x sqrt(LT x daily variation^2 + daily demand^2 x lead time variation^2)
       reorder point = demand during the lead time + safety stock
       suggested qty = demand over (lead time + coverage) + safety stock - on hand - on order,
                       raised to the minimum order quantity, rounded up to whole case packs
       days of cover = walked day by day through the forecast, with stock on order landing
                       on its expected date
  6. Status: reorder_now / watch / healthy / overstocked / no_sales (never sold) / untracked.
  7. Writes forecasts and stock_risk, then stamps stores.forecasted_at so the server
     checks alerts and refreshes automatic purchase-order drafts.

Modes:
  python forecast_worker.py           every ready store once
  python forecast_worker.py --queued  only stores with a queued 'forecast' job
  python forecast_worker.py --loop    full run at start, then the queue every 30 s and the
                                      scheduled rebuild at 02:00 UTC (nightly for Scale and
                                      Pro, Mondays for Launch; Pro also rebuilds hourly
                                      through jobs the server queues)
"""

import json
import math
import os
import sys
import time
import traceback
from datetime import date, datetime, timedelta, timezone
from statistics import NormalDist

import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras
from statsforecast import StatsForecast
from statsforecast.models import AutoETS, CrostonSBA

DATABASE_URL = os.environ["DATABASE_URL"]
HORIZON_DAYS = 56          # stored daily forecast (8 weeks)
HISTORY_DAYS = 365
MIN_HISTORY_DAYS = 60
MIN_SALE_DAYS = 10
INTERMITTENT_ZERO_RATIO = 0.6
BACKTEST_DAYS = 28
QUEUE_POLL_SECONDS = 30
NIGHTLY_HOUR_UTC = 2
Z80 = NormalDist().inv_cdf(0.9)  # two-sided 80% range

DEFAULT_SETTINGS = dict(service_level=0.95, default_lead_time_days=14, coverage_days=60,
                        overstock_days=90, velocity_threshold=1.8)


def get_conn():
    return psycopg2.connect(DATABASE_URL)


def dict_rows(conn, sql, params=()):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql, params)
        return cur.fetchall()


# ---------------------------------------------------------------- inputs

def load_settings(conn, store_id):
    rows = dict_rows(conn, "SELECT * FROM store_settings WHERE store_id = %s", (store_id,))
    s = dict(DEFAULT_SETTINGS)
    if rows:
        for k in s:
            s[k] = float(rows[0][k]) if k in ("service_level", "velocity_threshold") else int(rows[0][k])
    return s


def load_history(conn, store_id):
    cutoff = date.today() - timedelta(days=HISTORY_DAYS)
    df = pd.read_sql(
        "SELECT variant_id, sale_date, units_sold FROM daily_sales WHERE store_id = %s AND sale_date >= %s ORDER BY variant_id, sale_date",
        conn, params=(store_id, cutoff),
    )
    if df.empty:
        return {}
    yesterday = date.today() - timedelta(days=1)
    out = {}
    for vid, g in df.groupby("variant_id"):
        end = max(yesterday, pd.Timestamp(g["sale_date"].max()).date())
        idx = pd.date_range(g["sale_date"].min(), end, freq="D")
        s = g.set_index(pd.to_datetime(g["sale_date"]))["units_sold"].reindex(idx, fill_value=0).astype(float)
        out[int(vid)] = s
    return out


def load_variants(conn, store_id):
    rows = dict_rows(conn, """
        SELECT v.id, v.current_stock, v.safety_stock AS min_safety, v.price, v.cost, v.track_inventory,
               p.vendor, p.product_type,
               vs.supplier_id, vs.lead_time_days, vs.lead_time_stddev, vs.case_pack, vs.min_order_qty, vs.on_order,
               EXISTS (SELECT 1 FROM daily_sales ds WHERE ds.variant_id = v.id) AS ever_sold
          FROM variants v JOIN products p ON p.id = v.product_id JOIN variant_supply vs ON vs.variant_id = v.id
         WHERE v.store_id = %s""", (store_id,))
    return {int(r["id"]): r for r in rows}


def load_arrivals(conn, store_id):
    """Stock still expected on open purchase orders, by variant and expected date."""
    rows = dict_rows(conn, """
        SELECT l.variant_id, po.expected_at, SUM(GREATEST(l.quantity - l.received_qty, 0))::int AS qty
          FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id
         WHERE po.store_id = %s AND po.status IN ('approved','sent','partial')
         GROUP BY 1, 2""", (store_id,))
    out = {}
    for r in rows:
        out.setdefault(int(r["variant_id"]), []).append((r["expected_at"], int(r["qty"])))
    return out


def load_promotions(conn, store_id):
    return dict_rows(conn, """
        SELECT starts_on, ends_on, uplift_pct, scope, scope_value FROM promotions
         WHERE store_id = %s AND ends_on >= CURRENT_DATE AND starts_on <= CURRENT_DATE + %s""",
                     (store_id, HORIZON_DAYS))


# ---------------------------------------------------------------- forecasting

def classify(series):
    if len(series) < MIN_HISTORY_DAYS or int((series > 0).sum()) < MIN_SALE_DAYS:
        return "SMA"
    if float((series == 0).mean()) > INTERMITTENT_ZERO_RATIO:
        return "CrostonSBA"
    return "AutoETS"


def sf_forecast(series_by_vid, vids, model_name, h, with_level):
    """Forecast a batch with statsforecast; returns {vid: (yhat, lo, hi)} (lo/hi may be None)."""
    df = pd.concat(
        [pd.DataFrame({"unique_id": v, "ds": series_by_vid[v].index, "y": series_by_vid[v].values}) for v in vids],
        ignore_index=True,
    )
    model = CrostonSBA() if model_name == "CrostonSBA" else AutoETS(season_length=7)
    sf = StatsForecast(models=[model], freq="D", n_jobs=1)
    out = sf.forecast(df=df, h=h, level=[80]) if with_level else sf.forecast(df=df, h=h)
    if "unique_id" not in out.columns:
        out = out.reset_index()
    name = model.__class__.__name__
    res = {}
    for vid, g in out.groupby("unique_id"):
        g = g.sort_values("ds")
        y = np.clip(g[name].to_numpy(dtype=float), 0, None)
        lo = np.clip(g[f"{name}-lo-80"].to_numpy(dtype=float), 0, None) if with_level and f"{name}-lo-80" in g else None
        hi = np.clip(g[f"{name}-hi-80"].to_numpy(dtype=float), 0, None) if with_level and f"{name}-hi-80" in g else None
        res[int(vid)] = (y, lo, hi)
    return res


def sma(series, h):
    window = series.tail(28)
    rate = float(window.mean()) if len(window) else 0.0
    return np.full(h, max(rate, 0.0))


def band_from_history(y, series):
    """80% range when the model gives none: forecast +/- z x recent daily variation."""
    sd = float(series.tail(56).std(ddof=1)) if len(series) > 2 else float(np.mean(y))
    sd = 0.0 if math.isnan(sd) else sd
    return np.clip(y - Z80 * sd, 0, None), y + Z80 * sd


def forecast_all(series_by_vid, vids, h):
    """Forecast every variant with its method, falling back to the moving average on failure."""
    plans = {}
    for v in vids:
        plans.setdefault(classify(series_by_vid[v]), []).append(v)
    result = {}
    for model_name in ("AutoETS", "CrostonSBA"):
        group = plans.get(model_name, [])
        if not group:
            continue
        try:
            fc = sf_forecast(series_by_vid, group, model_name, h, with_level=(model_name == "AutoETS"))
            for v, (y, lo, hi) in fc.items():
                if lo is None or hi is None:
                    lo, hi = band_from_history(y, series_by_vid[v])
                result[v] = (model_name, y, lo, hi)
        except Exception as e:
            print(f"  {model_name} batch failed ({e}); moving average instead")
            plans.setdefault("SMA", []).extend(group)
    for v in plans.get("SMA", []):
        y = sma(series_by_vid[v], h)
        lo, hi = band_from_history(y, series_by_vid[v])
        result[v] = ("SMA", y, lo, hi)
    return result


def backtest(series_by_vid, vids):
    """Re-forecast the last 4 weeks from the history before them; accuracy = 1 - weekly WAPE.

    Errors are measured on weekly totals, not single days: reorders cover weeks
    of demand, and for a product selling one or two a day, a sale landing on
    Tuesday instead of Monday is not a forecast miss. Day-level scoring counted
    every such shift twice and put most slow sellers near 0%.
    """
    eligible = [v for v in vids if len(series_by_vid[v]) >= BACKTEST_DAYS + 28]
    if not eligible:
        return {}
    train = {v: series_by_vid[v].iloc[:-BACKTEST_DAYS] for v in eligible}
    actual = {v: series_by_vid[v].iloc[-BACKTEST_DAYS:].to_numpy(dtype=float) for v in eligible}
    try:
        fc = forecast_all(train, eligible, BACKTEST_DAYS)
    except Exception as e:
        print(f"  backtest failed ({e})")
        return {}
    acc = {}
    for v in eligible:
        a = actual[v]
        if a.sum() <= 0:
            continue
        weeks = BACKTEST_DAYS // 7
        a_w = a[: weeks * 7].reshape(weeks, 7).sum(axis=1)
        f_w = np.asarray(fc[v][1], dtype=float)[: weeks * 7].reshape(weeks, 7).sum(axis=1)
        wape = float(np.abs(a_w - f_w).sum() / max(a_w.sum(), 1e-9))
        acc[v] = max(0.0, 1.0 - wape)
    return acc


def apply_promotions(y, lo, hi, start, promos, vendor, product_type):
    y, lo, hi = y.copy(), lo.copy(), hi.copy()
    for p in promos:
        if p["scope"] == "vendor" and p["scope_value"] != vendor:
            continue
        if p["scope"] == "product_type" and p["scope_value"] != product_type:
            continue
        f = 1 + float(p["uplift_pct"]) / 100
        for i in range(len(y)):
            d = start + timedelta(days=i)
            if p["starts_on"] <= d <= p["ends_on"]:
                y[i] *= f; lo[i] *= f; hi[i] *= f
    return y, lo, hi


# ---------------------------------------------------------------- inventory maths

def extend(y, n):
    """Daily demand for n days: the forecast, then its last 4 weeks' average."""
    if n <= len(y):
        return y[:n]
    tail = float(np.mean(y[-28:])) if len(y) else 0.0
    return np.concatenate([y, np.full(n - len(y), tail)])


def walk_cover(daily, on_hand, arrivals, start, lead_time):
    """Days until stock reaches zero, with on-order stock landing on its expected date."""
    stock = float(max(on_hand, 0))
    if stock <= 0 and not arrivals:
        return 0.0
    landing = {}
    for exp, q in arrivals:
        d = exp if exp is not None else start + timedelta(days=lead_time)
        idx = max((d - start).days, 0)
        landing[idx] = landing.get(idx, 0) + q
    for i, u in enumerate(daily):
        stock += landing.get(i, 0)
        if u >= stock:
            return round(i + (stock / u if u > 0 else 0), 1)
        stock -= u
    tail = float(np.mean(daily[-28:])) if len(daily) else 0.0
    return round(len(daily) + stock / tail, 1) if tail > 0.001 else None


def compute(v, model, y, lo, hi, series, acc, settings, arrivals, run_date):
    tracked = bool(v["track_inventory"])
    on_hand = int(v["current_stock"] or 0)
    on_order = int(v["on_order"] or 0)
    lt = int(v["lead_time_days"] or settings["default_lead_time_days"])
    cov = settings["coverage_days"]
    case_pack = max(int(v["case_pack"] or 1), 1)
    moq = int(v["min_order_qty"] or 0)
    price = float(v["price"]) if v["price"] is not None else None
    avg = float(np.mean(y)) if len(y) else 0.0

    hist = series if series is not None else pd.Series(dtype=float)
    rate14 = float(hist.tail(14).mean()) if len(hist) else 0.0
    sd = float(hist.tail(90).std(ddof=1)) if len(hist) > 2 else 0.0
    sd = 0.0 if math.isnan(sd) else sd

    need = extend(y, lt + cov + 1)
    lead_demand = float(need[:lt].sum())
    cover_demand = float(need[lt:lt + cov].sum())
    d = lead_demand / lt if lt else 0.0
    z = NormalDist().inv_cdf(min(max(settings["service_level"], 0.5), 0.999))
    ss_stat = z * math.sqrt(lt * sd ** 2 + d ** 2 * float(v["lead_time_stddev"] or 0) ** 2)
    safety = max(ss_stat, float(v["min_safety"] or 0))
    reorder_point = int(math.ceil(lead_demand + safety))
    short = lead_demand + cover_demand + safety - max(on_hand, 0) - on_order
    qty = int(math.ceil(short - 1e-9)) if short > 0 else 0
    if qty > 0:
        qty = max(qty, moq)
        if case_pack > 1:
            qty = int(math.ceil(qty / case_pack) * case_pack)

    if acc is None:
        confidence = "low"
    else:
        confidence = "high" if acc >= 0.7 and len(hist) >= 120 else "medium" if acc >= 0.45 else "low"
    if model == "SMA" and len(hist) < MIN_HISTORY_DAYS:
        confidence = "low"

    base = dict(lead_time_days=lt, coverage_days=cov, on_order=on_order, rate_14d=round(rate14, 3),
                safety_stock=round(safety, 1), confidence=confidence,
                accuracy=round(acc, 4) if acc is not None else None)

    if not tracked:
        return dict(base, status="untracked", risk_level="untracked", days_of_stock=None, stockout_date=None,
                    reorder_point=reorder_point, reorder_qty=int(math.ceil(lead_demand + cover_demand + safety)),
                    revenue_at_risk=0.0, avg=avg)
    if not v["ever_sold"]:
        return dict(base, status="no_sales", risk_level="no_demand", days_of_stock=None, stockout_date=None,
                    reorder_point=0, reorder_qty=0, revenue_at_risk=0.0, avg=0.0, confidence=None, accuracy=None)
    if avg <= 0.01:
        return dict(base, status="overstocked" if on_hand > 0 else "healthy", risk_level="no_demand",
                    days_of_stock=None, stockout_date=None, reorder_point=reorder_point, reorder_qty=0,
                    revenue_at_risk=0.0, avg=avg)

    horizon = extend(y, max(HORIZON_DAYS, lt + cov))
    cover = walk_cover(horizon, on_hand, arrivals, run_date, lt)
    stockout = run_date + timedelta(days=int(cover)) if cover is not None and cover < 3650 else None

    if (max(on_hand, 0) + on_order) <= reorder_point or (cover is not None and cover <= lt):
        status = "reorder_now"
    elif cover is not None and cover <= lt + 28:
        status = "watch"
    elif cover is None or cover > settings["overstock_days"]:
        status = "overstocked"
    else:
        status = "healthy"

    if status == "reorder_now":
        legacy = "critical" if cover is not None and cover <= lt else "low_stock"
    elif status == "overstocked":
        legacy = "overstocked"
    else:
        legacy = "healthy"

    # Sales lost over the next 8 weeks if nothing more is ordered.
    total = float(y[:HORIZON_DAYS].sum())
    landed = sum(q for exp, q in arrivals if exp is None or (exp - run_date).days < HORIZON_DAYS)
    lost = max(total - max(on_hand, 0) - landed, 0.0)
    revenue_at_risk = round(lost * price, 2) if price else 0.0

    return dict(base, status=status, risk_level=legacy, days_of_stock=cover, stockout_date=stockout,
                reorder_point=reorder_point, reorder_qty=qty, revenue_at_risk=revenue_at_risk, avg=avg)


# ---------------------------------------------------------------- store run

def run_store(conn, store_id):
    settings = load_settings(conn, store_id)
    history = load_history(conn, store_id)
    variants = load_variants(conn, store_id)
    if not variants:
        print(f"store {store_id}: no products, skipping")
        return
    arrivals = load_arrivals(conn, store_id)
    promos = load_promotions(conn, store_id)
    run_date = date.today()

    with_history = [v for v in variants if v in history]
    fc = forecast_all(history, with_history, HORIZON_DAYS) if with_history else {}
    acc = backtest(history, with_history) if with_history else {}

    fc_rows, risk_rows = [], []
    for vid, v in variants.items():
        if vid in fc:
            model, y, lo, hi = fc[vid]
        else:
            model, y, lo, hi = "none", np.zeros(HORIZON_DAYS), np.zeros(HORIZON_DAYS), np.zeros(HORIZON_DAYS)
        if promos and model != "none":
            y, lo, hi = apply_promotions(y, lo, hi, run_date, promos, v["vendor"], v["product_type"])
        r = compute(v, model, y, lo, hi, history.get(vid), acc.get(vid), settings, arrivals.get(vid, []), run_date)
        days = [{"d": (run_date + timedelta(days=i)).isoformat(), "y": round(float(y[i]), 3),
                 "lo": round(float(lo[i]), 3), "hi": round(float(hi[i]), 3)} for i in range(HORIZON_DAYS)]
        if model != "none":
            fc_rows.append((store_id, vid, run_date, model, HORIZON_DAYS, json.dumps(days), round(r["avg"], 3)))
        risk_rows.append((
            store_id, vid, run_date, int(v["current_stock"] or 0), r["days_of_stock"], r["stockout_date"],
            r["reorder_point"], r["reorder_qty"], r["revenue_at_risk"], r["risk_level"], r["status"],
            r["safety_stock"], r["lead_time_days"], r["coverage_days"], r["on_order"], r["rate_14d"],
            r["confidence"], r["accuracy"], v["supplier_id"], v["cost"],
        ))

    # numpy scalars (np.float64 etc.) are not SQL values: turn them into plain Python numbers.
    plain = lambda row: tuple(x.item() if isinstance(x, np.generic) else x for x in row)
    fc_rows = [plain(r) for r in fc_rows]
    risk_rows = [plain(r) for r in risk_rows]

    with conn.cursor() as cur:
        cur.execute("DELETE FROM stock_risk WHERE store_id = %s AND run_date = %s", (store_id, run_date))
        cur.execute("DELETE FROM forecasts WHERE store_id = %s AND run_date = %s", (store_id, run_date))
        if fc_rows:
            psycopg2.extras.execute_values(cur, """
                INSERT INTO forecasts (store_id, variant_id, run_date, model_used, horizon_days, daily_forecast, avg_daily_demand)
                VALUES %s""", fc_rows)
        psycopg2.extras.execute_values(cur, """
            INSERT INTO stock_risk (store_id, variant_id, run_date, current_stock, days_of_stock, stockout_date,
                reorder_point, reorder_qty, revenue_at_risk, risk_level, status, safety_stock, lead_time_days,
                coverage_days, on_order, rate_14d, confidence, accuracy, supplier_id, unit_cost)
            VALUES %s""", risk_rows)
        # Effective lead time back on the variant, for the app's settings screen.
        psycopg2.extras.execute_values(cur, """
            UPDATE variants AS v SET lead_time_days = x.lt FROM (VALUES %s) AS x(id, lt)
             WHERE v.id = x.id AND v.lead_time_days IS DISTINCT FROM x.lt""",
                                       [(r[1], r[12]) for r in risk_rows])
        cur.execute("UPDATE stores SET forecasted_at = now() WHERE id = %s", (store_id,))
    conn.commit()
    counts = {}
    for r in risk_rows:
        counts[r[10]] = counts.get(r[10], 0) + 1
    print(f"store {store_id}: {len(risk_rows)} variants, {len(fc_rows)} forecast, {len(acc)} backtested; {counts}")


def scheduled_store_ids(conn, today):
    """Nightly for Scale and Pro, Mondays for Launch (guide chapter 1)."""
    rows = dict_rows(conn, "SELECT id, plan FROM stores WHERE sync_status = 'ready' AND uninstalled_at IS NULL")
    return [int(r["id"]) for r in rows if r["plan"] != "launch" or today.weekday() == 0]


def run_all(conn, scheduled=False):
    if scheduled:
        store_ids = scheduled_store_ids(conn, datetime.now(timezone.utc).date())
    else:
        store_ids = [int(r["id"]) for r in dict_rows(conn, "SELECT id FROM stores WHERE sync_status = 'ready' AND uninstalled_at IS NULL")]
    for sid in store_ids:
        try:
            run_store(conn, sid)
        except Exception:
            conn.rollback()
            print(f"store {sid}: forecast failed\n{traceback.format_exc()}")


def run_queued(conn):
    store_ids = [int(r["store_id"]) for r in dict_rows(conn, """
        SELECT DISTINCT j.store_id FROM sync_jobs j JOIN stores s ON s.id = j.store_id
         WHERE j.job_type = 'forecast' AND j.status = 'queued' AND s.sync_status = 'ready' AND s.uninstalled_at IS NULL""")]
    for sid in store_ids:
        with conn.cursor() as cur:
            cur.execute("""UPDATE sync_jobs SET status = 'running', started_at = now()
                            WHERE store_id = %s AND job_type = 'forecast' AND status = 'queued' RETURNING id""", (sid,))
            job_ids = [r[0] for r in cur.fetchall()]
        conn.commit()
        if not job_ids:
            continue
        try:
            run_store(conn, sid)
            status, err = "done", None
        except Exception as e:
            conn.rollback()
            status, err = "error", str(e)[:500]
            print(f"store {sid}: queued forecast failed\n{traceback.format_exc()}")
        with conn.cursor() as cur:
            cur.execute("UPDATE sync_jobs SET status = %s, finished_at = now(), error = %s WHERE id = ANY(%s)",
                        (status, err, job_ids))
        conn.commit()
    return len(store_ids)


def run_loop():
    conn = get_conn()
    print("[worker] initial forecast run")
    run_all(conn)
    last_nightly = datetime.now(timezone.utc).date()
    while True:
        try:
            if conn.closed:
                conn = get_conn()
            now = datetime.now(timezone.utc)
            if now.hour == NIGHTLY_HOUR_UTC and now.date() != last_nightly:
                print(f"[worker] scheduled forecast run {now.isoformat()}")
                run_all(conn, scheduled=True)
                last_nightly = now.date()
            n = run_queued(conn)
            if n:
                print(f"[worker] ran queued forecasts for {n} store(s)")
        except Exception:
            print(f"[worker] loop iteration failed\n{traceback.format_exc()}")
            try:
                conn.close()
            except Exception:
                pass
        time.sleep(QUEUE_POLL_SECONDS)


def main():
    if "--loop" in sys.argv:
        run_loop()
        return
    conn = get_conn()
    try:
        if "--queued" in sys.argv:
            run_queued(conn)
        else:
            run_all(conn)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
