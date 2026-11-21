import React, { useState } from "react";
import { LayoutChangeEvent, Pressable, Text, View } from "react-native";
import Svg, { G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { fw, type, useTheme } from "../theme";
import type { WeekPoint } from "../api/types";

/**
 * Charts drawn with react-native-svg (bundled in Expo Go, works on web too).
 * Each chart measures its own width with onLayout, so it fits a phone, a
 * tablet or a desktop browser without guessing from the window size.
 */

/** Measures the available width, then renders the chart at that width. */
export function ChartFrame({ height, children }: { height: number; children: (width: number) => React.ReactNode }) {
  const [w, setW] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => {
    const next = Math.floor(e.nativeEvent.layout.width);
    if (next > 0 && Math.abs(next - w) > 1) setW(next);
  };
  return (
    <View onLayout={onLayout} style={{ width: "100%", height }}>
      {w > 0 ? children(w) : null}
    </View>
  );
}

export function Legend({ items }: { items: { color: string; label: string; dashed?: boolean; area?: boolean }[] }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 6, marginTop: 10 }}>
      {items.map((i) => (
        <View key={i.label} style={{ flexDirection: "row", alignItems: "center" }}>
          {i.area ? (
            <View style={{ width: 12, height: 10, borderRadius: 2, backgroundColor: i.color, opacity: 0.25, marginRight: 6 }} />
          ) : (
            <View style={{ width: 14, height: 3, borderRadius: 2, backgroundColor: i.color, opacity: i.dashed ? 0.6 : 1, marginRight: 6 }} />
          )}
          <Text style={[type.caption, { color: t.textSecondary }]}>{i.label}</Text>
        </View>
      ))}
    </View>
  );
}

const finite = (n: unknown) => (typeof n === "number" ? n : Number(n));
const ok = (n: number) => Number.isFinite(n);

function parseDay(s: string): number {
  const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
}
const shortDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** Round an axis maximum up to a friendly number (5, 10, 20, 25, 50 ...). */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
const fmtAxis = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v * 10) / 10));

/**
 * Weekly units: solid bars for weeks already sold, lighter bars for the
 * forecast weeks, with a divider at today.
 */
export function WeeklyBars({ data, height = 200 }: { data: WeekPoint[]; height?: number }) {
  const t = useTheme();
  const points = (data ?? []).map((p) => ({ ts: parseDay(p.week_start), units: finite(p.units), forecast: !!p.forecast })).filter((p) => ok(p.ts) && ok(p.units));
  if (points.length < 2) return <EmptyChart height={height} />;
  return (
    <ChartFrame height={height}>
      {(width) => {
        const pad = { l: 34, r: 6, t: 14, b: 24 };
        const W = width - pad.l - pad.r;
        const H = height - pad.t - pad.b;
        const max = niceMax(Math.max(...points.map((p) => p.units)) * 1.08);
        const slot = W / points.length;
        const barW = Math.max(3, Math.min(26, slot * 0.62));
        const Y = (v: number) => pad.t + H - (H * v) / max;
        const firstFc = points.findIndex((p) => p.forecast);
        const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(W / 64))));
        return (
          <Svg width={width} height={height}>
            {[0, 0.5, 1].map((g) => (
              <G key={g}>
                <Line x1={pad.l} x2={width - pad.r} y1={Y(max * g)} y2={Y(max * g)} stroke={t.chartGrid} strokeWidth={1} />
                <SvgText x={pad.l - 6} y={Y(max * g) + 4} fill={t.textMuted} fontSize={10} fontFamily="Inter_500Medium" textAnchor="end">{fmtAxis(max * g)}</SvgText>
              </G>
            ))}
            {points.map((p, i) => {
              const x = pad.l + slot * i + (slot - barW) / 2;
              const h = Math.max(p.units > 0 ? 2 : 0, (H * p.units) / max);
              return (
                <Rect
                  key={i}
                  x={x}
                  y={pad.t + H - h}
                  width={barW}
                  height={h}
                  rx={Math.min(4, barW / 3)}
                  fill={p.forecast ? t.chartForecast : t.chartHistory}
                  fillOpacity={p.forecast ? 0.35 : 0.9}
                  stroke={p.forecast ? t.chartForecast : "none"}
                  strokeWidth={p.forecast ? 1 : 0}
                />
              );
            })}
            {firstFc > 0 ? (
              <G>
                <Line x1={pad.l + slot * firstFc} x2={pad.l + slot * firstFc} y1={pad.t - 4} y2={pad.t + H} stroke={t.textMuted} strokeDasharray="3,4" strokeWidth={1} />
                <SvgText x={pad.l + slot * firstFc + 4} y={pad.t + 6} fill={t.textMuted} fontSize={10} fontFamily="Inter_500Medium">forecast</SvgText>
              </G>
            ) : null}
            {points.map((p, i) =>
              i % labelEvery === 0 ? (
                <SvgText key={`l${i}`} x={pad.l + slot * i + slot / 2} y={height - 6} fill={t.textMuted} fontSize={10} fontFamily="Inter_500Medium" textAnchor="middle">{shortDate(p.ts)}</SvgText>
              ) : null
            )}
          </Svg>
        );
      }}
    </ChartFrame>
  );
}

