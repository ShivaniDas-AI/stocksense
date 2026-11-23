"""
End-to-end test of the StockSense API (/api/v1) against the local Docker stack.

It creates (or reuses) a demo store "Demo Goods", loads demo data, waits for
forecasts, and exercises every feature in the user guide: forecasts, reorder,
suppliers, purchase orders, alerts, locations, transfers, promotions,
settings, webhooks (signed, delivered to a local receiver), sandbox keys,
plan gating, data & sync, Ask StockSense and the WhatsApp assistant.

Run from the repo root with the stack up and WEBHOOKS_ALLOW_HTTP=true on the
server (docker compose up -d server with that variable set):
    python -I server/test/api_e2e.py
Standard library only. Changes only the demo store.
"""
import hashlib
import hmac
import json
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

BASE = "http://localhost:3000/api/v1"
PHONE = "+919876543210"
RECEIVER_PORT = 8099

passed, failed = 0, 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}  {detail}")


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()


def psql(sql):
    return sh(f'docker exec stocksense-db-1 psql -U stocksense -d stocksense -tA -c "{sql}"')


def call(method, path, token, body=None, raw=False):
    data = json.dumps(body).encode() if isinstance(body, (dict, list)) else (body.encode() if isinstance(body, str) else None)
    req = urllib.request.Request(BASE + path.replace(" ", "%20"), data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            text = r.read().decode()
            return r.status, (text if raw else (json.loads(text) if text else None)), dict(r.headers)
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        try:
            return e.code, json.loads(text), dict(e.headers)
        except Exception:
            return e.code, text, dict(e.headers)


# ---------------------------------------------------------------- webhook receiver

received = []


class Hook(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        received.append({"headers": dict(self.headers), "body": body})
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


def start_receiver():
    srv = HTTPServer(("0.0.0.0", RECEIVER_PORT), Hook)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def wait(pred, timeout=150, step=3):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = pred()
        if v:
            return v
        time.sleep(step)
    return None


# ---------------------------------------------------------------- setup

def setup():
    sid = psql(
        "INSERT INTO stores (platform, store_domain, access_token, sync_status, is_demo, name, plan, currency) "
        "VALUES ('shopify','demo-goods.myshopify.com','demo','ready',true,'Demo Goods','pro','USD') "
        "ON CONFLICT (platform, store_domain) DO UPDATE SET is_demo=true, plan='pro', sync_status='ready', uninstalled_at=NULL RETURNING id"
    ).splitlines()[0]
    session = sh(
        "docker exec stocksense-server-1 node -e \"const jwt=require('jsonwebtoken');require('dotenv').config();"
        f"console.log(jwt.sign({{storeId:{sid},stores:[{sid}]}},process.env.SESSION_SECRET,{{expiresIn:'2h'}}))\""
    )
    return int(sid), session


def main():
    start_receiver()
    sid, S = setup()
    print(f"demo store {sid}")

    # ---------- keys
    st, live, _ = call("POST", "/api-keys", S, {"name": "E2E live"})
    check("create live key (session)", st == 201 and live["data"]["key"].startswith("ss_live_"), st)
    st, sbx, _ = call("POST", "/api-keys", S, {"name": "E2E sandbox", "sandbox": True})
    check("create sandbox key", st == 201 and sbx["data"]["key"].startswith("ss_test_"), st)
    K, T = live["data"]["key"], sbx["data"]["key"]
    st, _, _ = call("POST", "/api-keys", K, {"name": "nope"})
    check("API key cannot manage keys (403)", st == 403, st)

    # ---------- demo data
    st, b, _ = call("GET", "/data/status", K)
    if b["data"]["demo_data_loaded"]:
        call("DELETE", "/data/demo", K)
    st, b, _ = call("POST", "/data/demo", K)
    check("load demo data", st == 201 and b["data"]["variants"] >= 15, (st, b))
    job = b["data"]["forecast_job_id"]
    done = wait(lambda: (lambda r: r[1]["data"]["status"] in ("done", "error") and r[1]["data"])(call("GET", f"/jobs/{job}", K)), 240)
    check("forecast job finishes", done and done["status"] == "done", done)
    st, b, _ = call("POST", "/alerts/check", K)
    check("alert check runs", st == 200, (st, b))

    # ---------- store, plan, dashboard
    st, b, _ = call("GET", "/store", K)
    check("GET /store", st == 200 and b["data"]["name"] == "Demo Goods" and b["data"]["demo"] is True, b)
    st, b, _ = call("GET", "/plan", K)
    check("GET /plan", st == 200 and b["data"]["plan"] == "pro" and "api" in b["data"]["features"], b)
    st, b, _ = call("GET", "/dashboard", K)
    cards = b["data"]["cards"]
    check("dashboard cards", st == 200 and cards["skus_tracked"]["value"] >= 15 and cards["need_reordering"]["value"] >= 1, cards)
    check("dashboard: 12 weeks sold + 4 forecast", len(b["data"]["units_sold_vs_forecast"]) >= 15, len(b["data"]["units_sold_vs_forecast"]))
    check("dashboard: forecast accuracy measured", cards["forecast_accuracy"]["value"] is not None, cards["forecast_accuracy"])

    # ---------- forecasts
    st, b, _ = call("GET", "/forecasts?limit=250", K)
    rows = {r["sku"]: r for r in b["data"]}
    counts = b["counts"]
    check("forecasts list with status counts", st == 200 and len(rows) >= 15 and counts.get("reorder_now", 0) >= 1, counts)
    hoodie = rows.get("MH-BLK-L")
    check("Midnight Hoodie Black/L is reorder_now", hoodie and hoodie["status"] == "reorder_now", hoodie and hoodie["status"])
    check("Gift Card Sleeve is no_sales", rows.get("GCS-1", {}).get("status") == "no_sales", rows.get("GCS-1", {}).get("status"))
    check("Wool Beanie is overstocked", rows.get("WB-CHR", {}).get("status") == "overstocked", rows.get("WB-CHR", {}).get("status"))
    check("suggested qty rounded to case pack of 6", hoodie and hoodie["suggested_quantity"] % 6 == 0 and hoodie["suggested_quantity"] > 0, hoodie and hoodie["suggested_quantity"])
    st, b, _ = call("GET", "/forecasts?status=reorder_now,watch&sort=revenue_at_risk", K)
    check("filter by status", st == 200 and all(r["status"] in ("reorder_now", "watch") for r in b["data"]), [r["status"] for r in b["data"]])
    st, b, _ = call("GET", "/forecasts?q=hoodie", K)
    check("search", st == 200 and b["total"] == 4, b.get("total"))
    st, b, _ = call("GET", "/forecasts?status=urgent", K)
    check("bad status -> 400 with field", st == 400 and b["error"]["field"] == "status", b)
    st, csv, _ = call("GET", "/forecasts.csv", K, raw=True)
    check("CSV export", st == 200 and csv.startswith("variant_id,sku,title") and "MH-BLK-L" in csv, csv[:80])
    hid = hoodie["variant_id"]
    st, b, _ = call("GET", f"/forecasts/{hid}", K)
    d = b["data"]
    check("forecast detail: summary sentence", st == 200 and d["summary"].startswith("Reaches zero in"), d.get("summary"))
    check("forecast detail: 21-day history + 80% band", len(d["stock_curve"]["history"]) == 21 and all(p["low"] <= p["stock"] <= p["high"] for p in d["stock_curve"]["forecast"]), "")
    check("forecast detail: daily series 56 days with range", len(d["daily_forecast"]) == 56 and d["daily_forecast"][0]["high"] >= d["daily_forecast"][0]["units"], "")
    check("forecast detail: stock by 2 locations", len(d["stock_by_location"]) == 2, d["stock_by_location"])

    # locations view
    st, locs, _ = call("GET", "/locations", K)
    retail = next(l for l in locs["data"] if l["name"] == "Retail Store")
    st, b, _ = call("GET", f"/forecasts?location_id={retail['id']}&q=ET-WHT-M", K)
    check("per-location forecast", st == 200 and b["data"][0]["location"]["id"] == retail["id"], b["data"][:1])

    # ---------- reorder
    st, b, _ = call("GET", f"/reorder/{hid}", K)
    p = b["data"]
    check("reorder: 4 suppliers compared", st == 200 and len(p["suppliers"]) == 4, len(p.get("suppliers", [])))
    loom = next(s for s in p["suppliers"] if s["name"] == "Loomcraft Mills")
    north = next(s for s in p["suppliers"] if s["name"] == "Northline Supply")
    check("reorder: Loomcraft tagged current + preferred for category + makes vendor", set(loom["tags"]) >= {"current", "preferred_for_category", "makes_vendor"}, loom["tags"])
    check("reorder: slower supplier needs a bigger order", loom["quantity"] >= north["quantity"], (loom["quantity"], north["quantity"]))
    q = p["quantity"]
    check("reorder: quantity breakdown lines", all(k in q for k in ("sold_during_lead_time", "sold_during_coverage", "safety_stock", "stock_to_have", "short_by")), list(q))
    check("reorder: stockout-before-arrival warning", any(w["code"] == "stockout_before_arrival" for w in p["warnings"]), p["warnings"])
    check("reorder: effect chart with and without order", len(p["effect"]) > 30 and "with_order" in p["effect"][0], "")
    st, b2, _ = call("GET", f"/reorder/{hid}?coverage_days=30", K)
    check("reorder: shorter coverage -> smaller order", b2["data"]["suggested_quantity"] < p["suggested_quantity"], (b2["data"]["suggested_quantity"], p["suggested_quantity"]))
    st, b2, _ = call("GET", f"/reorder/{hid}?supplier_id={north['supplier_id']}", K)
    check("reorder: choosing a supplier recalculates", b2["data"]["supplier_id"] == north["supplier_id"] and b2["data"]["inputs"]["lead_time_days"] == north["lead_time_days"], b2["data"]["inputs"])

    # ---------- suppliers
    st, b, _ = call("GET", "/suppliers", K)
    sups = {s["name"]: s for s in b["data"]}
    check("suppliers listed with 90-day lead times", st == 200 and len(sups) >= 4 and sups["Loomcraft Mills"]["lead_time_90d_days"] is not None, list(sups))
    check("Loomcraft lead time trend slower", sups["Loomcraft Mills"]["lead_time_trend"] == "slower", sups["Loomcraft Mills"]["lead_time_trend"])
    check("Pro scorecard present", "scorecard" in sups["Loomcraft Mills"], "")
    st, b, _ = call("POST", "/suppliers", K, {"name": "Harbor Textiles", "email": "po@harbor.example", "lead_time_days": 9, "vendors": [], "categories": []})
    check("POST /suppliers creates (201)", st == 201 and b["data"]["lead_time_days"] == 9, (st, b))
    harbor = b["data"]["id"]
    st, b, _ = call("POST", "/suppliers", K, {"id": harbor, "lead_time_days": 12})
    check("POST /suppliers with id updates (200)", st == 200 and b["data"]["lead_time_days"] == 12, (st, b))
    st, b, _ = call("POST", "/suppliers", K, {"name": "Bad", "lead_time_days": 0})
    check("lead time 0 -> 400 field lead_time_days", st == 400 and b["error"]["field"] == "lead_time_days", b)
    st, b, _ = call("POST", "/suppliers", K, {"name": "Harbor Textiles", "lead_time_days": 5})
    check("duplicate name -> 400", st == 400 and b["error"]["code"] == "duplicate_name", b)
    st, b, _ = call("GET", f"/suppliers/{sups['Loomcraft Mills']['id']}", K)
    check("supplier detail has lead time history", st == 200 and len(b["data"]["lead_time_history"]) == 5, len(b["data"].get("lead_time_history", [])))
    st, b, _ = call("DELETE", f"/suppliers/{harbor}", K)
    check("delete supplier", st == 200 and b["data"]["deleted"], b)
    st, b, _ = call("GET", "/vendors", K)
    check("vendors listed", st == 200 and any(v["vendor"] == "Loomcraft" for v in b["data"]), "")

    # ---------- sandbox
    st, b, h = call("POST", "/suppliers", T, {"name": "Sandbox Only Co", "lead_time_days": 5})
    check("sandbox write returns 201 + sandbox:true", st == 201 and b.get("sandbox") is True and h.get("X-StockSense-Sandbox") == "true", (st, b))
    st, b, _ = call("GET", "/suppliers?q=Sandbox Only", K)
    check("sandbox write was rolled back", b["total"] == 0, b["total"])

    # ---------- webhooks
    st, b, _ = call("POST", "/webhooks", K, {"url": f"http://host.docker.internal:{RECEIVER_PORT}/hook", "events": ["purchase_order.*", "alert.*"]})
    check("create webhook endpoint (secret shown once)", st == 201 and b["data"]["secret"].startswith("whsec_"), (st, b))
    ep, secret = b["data"]["id"], b["data"]["secret"]
    st, b, _ = call("POST", "/webhooks", K, {"url": "http://example.com/hook"})
    check("non-https public webhook URL rejected", st == 400 and b["error"]["code"] == "invalid_url", b)
    st, b, _ = call("POST", f"/webhooks/{ep}/test", K)
    check("webhook test delivery", st == 200 and b["data"]["delivered"], b)

    # ---------- purchase orders
    st, b, _ = call("POST", "/purchase-orders", K, {"supplier_id": north["supplier_id"], "notes": "E2E", "lines": [{"variant_id": hid, "quantity": 30}, {"variant_id": rows["TC-OLV"]["variant_id"], "quantity": 10}]})
    check("create draft PO", st == 201 and b["data"]["status"] == "draft" and b["data"]["number"].startswith("PO-") and b["data"]["line_count"] == 2, (st, b))
    po = b["data"]["id"]
    st, b, _ = call("PATCH", f"/purchase-orders/{po}", K, {"lines": [{"variant_id": rows["TC-OLV"]["variant_id"], "quantity": 0}, {"variant_id": hid, "quantity": 36}]})
    check("edit draft: change qty, 0 removes line", st == 200 and b["data"]["line_count"] == 1 and b["data"]["lines"][0]["quantity"] == 36, b)
    st, b, _ = call("POST", f"/purchase-orders/{po}", K, {"action": "send"})
    check("send before approve -> 409", st == 409 and b["error"]["code"] == "invalid_transition", b)
    st, b, _ = call("POST", f"/purchase-orders/{po}", K, {"action": "approve"})
    check("approve", st == 200 and b["data"]["status"] == "approved", b)
    st, b, _ = call("PATCH", f"/purchase-orders/{po}", K, {"notes": "x"})
    check("approved PO is locked (409)", st == 409, st)
    st, b, _ = call("POST", f"/purchase-orders/{po}", K, {"action": "send", "email_supplier": True})
    check("send: marked ordered, email reported", st == 200 and b["data"]["status"] == "sent" and "email" in b["data"], b["data"].get("email"))
    stock_before = int(psql(f"SELECT current_stock FROM variants WHERE id={hid}"))
    st, b, _ = call("POST", f"/purchase-orders/{po}", K, {"action": "receive", "lines": [{"variant_id": hid, "quantity": 20}]})
    check("partial receipt", st == 200 and b["data"]["status"] == "partial", b["data"]["status"])
    st, b, _ = call("POST", f"/purchase-orders/{po}", K, {"action": "receive"})
    check("receive the rest -> received", st == 200 and b["data"]["status"] == "received", b["data"]["status"])
    check("stock added (+36)", int(psql(f"SELECT current_stock FROM variants WHERE id={hid}")) == stock_before + 36, "")
    check("supplier lead time recorded", psql(f"SELECT COUNT(*) FROM supplier_receipts WHERE purchase_order_id={po}") == "1", "")
    st, csv, _ = call("GET", f"/purchase-orders/{po}/csv", K, raw=True)
    check("PO CSV", st == 200 and csv.startswith("sku,title,quantity"), csv[:40])
    st, b, _ = call("POST", "/purchase-orders/refresh-drafts", K)
    check("refresh suggested drafts", st == 200 and b["data"]["created"] + b["data"]["updated"] >= 1, b)
    st, b, _ = call("GET", "/purchase-orders?status=draft", K)
    check("automatic drafts listed", st == 200 and any(x["automatic"] for x in b["data"]), [x["number"] for x in b["data"]])

    # webhook deliveries for PO events
    got = wait(lambda: [r for r in received if b"purchase_order.received" in r["body"]], 60, 2)
    check("purchase_order.received webhook delivered", bool(got), [json.loads(r["body"])["type"] for r in received])
    if got:
        r = got[0]
        ts = r["headers"].get("X-StockSense-Timestamp")
        expected = "sha256=" + hmac.new(secret.encode(), f"{ts}.".encode() + r["body"], hashlib.sha256).hexdigest()
        check("webhook signature verifies", r["headers"].get("X-StockSense-Signature") == expected, "")
    types = {json.loads(r["body"])["type"] for r in received}
    check("approved and sent events delivered", {"purchase_order.approved", "purchase_order.sent"} <= types, types)

    # ---------- alerts
    st, b, _ = call("GET", "/alerts?status=open&limit=100", K)
    atypes = {a["type"] for a in b["data"]}
    check("alerts: stockout_risk open", "stockout_risk" in atypes, atypes)
    check("alerts: velocity_shift for the bottle spike", any(a["type"] == "velocity_shift" and a["product"]["title"].startswith("Insulated Bottle") for a in b["data"]), atypes)
    check("alerts: lead_time_drift for Loomcraft", any(a["type"] == "lead_time_drift" and a["supplier"]["name"] == "Loomcraft Mills" for a in b["data"]), atypes)
    check("alerts sorted urgent then revenue at risk", st == 200 and b["data"][0]["urgent"], "")
    aid = b["data"][0]["id"]
    st, b, _ = call("POST", f"/alerts/{aid}", K, {"action": "dismiss"})
    check("dismiss alert", st == 200 and b["data"]["status"] == "dismissed", b)
    st, b, _ = call("POST", f"/alerts/{aid}", K, {"action": "reopen"})
    check("reopen alert", st == 200 and b["data"]["status"] == "open", b)
    st, b, _ = call("POST", f"/alerts/{aid}", K, {"action": "reopen"})
    check("reopen open alert -> 409", st == 409, st)

    # ---------- transfers
    st, b, _ = call("GET", "/transfers/suggestions", K)
    routes = b["data"]["routes"]
    check("transfer suggestion: warehouse to retail", st == 200 and any(rt["to_location"]["name"] == "Retail Store" for rt in routes), routes)
    if routes:
        rt = next(r for r in routes if r["to_location"]["name"] == "Retail Store")
        ln = rt["lines"][0]
        st, b, _ = call("POST", "/transfers", K, {"from_location_id": rt["from_location"]["id"], "to_location_id": rt["to_location"]["id"], "lines": [{"variant_id": ln["variant_id"], "quantity": ln["quantity"]}]})
        check("create draft transfer", st == 201 and b["data"]["status"] == "draft", b)
        tid = b["data"]["id"]
        before = int(psql(f"SELECT on_hand FROM inventory_levels WHERE variant_id={ln['variant_id']} AND location_id={rt['to_location']['id']}"))
        st, b, _ = call("POST", f"/transfers/{tid}", K, {"action": "receive"})
        after = int(psql(f"SELECT on_hand FROM inventory_levels WHERE variant_id={ln['variant_id']} AND location_id={rt['to_location']['id']}"))
        check("receive transfer moves stock", st == 200 and after == before + ln["quantity"], (before, after))
    st, b, _ = call("PUT", f"/locations/{retail['id']}/inventory", K, {"levels": [{"variant_id": rows["CT-NAT"]["variant_id"], "on_hand": 50}]})
    check("set stock at a location", st == 200 and b["data"]["updated"] == 1, b)

    # ---------- promotions & settings
    st, b, _ = call("POST", "/promotions", K, {"name": "Winter sale", "starts_on": "2026-12-01", "ends_on": "2026-12-07", "uplift_pct": 40, "scope": "vendor", "scope_value": "Loomcraft"})
    check("create promotion (rebuild queued)", st == 201 and b["data"]["rebuild_job_id"] > 0, b)
    prom = b["data"]["promotion"]["id"]
    st, b, _ = call("POST", "/promotions", K, {"name": "x", "starts_on": "2026-12-01", "ends_on": "2026-12-07", "uplift_pct": 10, "scope": "vendor", "scope_value": "Nobody"})
    check("promotion with unknown vendor -> 400", st == 400 and b["error"]["field"] == "scope_value", b)
    call("DELETE", f"/promotions/{prom}", K)
    st, b, _ = call("PATCH", "/settings/forecasting", K, {"service_level": 0.97, "overstock_days": 100})
    check("update forecasting settings", st == 200 and b["data"]["settings"]["service_level"] == 0.97, b)
    st, b, _ = call("PATCH", "/settings/forecasting", K, {"service_level": 2})
    check("invalid service level -> 400", st == 400 and b["error"]["field"] == "service_level", b)
    call("PATCH", "/settings/forecasting", K, {"service_level": 0.95, "overstock_days": 90})
    st, b, _ = call("PATCH", "/settings/notifications", K, {"email_enabled": False, "phone": "+91 98765 43210", "sms_enabled": True})
    check("notification settings normalise phone", st == 200 and b["data"]["phone"] == "919876543210", b)
    st, b, _ = call("POST", "/settings/notifications/test", K)
    res = {r["channel"]: r for r in b["data"]["results"]}
    check("test alert names each channel's problem", st == 200 and res["email"]["status"] == "skipped" and res["sms"]["status"] == "failed" and "TWILIO" in res["sms"]["detail"], res)
    call("PATCH", "/settings/notifications", K, {"sms_enabled": False})

    # ---------- plan gating
    psql(f"UPDATE stores SET plan='launch' WHERE id={sid}")
    st, b, _ = call("GET", "/store", K)
    check("API key on Launch plan -> 402", st == 402 and b["error"]["code"] == "plan_required", b)
    st, b, _ = call("POST", "/purchase-orders", S, {"supplier_id": north["supplier_id"], "lines": [{"variant_id": hid, "quantity": 1}]})
    check("draft PO on Launch -> 402 (session)", st == 402, b)
    psql(f"UPDATE stores SET plan='pro' WHERE id={sid}")

    # ---------- Ask StockSense
    st, b, _ = call("GET", "/ask/usage", K)
    check("ask usage", st == 200 and b["data"]["monthly_limit"] is None, b)
    st, b, _ = call("POST", "/ask", K, {"question": "What should I reorder this week?"})
    ai_on = not (b and isinstance(b, dict) and "error" in b and b["error"]["code"] == "ai_not_configured")
    if not ai_on:
        check("ask without an AI key -> clear 503", st == 503, b)
    else:
        check("ask answers", st == 200 and b["data"]["answer"], (st, b))

    # ---------- WhatsApp assistant (simulated)
    st, b, _ = call("POST", "/whatsapp/link-codes", K)
    code = b["data"]["code"]
    check("link code: 6 digits, 10 minutes", st == 201 and len(code) == 6 and b["data"]["message"] == f"link {code}", b)
    sim = lambda body: call("POST", "/whatsapp/simulate", K, {"from": PHONE, **body})
    st, b, _ = sim({"text": f"link {code}"})
    check("phone links with the code", st == 200 and "now connected" in b["data"]["replies"][0]["text"], b)
    st, b, _ = sim({"text": "hi"})
    check("greeting with main menu (10 items)", st == 200 and len(b["data"]["replies"][-1]["sections"][0]["rows"]) == 10, b["data"]["replies"])
    st, b, _ = sim({"reply_id": "m:reorder"})
    check("reorder list", st == 200 and b["data"]["replies"][0]["type"] == "list", b["data"]["replies"])
    st, b, _ = sim({"reply_id": f"p:{hid}"})
    card = b["data"]["replies"]
    check("product card: chart image + Order/Other/Compare", card[0]["type"] == "image" and [x["title"] for x in card[1]["buttons"]][1:] == ["Other quantity", "Compare suppliers"], card)
    img = urllib.request.urlopen("http://localhost:3000/charts/" + card[0]["url"].split("/charts/", 1)[1], timeout=30)
    png = img.read()
    check("chart PNG renders", img.status == 200 and png[:4] == b"\x89PNG" and len(png) > 5000, len(png))
    st, b, _ = sim({"reply_id": f"c:{hid}"})
    check("compare suppliers list", b["data"]["replies"][0]["type"] == "list" and len(b["data"]["replies"][0]["sections"][0]["rows"]) == 4, "")
    st, b, _ = sim({"reply_id": f"s:{hid}:{north['supplier_id']}"})
    btns = b["data"]["replies"][-1]["buttons"]
    check("supplier card: Order/Other/Make preferred", btns[-1]["title"] == "Make preferred", btns)
    st, b, _ = sim({"reply_id": btns[0]["id"]})
    conf = b["data"]["replies"][0]
    check("order asks for confirmation (30 min)", conf["header"] == "Please confirm" and "Nothing is sent" in conf["text"], conf)
    st, b, _ = sim({"reply_id": conf["buttons"][0]["id"]})
    r0 = b["data"]["replies"][0]
    check("approve creates the draft", r0["text"].startswith("Draft PO-") and r0["buttons"][0]["title"].startswith("Open PO-"), r0)
    st, b, _ = sim({"reply_id": r0["buttons"][0]["id"]})
    check("PO card with Approve", b["data"]["replies"][0]["buttons"][0]["title"] == "Approve", b["data"]["replies"])
    st, b, _ = sim({"reply_id": b["data"]["replies"][0]["buttons"][0]["id"]})
    st, b, _ = sim({"reply_id": b["data"]["replies"][0]["buttons"][0]["id"]})
    check("PO approved over WhatsApp", "is approved" in b["data"]["replies"][0]["text"], b["data"]["replies"])
    st, b, _ = call("GET", "/whatsapp/activity", K)
    kinds = [(a["title"], a["source"], a["status"]) for a in b["data"][:2]]
    check("activity log: approve + draft, both done", kinds == [("Approve purchase order", "menu", "done"), ("Draft purchase order", "menu", "done")], kinds)
    st, b, _ = call("GET", "/whatsapp/numbers", K)
    num = b["data"][0]
    check("connected number listed, can approve", num["phone"] == PHONE and num["role"] == "can_approve", num)
    call("PATCH", f"/whatsapp/numbers/{num['id']}", K, {"role": "view_only"})
    st, b, _ = sim({"reply_id": f"o:{hid}:{north['supplier_id']}:6"})
    check("view-only number cannot propose changes", "view but not approve" in b["data"]["replies"][0]["text"], b["data"]["replies"])
    st, b, _ = sim({"reply_id": "m:summary"})
    check("view-only can still read the summary", "Today's summary" in b["data"]["replies"][0]["text"], "")
    st, b, _ = sim({"text": "tee"})
    if ai_on:
        check("typed text goes to the AI and gets an answer", b["data"]["replies"][0]["type"] == "text" and len(b["data"]["replies"][0]["text"]) > 20, b["data"]["replies"][0])
    else:
        check("typed text without AI searches products", b["data"]["replies"][0]["type"] in ("list", "image"), b["data"]["replies"][0])
    st, b, _ = call("DELETE", f"/whatsapp/numbers/{num['id']}", K)
    check("disconnect number", st == 200 and b["data"]["disconnected"], b)

    # ---------- errors, limits, docs
    st, b, _ = call("GET", "/nope", K)
    check("unknown route -> 404 envelope", st == 404 and b["error"]["code"] == "route_not_found", b)
    st, b, _ = call("GET", "/purchase-orders/abc", K)
    check("bad id -> 400", st == 400 and b["error"]["code"] == "invalid_id", b)
    st, b, h = call("GET", "/store", K)
    check("rate limit headers + request id", "X-RateLimit-Limit" in h and h.get("X-Request-Id", "").startswith("req_"), h)
    st, b, _ = call("GET", "/openapi.json", K)
    check("OpenAPI spec served", st == 200 and b["openapi"].startswith("3.1"), "")

    call("DELETE", f"/webhooks/{ep}", K)
    print(f"\nRESULT: {passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
