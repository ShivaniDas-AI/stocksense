import React, { useEffect, useState } from "react";
import { ScrollView, Text, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api } from "../api/client";
import type { VariantDetail } from "../api/types";
import { Button, Card, KpiTile, Notice, RiskBadge, Row, SectionTitle, StatusView, Stepper, Thumb } from "../components/ui";
import { ProductSkeleton } from "../components/Skeleton";
import { LineChart } from "../components/LineChart";
import { fw, radius, riskMeta, space, tone, ToneName, type, useTheme } from "../theme";
import { addDays, dateLabel, daysUntil, money, num, rate } from "../utils/format";
import type { RootStackParamList } from "../navigation";
import { haptic } from "../utils/haptics";

type Props = NativeStackScreenProps<RootStackParamList, "Product">;

function toDate(s: string): Date {
  const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Turn the risk row into one plain-language instruction. */
function recommendation(d: VariantDetail, currency: string): { tone: ToneName; icon: React.ComponentProps<typeof Ionicons>["name"]; title: string; body: string } {
  const r = d.risk;
  const v = d.variant;
  if (!r) return { tone: "neutral", icon: "time-outline", title: "Waiting for the first forecast", body: "The nightly run will add a recommendation." };
  const qty = num(r.reorder_qty ?? 0);
  switch (r.risk_level) {
    case "critical": {
      const orderBy = r.stockout_date ? addDays(r.stockout_date, -v.lead_time_days) : null;
      const late = orderBy ? daysUntil(orderBy) < 0 : false;
      const out = r.stockout_date ? daysUntil(r.stockout_date) : null;
      return {
        tone: "danger", icon: "alert-circle",
        title: late ? `Order ${qty} units today` : `Order ${qty} units by ${dateLabel(orderBy)}`,
        body: `${out != null ? `Stock runs out in ${out} day${out === 1 ? "" : "s"} (${dateLabel(r.stockout_date)})` : "Stock is about to run out"} and delivery takes ${v.lead_time_days} days, so some stockout is ${late ? "now unavoidable; order to shorten it" : "avoidable only if you order now"}.${Number(r.revenue_at_risk) > 0 ? ` About ${money(r.revenue_at_risk, currency)} of sales are at risk.` : ""}`,
      };
    }
    case "low_stock":
      return { tone: "warning", icon: "cart-outline", title: `Reorder ${qty} units soon`, body: `Stock is at or below the reorder point of ${num(r.reorder_point)} units. Ordering now keeps cover through the ${v.lead_time_days}-day lead time.` };
    case "overstocked":
      return { tone: "info", icon: "pause-circle-outline", title: "Hold purchasing", body: `${r.days_of_stock != null ? Math.round(Number(r.days_of_stock)) : "Over 120"} days of cover on hand. Consider a promotion to move stock before it ties up cash.` };
    case "no_demand":
      return { tone: "neutral", icon: "remove-circle-outline", title: "No action", body: "No forecast demand for this product. It will not run out at the current rate." };
    case "untracked":
      return { tone: "accent", icon: "eye-off-outline", title: "Turn on inventory tracking", body: `Demand is about ${rate(d.forecast?.avg_daily_demand)} units a day. Once stock is tracked in your store, StockSense can give a stockout date and risk level.` };
    default: {
      const review = r.days_of_stock != null ? Math.max(0, Math.round(Number(r.days_of_stock) - v.lead_time_days)) : null;
      return { tone: "success", icon: "checkmark-circle", title: "No action needed", body: review != null ? `Enough stock for ${Math.round(Number(r.days_of_stock))} days. Review again in about ${review} day${review === 1 ? "" : "s"}, before the ${v.lead_time_days}-day lead time starts to matter.` : "Enough stock for the lead time." };
    }
  }
}

export function ProductScreen({ route }: Props) {
  const { id } = route.params;
  const t = useTheme();
  const qc = useQueryClient();
  const { width } = useWindowDimensions();
  const detail = useQuery({ queryKey: ["variant", id], queryFn: () => api.variant(id) });
  const store = useQuery({ queryKey: ["store"], queryFn: api.store });
  const currency = store.data?.currency || "USD";

  const [lead, setLead] = useState(14);
  const [safety, setSafety] = useState(0);
  useEffect(() => {
    if (detail.data) {
      setLead(detail.data.variant.lead_time_days);
      setSafety(detail.data.variant.safety_stock);
    }
  }, [detail.data]);

  const save = useMutation({
    mutationFn: () => api.updateVariant(id, { lead_time_days: Math.max(1, lead), safety_stock: Math.max(0, safety) }),
    onSuccess: () => {
      haptic.success();
      qc.invalidateQueries({ queryKey: ["variant", id] });
      qc.invalidateQueries({ queryKey: ["risks"] });
    },
    onError: () => haptic.warning(),
  });

  if (detail.isPending) return <View style={{ flex: 1, backgroundColor: t.bg }}><ProductSkeleton /></View>;
  if (detail.isError || !detail.data)
    return <StatusView icon="alert-circle-outline" toneName="danger" title="Could not load product" body={(detail.error as Error)?.message} />;

  const { variant, history, forecast, risk } = detail.data;
  const untracked = risk?.risk_level === "untracked" || !variant.track_inventory;
  const fcPoints = forecast
    ? ((typeof forecast.daily_forecast === "string" ? JSON.parse(forecast.daily_forecast) : forecast.daily_forecast) as { d: string; y: number }[])
    : [];
  const dirty = lead !== variant.lead_time_days || safety !== variant.safety_stock;
  const meta = risk ? riskMeta[risk.risk_level] : null;
  const rec = recommendation(detail.data, currency);
  const recTone = tone(t, rec.tone);
  const next30 = fcPoints.slice(0, 30).reduce((a, p) => a + Number(p.y), 0);
  const last30 = history.slice(-30).reduce((a, h) => a + Number(h.units_sold), 0);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
      {/* Header */}
      <View style={{ flexDirection: "row" }}>
        <Thumb uri={variant.image_url} size={72} />
        <View style={{ flex: 1, marginLeft: space.md }}>
          <Text style={[type.title, { color: t.text }]}>{variant.title || variant.product_title}</Text>
          <Text style={[type.caption, { color: t.textMuted, marginTop: 2 }]}>
            {variant.sku ? `SKU ${variant.sku}` : "No SKU"}{variant.price ? ` · ${money(variant.price, currency)}` : ""}
          </Text>
          {risk ? (
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8 }}>
              <RiskBadge level={risk.risk_level} size="md" />
              {meta ? <Text style={[type.caption, { color: t.textSecondary, marginLeft: 10, flex: 1 }]}>{meta.hint}</Text> : null}
            </View>
          ) : null}
        </View>
      </View>

      {/* Recommendation */}
      <Card style={{ marginTop: space.lg, borderColor: recTone.fg, borderWidth: 1, backgroundColor: t.surface }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: recTone.bg, alignItems: "center", justifyContent: "center", marginRight: space.md }}>
            <Ionicons name={rec.icon} size={21} color={recTone.fg} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[type.label, { color: recTone.fg }]}>Recommended action</Text>
            <Text style={[type.heading, { color: t.text, marginTop: 2 }]}>{rec.title}</Text>
            <Text style={[type.caption, { color: t.textSecondary, marginTop: 4 }]}>{rec.body}</Text>
          </View>
        </View>
      </Card>

      {untracked ? (
        <View style={{ marginTop: space.md }}>
          <Notice icon="eye-off-outline" toneName="accent" title="Stock not tracked in your store">
            Demand is forecast, but stock, days of cover and stockout date are unknown until inventory tracking is turned on.
          </Notice>
        </View>
      ) : null}

      <SectionTitle>Status</SectionTitle>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        <KpiTile label="On hand" icon="cube-outline" toneName="info" value={untracked ? "—" : num(risk?.current_stock ?? variant.current_stock)} sub="units in stock" />
        <KpiTile label="Days of cover" icon="hourglass-outline" toneName={risk?.risk_level === "critical" ? "danger" : "neutral"} value={risk?.days_of_stock != null ? `${Math.round(Number(risk.days_of_stock))} d` : "—"} sub={`lead time ${variant.lead_time_days} d`} />
        <KpiTile label="Stockout" icon="time-outline" toneName={risk?.stockout_date ? "warning" : "neutral"} value={dateLabel(risk?.stockout_date)} sub={risk?.stockout_date ? `in ${daysUntil(risk.stockout_date)} days` : "none projected"} />
        <KpiTile label="Reorder" icon="cart-outline" toneName="primary" value={`${num(risk?.reorder_qty ?? 0)}`} sub={`units · point ${num(risk?.reorder_point)}`} />
      </View>

      <SectionTitle>Demand</SectionTitle>
      <Card>
        <View style={{ flexDirection: "row", marginBottom: space.md }}>
          <Mini label="Sold, last 30 d" value={num(last30)} />
          <Mini label="Expected, next 30 d" value={num(Math.round(next30))} />
          <Mini label="Avg / day" value={forecast ? rate(forecast.avg_daily_demand) : "—"} />
        </View>
        <LineChart
          width={width - space.lg * 2 - space.lg * 2}
          history={history.map((h) => ({ x: toDate(h.sale_date), y: Number(h.units_sold) }))}
          forecast={fcPoints.map((f) => ({ x: toDate(f.d), y: Number(f.y) }))}
        />
        <View style={{ flexDirection: "row", gap: 16, marginTop: 8 }}>
          <Legend color={t.chartHistory} label="Sales, last 90 days" />
          <Legend color={t.chartForecast} label="Forecast, 8 weeks" />
        </View>
        <View style={{ marginTop: space.md, borderTopWidth: 1, borderTopColor: t.border }}>
          <Row icon="pulse-outline" toneName="primary" title={forecast ? `Model: ${forecast.model_used}` : "No forecast yet"} subtitle={forecast ? `${forecast.model_used === "SMA" ? "28-day moving average, used while history is short" : forecast.model_used === "CrostonSBA" ? "Croston SBA, built for items that sell in bursts" : "AutoETS with weekly seasonality"} · run ${dateLabel(forecast.run_date)}` : "The nightly run will add one"} last />
        </View>
      </Card>

      <SectionTitle>Reorder settings</SectionTitle>
      <Card>
        <View style={{ flexDirection: "row", gap: space.md }}>
          <Stepper label="Lead time" value={lead} onChange={setLead} min={1} unit="days from order to delivery" />
          <Stepper label="Safety stock" value={safety} onChange={setSafety} min={0} unit="units kept as buffer" />
        </View>
        <View style={{ marginTop: space.lg }}>
          <Button title={save.isSuccess && !dirty ? "Saved" : "Save settings"} icon={save.isSuccess && !dirty ? "checkmark" : undefined} onPress={() => save.mutate()} loading={save.isPending} disabled={!dirty} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: space.sm }}>
          <Ionicons name="information-circle-outline" size={14} color={t.textMuted} style={{ marginRight: 6 }} />
          <Text style={[type.caption, { color: t.textMuted, flex: 1 }]}>Reorder point = demand during lead time + safety stock. Risk levels update on the next forecast run.</Text>
        </View>
      </Card>
    </ScrollView>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1 }}>
      <Text style={[type.label, { color: t.textMuted }]} numberOfLines={1}>{label}</Text>
      <Text style={[fw(700), { color: t.text, fontSize: 17, marginTop: 2 }]}>{value}</Text>
    </View>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <View style={{ width: 10, height: 3, borderRadius: 2, backgroundColor: color, marginRight: 6 }} />
      <Text style={[type.caption, { color: t.textSecondary }]}>{label}</Text>
    </View>
  );
}
