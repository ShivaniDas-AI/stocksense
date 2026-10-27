"""
StockSense — forecast worker.

For every active store:
  1. Load daily sales history per variant (last 365 days).
  2. Pick a model per SKU based on demand pattern:
       - < 60 days history or < 10 sale days  -> simple moving average
       - intermittent demand (many zero days) -> Croston SBA (statsforecast)
       - regular demand                       -> AutoETS (statsforecast)
  3. Forecast 56 days (8 weeks) ahead.
  4. Compute days-of-stock, projected stockout date, reorder point/qty,
     revenue at risk, and a risk level. Variants whose platform does not
     track inventory still get a demand forecast and reorder quantity, but
     their risk level is "untracked" because the stock level is unknown.
  5. Write to `forecasts` and `stock_risk`.

Modes:
  python forecast_worker.py           run every ready store once (cron: 0 2 * * *)
  python forecast_worker.py --queued  run only stores with a queued 'forecast'
                                      job in sync_jobs (the server queues one
                                      when a store's first sync finishes)
  python forecast_worker.py --loop    run all at start, then poll the queue
                                      every 30s and run all nightly at 02:00 UTC
                                      (what the Docker container runs)
Dependencies:  pip install statsforecast pandas numpy psycopg2-binary
"""

import json
import os
import sys
import time
import traceback
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras
from statsforecast import StatsForecast
from statsforecast.models import AutoETS, CrostonSBA

DATABASE_URL = os.environ["DATABASE_URL"]
HORIZON_DAYS = 56          # 8 weeks
HISTORY_DAYS = 365
MIN_HISTORY_DAYS = 60      # below this, use moving average
MIN_SALE_DAYS = 10         # distinct days with sales needed for a stat model
INTERMITTENT_ZERO_RATIO = 0.6  # >60% zero-demand days -> Croston
QUEUE_POLL_SECONDS = 30    # --loop: how often to look for queued forecast jobs
NIGHTLY_HOUR_UTC = 2       # --loop: hour of the daily full run


def get_conn():
    return psycopg2.connect(DATABASE_URL)


def load_history(conn, store_id: int) -> pd.DataFrame:
    """Daily sales per variant, zero-filled for missing days."""
    cutoff = date.today() - timedelta(days=HISTORY_DAYS)
    q = """
        SELECT variant_id, sale_date, units_sold
        FROM daily_sales
        WHERE store_id = %s AND sale_date >= %s
        ORDER BY variant_id, sale_date
    """
    df = pd.read_sql(q, conn, params=(store_id, cutoff))
    if df.empty:
        return df

    # Zero-fill each variant's series from its first sale to yesterday (today is
    # still in progress). A variant whose first sale is today, as in a freshly
    # connected store, keeps that day so it is not skipped as "no history".
    yesterday = date.today() - timedelta(days=1)
    filled = []
    for vid, g in df.groupby("variant_id"):
        end = max(yesterday, pd.Timestamp(g["sale_date"].max()).date())
        idx = pd.date_range(g["sale_date"].min(), end, freq="D")
        s = (
            g.set_index(pd.to_datetime(g["sale_date"]))["units_sold"]
            .reindex(idx, fill_value=0)
        )
        filled.append(
            pd.DataFrame({"unique_id": vid, "ds": idx, "y": s.values})
        )
    return pd.concat(filled, ignore_index=True)


def classify(series: pd.Series) -> str:
    """Decide which model fits this SKU's demand pattern."""
    n_days = len(series)
    sale_days = int((series > 0).sum())
    if n_days < MIN_HISTORY_DAYS or sale_days < MIN_SALE_DAYS:
        return "SMA"
    zero_ratio = float((series == 0).mean())
    if zero_ratio > INTERMITTENT_ZERO_RATIO:
        return "CrostonSBA"
    return "AutoETS"


def forecast_group(df: pd.DataFrame, model_name: str) -> pd.DataFrame:
    """Forecast all series in df with one statsforecast model."""
    model = CrostonSBA() if model_name == "CrostonSBA" else AutoETS(season_length=7)
    sf = StatsForecast(models=[model], freq="D", n_jobs=-1)
    out = sf.forecast(df=df, h=HORIZON_DAYS)
    out.columns = ["unique_id", "ds", "yhat"] if out.index.name is None else out.columns
    out = out.reset_index() if "unique_id" not in out.columns else out
    out = out.rename(columns={model.__class__.__name__: "yhat"})
    out["yhat"] = out["yhat"].clip(lower=0)
    return out[["unique_id", "ds", "yhat"]]


