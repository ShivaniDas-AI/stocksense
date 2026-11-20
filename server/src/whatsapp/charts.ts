/**
 * Chart images for WhatsApp: the product card in the assistant shows the
 * projected stock curve as a PNG. WhatsApp fetches images by URL, so the URL
 * carries a short-lived signed token instead of a login.
 */
import crypto from "crypto";
import { Router } from "express";
import { config } from "../config";
import { buildChart, Chart } from "../services/ask";

const TTL_SECONDS = 24 * 3600;

function sign(payload: string) {
  return crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url").slice(0, 32);
}

export function chartUrl(storeId: number, kind: string, variantId?: number) {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = `${storeId}.${kind}.${variantId ?? 0}.${exp}`;
  return `${config.appUrl.replace(/\/+$/, "")}/charts/${payload}.${sign(payload)}.png`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Render a Chart as SVG (light theme, 800x450). */
export function chartSvg(c: Chart): string {
  const W = 800, H = 450, L = 64, R = 24, T = 64, B = 56;
  const xs = Array.from(new Set(c.series.flatMap((s) => s.points.map((p) => p.x)))).sort();
  const ys = c.series.flatMap((s) => s.points.map((p) => p.y));
  const yMax = Math.max(1, ...ys) * 1.1;
  const X = (x: string) => L + ((W - L - R) * Math.max(xs.indexOf(x), 0)) / Math.max(xs.length - 1, 1);
  const Y = (y: number) => T + (H - T - B) * (1 - y / yMax);
  const color: Record<string, string> = { actual: "#64748B", forecast: "#EA580C", band_low: "#FDBA74", band_high: "#FDBA74", reference: "#94A3B8" };
  let body = "";
  for (let i = 0; i <= 4; i++) {
    const v = (yMax * i) / 4;
    body += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#E2E8F0"/><text x="${L - 8}" y="${Y(v) + 4}" font-size="12" text-anchor="end" fill="#64748B">${Math.round(v)}</text>`;
  }
  const lo = c.series.find((s) => s.style === "band_low"), hi = c.series.find((s) => s.style === "band_high");
  if (lo && hi && c.type === "line") {
    const pts = [...hi.points.map((p) => `${X(p.x)},${Y(p.y)}`), ...lo.points.slice().reverse().map((p) => `${X(p.x)},${Y(p.y)}`)];
    body += `<polygon points="${pts.join(" ")}" fill="#FDBA74" fill-opacity="0.35"/>`;
  }
  if (c.type === "bar") {
    const bw = Math.max(4, ((W - L - R) / Math.max(xs.length, 1)) * 0.7);
    for (const s of c.series) for (const p of s.points) {
      body += `<rect x="${X(p.x) - bw / 2}" y="${Y(p.y)}" width="${bw}" height="${H - B - Y(p.y)}" rx="3" fill="${color[s.style ?? "actual"]}"/>`;
    }
  } else {
    for (const s of c.series) {
      if (s.style === "band_low" || s.style === "band_high" || s.points.length < 2) continue;
      body += `<polyline fill="none" stroke="${color[s.style ?? "actual"]}" stroke-width="${s.style === "reference" ? 1.5 : 3}" ${s.style === "reference" ? 'stroke-dasharray="6 5"' : ""} points="${s.points.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")}"/>`;
    }
  }
  for (const m of c.markers ?? []) {
    if (!xs.includes(m.x)) continue;
    body += `<line x1="${X(m.x)}" x2="${X(m.x)}" y1="${T}" y2="${H - B}" stroke="#334155" stroke-dasharray="3 4"/><text x="${X(m.x) + 4}" y="${T + 14}" font-size="12" fill="#334155">${esc(m.label)}</text>`;
  }
  const first = xs[0] ?? "", last = xs[xs.length - 1] ?? "";
  const fmt = (x: string) => (/^\d{4}-\d{2}-\d{2}$/.test(x) ? new Date(x + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : x.slice(0, 14));
  body += `<text x="${L}" y="${H - 20}" font-size="12" fill="#64748B">${esc(fmt(first))}</text><text x="${W - R}" y="${H - 20}" font-size="12" text-anchor="end" fill="#64748B">${esc(fmt(last))}</text>`;
  const legend = c.series.filter((s) => s.style !== "band_high").map((s, i) =>
    `<rect x="${L + i * 170}" y="36" width="12" height="12" rx="2" fill="${color[s.style ?? "actual"]}"/><text x="${L + i * 170 + 18}" y="46" font-size="12" fill="#334155">${esc(s.style === "band_low" ? "80% range" : s.name)}</text>`
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Arial, Helvetica, sans-serif">
<rect width="${W}" height="${H}" fill="#FFFFFF"/>
<text x="${L}" y="24" font-size="16" font-weight="bold" fill="#0F172A">${esc(c.title)}</text>${legend}${body}</svg>`;
}

export async function chartPng(c: Chart): Promise<Buffer> {
  // Loaded lazily: the native renderer is only needed for WhatsApp images.
  const { Resvg } = await import("@resvg/resvg-js");
  return Buffer.from(new Resvg(chartSvg(c), { fitTo: { mode: "width", value: 800 }, font: { loadSystemFonts: true } }).render().asPng());
}

export const chartPngRouter = Router();
chartPngRouter.get("/:token.png", (req, res) => {
  const parts = String(req.params.token).split(".");
  if (parts.length !== 5) return res.status(404).end();
  const [store, kind, variant, exp, sig] = parts;
  const payload = `${store}.${kind}.${variant}.${exp}`;
  if (sign(payload) !== sig || Number(exp) < Date.now() / 1000) return res.status(404).end();
  buildChart(Number(store), kind, Number(variant) || undefined)
    .then(chartPng)
    .then((png) => {
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "private, max-age=600");
      res.send(png);
    })
    .catch(() => res.status(404).end());
});