/**
 * Stock on hand: the last weeks as a solid line, the projection as a line
 * inside its 80% range, the reorder point, today, and the day an order
 * placed today would arrive.
 */
export function StockChart({
  curve,
  height = 220,
}: {
  curve: {
    history: { date: string; stock: number }[];
    forecast: { date: string; stock: number; low: number; high: number }[];
    markers: { today: string; order_today_lands: string | null; reorder_point: number | null };
  };
  height?: number;
}) {
  const t = useTheme();
  const hist = (curve?.history ?? []).map((p) => ({ ts: parseDay(p.date), y: finite(p.stock) })).filter((p) => ok(p.ts) && ok(p.y));
  const fc = (curve?.forecast ?? [])
    .map((p) => ({ ts: parseDay(p.date), y: finite(p.stock), lo: finite(p.low), hi: finite(p.high) }))
    .filter((p) => ok(p.ts) && ok(p.y));
  if (hist.length + fc.length < 2) return <EmptyChart height={height} />;
  const rop = curve.markers?.reorder_point != null ? finite(curve.markers.reorder_point) : null;
  const lands = curve.markers?.order_today_lands ? parseDay(curve.markers.order_today_lands) : null;
  return (
    <ChartFrame height={height}>
      {(width) => {
        const pad = { l: 34, r: 8, t: 14, b: 24 };
        const W = width - pad.l - pad.r;
        const H = height - pad.t - pad.b;
        const xs = [...hist, ...fc].map((p) => p.ts);
        const x0 = Math.min(...xs);
        const x1 = Math.max(...xs);
        const top = Math.max(1, ...hist.map((p) => p.y), ...fc.map((p) => (ok(p.hi) ? p.hi : p.y)), rop ?? 0);
        const max = niceMax(top * 1.08);
        const X = (ts: number) => pad.l + (W * (ts - x0)) / Math.max(1, x1 - x0);
        const Y = (v: number) => pad.t + H - (H * Math.max(0, v)) / max;
        const line = (pts: { ts: number; y: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.ts).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
        const bandPts = fc.filter((p) => ok(p.lo) && ok(p.hi));
        const band =
          bandPts.length > 1
            ? `M${bandPts.map((p) => `${X(p.ts).toFixed(1)},${Y(p.hi).toFixed(1)}`).join(" L")} L${[...bandPts].reverse().map((p) => `${X(p.ts).toFixed(1)},${Y(p.lo).toFixed(1)}`).join(" L")} Z`
            : "";
        // Join the projection to the last real point so the two lines meet.
        const fcLine = hist.length && fc.length ? [hist[hist.length - 1], ...fc] : fc;
        const todayX = fc.length ? X(fc[0].ts) : null;
        const landsX = lands != null && lands >= x0 && lands <= x1 ? X(lands) : null;
        return (
          <Svg width={width} height={height}>
            {[0, 0.5, 1].map((g) => (
              <G key={g}>
                <Line x1={pad.l} x2={width - pad.r} y1={Y(max * g)} y2={Y(max * g)} stroke={t.chartGrid} strokeWidth={1} />
                <SvgText x={pad.l - 6} y={Y(max * g) + 4} fill={t.textMuted} fontSize={10} fontFamily="Inter_500Medium" textAnchor="end">{fmtAxis(max * g)}</SvgText>
              </G>
            ))}
            {band ? <Path d={band} fill={t.chartForecast} fillOpacity={0.16} /> : null}
            {rop != null && rop > 0 ? (
              <G>
                <Line x1={pad.l} x2={width - pad.r} y1={Y(rop)} y2={Y(rop)} stroke={t.warning} strokeDasharray="5,4" strokeWidth={1.5} />
                <SvgText x={width - pad.r} y={Y(rop) - 5} fill={t.warning} fontSize={10} fontFamily="Inter_500Medium" textAnchor="end">reorder point</SvgText>
              </G>
            ) : null}
            {todayX != null ? (
              <G>
                <Line x1={todayX} x2={todayX} y1={pad.t} y2={pad.t + H} stroke={t.textMuted} strokeDasharray="3,4" strokeWidth={1} />
                <SvgText x={todayX} y={height - 6} fill={t.textMuted} fontSize={10} fontFamily="Inter_500Medium" textAnchor="middle">today</SvgText>
              </G>
            ) : null}
            {landsX != null ? (
              <G>
                <Line x1={landsX} x2={landsX} y1={pad.t} y2={pad.t + H} stroke={t.success} strokeDasharray="2,3" strokeWidth={1.5} />
                <SvgText x={landsX + 4} y={pad.t + 8} fill={t.success} fontSize={10} fontFamily="Inter_500Medium">order lands</SvgText>
              </G>
            ) : null}
            {hist.length > 1 ? <Path d={line(hist)} fill="none" stroke={t.chartHistory} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" /> : null}
            {fcLine.length > 1 ? <Path d={line(fcLine)} fill="none" stroke={t.chartForecast} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" /> : null}
            <SvgText x={pad.l} y={height - 6} fill={t.textMuted} fontSize={10} fontFamily="Inter_500Medium">{shortDate(x0)}</SvgText>
            <SvgText x={width - pad.r} y={height - 6} fill={t.textMuted} fontSize={10} fontFamily="Inter_500Medium" textAnchor="end">{shortDate(x1)}</SvgText>
          </Svg>
        );
      }}
    </ChartFrame>
  );
}

/** Horizontal bars, e.g. days of cover per product. */
export function HBars({ rows, unit, max: maxIn, onPress }: { rows: { label: string; value: number; color: string; note?: string }[]; unit: string; max?: number; onPress?: (index: number) => void }) {
  const t = useTheme();
  const max = maxIn ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <View style={{ gap: 12 }}>
      {rows.map((r, i) => (
        <Pressable key={`${r.label}-${i}`} disabled={!onPress} onPress={() => onPress?.(i)} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 5 }}>
            <Text style={[type.captionStrong, { color: t.text, flex: 1, marginRight: 8 }]} numberOfLines={1}>{r.label}</Text>
            <Text style={[fw(700), { color: r.color, fontSize: 13 }]}>{Math.round(r.value)} {unit}</Text>
          </View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: t.surfaceAlt, overflow: "hidden" }}>
            <View style={{ width: `${Math.max(3, Math.min(100, (r.value / max) * 100))}%`, height: 8, borderRadius: 4, backgroundColor: r.color }} />
          </View>
          {r.note ? <Text style={[type.caption, { color: t.textMuted, marginTop: 3 }]}>{r.note}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

function EmptyChart({ height }: { height: number }) {
  const t = useTheme();
  return (
    <View style={{ height, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: t.surfaceAlt }}>
      <Text style={[type.caption, { color: t.textMuted }]}>Not enough data to chart yet</Text>
    </View>
  );
}

/**
 * Chart from an Ask StockSense answer: line series (actual, forecast, 80%
 * band, reference line) or bars, keyed by date or by name on the x axis.
 */
export function AnswerChart({ chart, height = 200 }: { chart: { type: "line" | "bar"; title: string; series: { name: string; style?: string; points: { x: string; y: number }[] }[] }; height?: number }) {
  const t = useTheme();
  const series = (chart.series ?? []).filter((s) => s.points?.length);
  if (!series.length) return <EmptyChart height={height} />;
  const xs = Array.from(new Set(series.flatMap((s) => s.points.map((p) => String(p.x)))));
  const isDate = xs.every((x) => /^\d{4}-\d{2}-\d{2}/.test(x));
  if (isDate) xs.sort();
  const colorOf = (s: { style?: string }, i: number) =>
    s.style === "forecast" || s.style?.startsWith("band") ? t.chartForecast : s.style === "reference" ? t.warning : i === 0 ? t.chartHistory : t.chartForecast;
  const label = (x: string) => (isDate ? shortDate(parseDay(x)) : x.length > 10 ? `${x.slice(0, 9)}…` : x);

  if (chart.type === "bar") {
    const s = series[0];
    const pts = xs.map((x) => ({ x, y: finite(s.points.find((p) => String(p.x) === x)?.y ?? 0) }));
    return (
      <ChartFrame height={height}>
        {(width) => {
          const pad = { l: 34, r: 6, t: 12, b: 26 };
          const W = width - pad.l - pad.r;
          const H = height - pad.t - pad.b;
          const max = niceMax(Math.max(1, ...pts.map((p) => p.y)) * 1.08);
          const slot = W / pts.length;
          const barW = Math.max(4, Math.min(30, slot * 0.6));
          const every = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor(W / 60))));
          return (
            <Svg width={width} height={height}>
              {[0, 0.5, 1].map((g) => (
                <G key={g}>
                  <Line x1={pad.l} x2={width - pad.r} y1={pad.t + H - H * g} y2={pad.t + H - H * g} stroke={t.chartGrid} strokeWidth={1} />
                  <SvgText x={pad.l - 6} y={pad.t + H - H * g + 4} fill={t.textMuted} fontSize={10} fontFamily="Inter_500Medium" textAnchor="end">{fmtAxis(max * g)}</SvgText>
                </G>
              ))}
              {pts.map((p, i) => {
                const h = (H * p.y) / max;
                return <Rect key={i} x={pad.l + slot * i + (slot - barW) / 2} y={pad.t + H - h} width={barW} height={h} rx={3} fill={colorOf(s, 0)} fillOpacity={0.9} />;
              })}
              {pts.map((p, i) => (i % every === 0 ? <SvgText key={`l${i}`} x={pad.l + slot * i + slot / 2} y={height - 8} fill={t.textMuted} fontSize={10} fontFamily="Inter_500Medium" textAnchor="middle">{label(p.x)}</SvgText> : null))}
            </Svg>
          );
        }}
      </ChartFrame>
    );
  }

  return (
    <ChartFrame height={height}>
      {(width) => {
        const pad = { l: 34, r: 8, t: 12, b: 24 };
        const W = width - pad.l - pad.r;
        const H = height - pad.t - pad.b;
        const max = niceMax(Math.max(1, ...series.flatMap((s) => s.points.map((p) => finite(p.y)).filter(ok))) * 1.08);
        const X = (x: string) => pad.l + (W * xs.indexOf(String(x))) / Math.max(1, xs.length - 1);
        const Y = (v: number) => pad.t + H - (H * Math.max(0, v)) / max;
        const path = (pts: { x: string; y: number }[]) =>
          [...pts].sort((a, b) => xs.indexOf(String(a.x)) - xs.indexOf(String(b.x))).map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(finite(p.y)).toFixed(1)}`).join(" ");
        const lo = series.find((s) => s.style === "band_low");
        const hi = series.find((s) => s.style === "band_high");
        let band = "";
        if (lo && hi) {
          const h = [...hi.points].sort((a, b) => xs.indexOf(String(a.x)) - xs.indexOf(String(b.x)));
          const l = [...lo.points].sort((a, b) => xs.indexOf(String(b.x)) - xs.indexOf(String(a.x)));
          band = `M${h.map((p) => `${X(p.x).toFixed(1)},${Y(finite(p.y)).toFixed(1)}`).join(" L")} L${l.map((p) => `${X(p.x).toFixed(1)},${Y(finite(p.y)).toFixed(1)}`).join(" L")} Z`;
        }
        return (
          <Svg width={width} height={height}>
            {[0, 0.5, 1].map((g) => (
              <G key={g}>
                <Line x1={pad.l} x2={width - pad.r} y1={Y(max * g)} y2={Y(max * g)} stroke={t.chartGrid} strokeWidth={1} />
                <SvgText x={pad.l - 6} y={Y(max * g) + 4} fill={t.textMuted} fontSize={10} fontFamily="Inter_500Medium" textAnchor="end">{fmtAxis(max * g)}</SvgText>
              </G>
            ))}
            {band ? <Path d={band} fill={t.chartForecast} fillOpacity={0.16} /> : null}
            {series.filter((s) => !s.style?.startsWith("band")).map((s, i) => (
              <Path key={s.name} d={path(s.points)} fill="none" stroke={colorOf(s, i)} strokeWidth={s.style === "reference" ? 1.5 : 2.3} strokeDasharray={s.style === "reference" ? "5,4" : undefined} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            <SvgText x={pad.l} y={height - 6} fill={t.textMuted} fontSize={10} fontFamily="Inter_500Medium">{label(xs[0])}</SvgText>
            <SvgText x={width - pad.r} y={height - 6} fill={t.textMuted} fontSize={10} fontFamily="Inter_500Medium" textAnchor="end">{label(xs[xs.length - 1])}</SvgText>
          </Svg>
        );
      }}
    </ChartFrame>
  );
}