def forecast_sma(series: pd.Series) -> np.ndarray:
    """Fallback: 28-day moving average, flat forecast."""
    window = series.tail(28)
    rate = float(window.mean()) if len(window) else 0.0
    return np.full(HORIZON_DAYS, max(rate, 0.0))


def compute_risk(current_stock, lead_time_days, safety_stock, price, daily_fc, tracked=True):
    """Derive stockout date, reorder point/qty, revenue at risk, risk level."""
    avg_daily = float(np.mean(daily_fc))
    cum = np.cumsum(daily_fc)

    if not tracked:
        # The platform does not track stock for this variant, so days of cover,
        # stockout date and revenue at risk are unknowable. Still give the
        # merchant the demand forecast and a reorder quantity for the horizon.
        lead_demand = float(np.sum(daily_fc[:lead_time_days]))
        return dict(
            days_of_stock=None, stockout_date=None,
            reorder_point=int(np.ceil(lead_demand + safety_stock)),
            reorder_qty=max(int(np.ceil(cum[-1] + safety_stock)), 0),
            revenue_at_risk=0.0, avg_daily=avg_daily, risk="untracked",
        )

    # Negative stock means units are already back-ordered; nothing is on hand.
    on_hand = max(int(current_stock or 0), 0)

    if avg_daily <= 0.01:
        return dict(
            days_of_stock=None, stockout_date=None,
            reorder_point=safety_stock, reorder_qty=0,
            revenue_at_risk=0.0, avg_daily=avg_daily, risk="no_demand",
        )

    # Walk the cumulative forecast to find when stock crosses zero.
    out_idx = np.argmax(cum >= on_hand) if cum[-1] >= on_hand else None
    if out_idx is not None and cum[int(out_idx)] >= on_hand:
        stockout_date = date.today() + timedelta(days=int(out_idx) + 1)
        days_of_stock = float(out_idx) + 1
    else:
        stockout_date = None
        days_of_stock = round(on_hand / avg_daily, 1)

    lead_demand = float(np.sum(daily_fc[:lead_time_days]))
    reorder_point = int(np.ceil(lead_demand + safety_stock))
    # Suggest ordering enough to cover the horizon beyond what's on hand.
    # Back-ordered units (negative stock) must be filled too, so use the raw stock here.
    reorder_qty = max(int(np.ceil(cum[-1] + safety_stock - (current_stock or 0))), 0)

    # Revenue lost between projected stockout and horizon end if nothing is done.
    revenue_at_risk = 0.0
    if stockout_date is not None and price:
        lost_units = float(cum[-1] - on_hand)
        revenue_at_risk = round(max(lost_units, 0.0) * float(price), 2)

    if stockout_date is not None and days_of_stock <= lead_time_days:
        risk = "critical"          # will run out before a reorder can arrive
    elif on_hand <= reorder_point:
        risk = "low_stock"
    elif days_of_stock and days_of_stock > 120:
        risk = "overstocked"
    else:
        risk = "healthy"

    return dict(
        days_of_stock=days_of_stock, stockout_date=stockout_date,
        reorder_point=reorder_point, reorder_qty=reorder_qty,
        revenue_at_risk=revenue_at_risk, avg_daily=avg_daily, risk=risk,
    )


def run_store(conn, store_id: int):
    hist = load_history(conn, store_id)
    if hist.empty:
        print(f"store {store_id}: no history, skipping")
        return

    # Untracked variants are included: they get a demand forecast and the
    # "untracked" risk level instead of being silently skipped.
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """SELECT id, current_stock, lead_time_days, safety_stock, price, track_inventory
               FROM variants WHERE store_id = %s""",
            (store_id,),
        )
        variants = {r["id"]: r for r in cur.fetchall()}

    # Classify each variant's series.
    plans = {}  # model_name -> list of variant_ids
    series_by_vid = {}
    for vid, g in hist.groupby("unique_id"):
        if vid not in variants:
            continue
        s = g.sort_values("ds")["y"]
        series_by_vid[vid] = g.sort_values("ds")
        plans.setdefault(classify(s), []).append(vid)

    run_date = date.today()
    fc_rows, risk_rows = [], []

    def collect(vid, model_name, daily_fc, start):
        v = variants[vid]
        days = [
            {"d": (start + timedelta(days=i)).isoformat(), "y": round(float(y), 3)}
            for i, y in enumerate(daily_fc)
        ]
        r = compute_risk(
            v["current_stock"] or 0, v["lead_time_days"] or 14,
            v["safety_stock"] or 0, v["price"], daily_fc,
            tracked=bool(v["track_inventory"]),
        )
        fc_rows.append((
            store_id, vid, run_date, model_name, HORIZON_DAYS,
            json.dumps(days), round(r["avg_daily"], 3),
        ))
        risk_rows.append((
            store_id, vid, run_date, v["current_stock"] or 0,
            r["days_of_stock"], r["stockout_date"], r["reorder_point"],
            r["reorder_qty"], r["revenue_at_risk"], r["risk"],
        ))

    start = date.today()

    # Statistical models, batched per model type (fast in statsforecast).
    for model_name in ("AutoETS", "CrostonSBA"):
        vids = plans.get(model_name, [])
        if not vids:
            continue
        batch = pd.concat([series_by_vid[v] for v in vids], ignore_index=True)
        try:
            out = forecast_group(batch, model_name)
            for vid, g in out.groupby("unique_id"):
                collect(vid, model_name, g.sort_values("ds")["yhat"].to_numpy(), start)
        except Exception as e:
            print(f"store {store_id}: {model_name} batch failed ({e}), falling back to SMA")
            plans.setdefault("SMA", []).extend(vids)

    # Moving-average fallback.
    for vid in plans.get("SMA", []):
        s = series_by_vid[vid].sort_values("ds")["y"]
        collect(vid, "SMA", forecast_sma(s), start)

    with conn.cursor() as cur:
        cur.execute("DELETE FROM stock_risk WHERE store_id = %s AND run_date = %s", (store_id, run_date))
        cur.execute("DELETE FROM forecasts WHERE store_id = %s AND run_date = %s", (store_id, run_date))
        psycopg2.extras.execute_values(
            cur,
            """INSERT INTO forecasts
               (store_id, variant_id, run_date, model_used, horizon_days, daily_forecast, avg_daily_demand)
               VALUES %s
               ON CONFLICT (variant_id, run_date) DO UPDATE SET
                 model_used = EXCLUDED.model_used,
                 daily_forecast = EXCLUDED.daily_forecast,
                 avg_daily_demand = EXCLUDED.avg_daily_demand""",
            fc_rows,
        )
        psycopg2.extras.execute_values(
            cur,
            """INSERT INTO stock_risk
               (store_id, variant_id, run_date, current_stock, days_of_stock,
                stockout_date, reorder_point, reorder_qty, revenue_at_risk, risk_level)
               VALUES %s
               ON CONFLICT (variant_id, run_date) DO UPDATE SET
                 current_stock = EXCLUDED.current_stock,
                 days_of_stock = EXCLUDED.days_of_stock,
                 stockout_date = EXCLUDED.stockout_date,
                 reorder_point = EXCLUDED.reorder_point,
                 reorder_qty = EXCLUDED.reorder_qty,
                 revenue_at_risk = EXCLUDED.revenue_at_risk,
                 risk_level = EXCLUDED.risk_level""",
            risk_rows,
        )
    conn.commit()
    untracked = sum(1 for r in risk_rows if r[-1] == "untracked")
    print(f"store {store_id}: forecasted {len(fc_rows)} variants ({untracked} untracked)")


def run_all(conn):
    """Forecast every ready store (the nightly job)."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM stores WHERE sync_status = 'ready' AND uninstalled_at IS NULL")
        store_ids = [r[0] for r in cur.fetchall()]
    for sid in store_ids:
        try:
            run_store(conn, sid)
        except Exception:
            conn.rollback()
            print(f"store {sid}: forecast failed\n{traceback.format_exc()}")


def run_queued(conn) -> int:
    """
    Forecast stores that have a queued 'forecast' job in sync_jobs.
    The server queues one when a store's initial sync finishes, so the merchant
    sees a dashboard minutes after connecting instead of after the nightly run.
    Returns the number of stores processed.
    """
    with conn.cursor() as cur:
        cur.execute(
            """SELECT DISTINCT j.store_id
               FROM sync_jobs j
               JOIN stores s ON s.id = j.store_id
               WHERE j.job_type = 'forecast' AND j.status = 'queued'
                 AND s.sync_status = 'ready' AND s.uninstalled_at IS NULL"""
        )
        store_ids = [r[0] for r in cur.fetchall()]

    for sid in store_ids:
        # Claim every queued job for this store at once (reconnecting several
        # times queues several jobs; one run satisfies them all).
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE sync_jobs SET status = 'running', started_at = now()
                   WHERE store_id = %s AND job_type = 'forecast' AND status = 'queued'
                   RETURNING id""",
                (sid,),
            )
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
            cur.execute(
                """UPDATE sync_jobs SET status = %s, finished_at = now(), error = %s
                   WHERE id = ANY(%s)""",
                (status, err, job_ids),
            )
        conn.commit()
    return len(store_ids)


def run_loop():
    """Container entrypoint: full run at start, then queue polling + nightly run."""
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
                print(f"[worker] nightly forecast run {now.isoformat()}")
                run_all(conn)
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
