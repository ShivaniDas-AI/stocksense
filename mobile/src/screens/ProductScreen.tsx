import React, { useEffect, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { Text } from "../components/AppText";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api } from "../api/client";
import type { ForecastDetailV1 } from "../api/types";
import { Button, Card, KpiTile, Notice, Row, SectionTitle, Stat, StatusBadge, StatusView, Stepper, Thumb, notify } from "../components/ui";
import { ProductSkeleton } from "../components/Skeleton";
import { Legend, StockChart, WeeklyBars } from "../components/Charts";
import { fw, radius, space, statusOf, tone, ToneName, type, useTheme } from "../theme";
import { dateLabel, daysUntil, money, num, rate } from "../utils/format";
import type { RootStackParamList } from "../navigation";
import { haptic } from "../utils/haptics";

type Props = NativeStackScreenProps<RootStackParamList, "Product">;
type IconName = React.ComponentProps<typeof Ionicons>["name"];

const MODEL: Record<string, string> = {
  AutoETS: "AutoETS with weekly seasonality",
  CrostonSBA: "Croston SBA, built for items that sell in bursts",
  SMA: "Moving average, used while history is short",
};

/** One plain-language instruction from the status and numbers. */
function recommendation(d: ForecastDetailV1, currency: string): { tone: ToneName; icon: IconName; title: string } {
  const n = d.numbers;
  const qty = num(n.suggested_quantity);
  if ((d.status === "reorder_now" || d.status === "watch") && n.in_draft > 0)
    return { tone: d.status === "reorder_now" ? "danger" : "warning", icon: "document-text-outline", title: `Approve the draft order for ${num(n.in_draft)} units` };
  switch (d.status) {
    case "reorder_now":
      return { tone: "danger", icon: "alert-circle", title: n.suggested_quantity > 0 ? `Order ${qty} units now` : "Reorder now" };
    case "watch":
      return { tone: "warning", icon: "eye-outline", title: n.runs_out_on ? `Plan an order before ${dateLabel(n.runs_out_on)}` : "Keep an eye on this one" };
    case "overstocked":
      return { tone: "info", icon: "pause-circle-outline", title: "Hold purchasing" };
    case "no_sales":
      return { tone: "neutral", icon: "remove-circle-outline", title: "No action: no sales yet" };
    case "untracked":
      return { tone: "accent", icon: "eye-off-outline", title: "Turn on inventory tracking" };
    default:
      return { tone: "success", icon: "checkmark-circle", title: "No action needed" };
  }
}

export function ProductScreen({ route, navigation }: Props) {
  const { id } = route.params;
  const t = useTheme();
  const qc = useQueryClient();
  const fv = useQuery({ queryKey: ["forecastV1", id], queryFn: () => api.forecastV1(id) });
  const store = useQuery({ queryKey: ["store"], queryFn: api.store });
  const currency = store.data?.currency || "USD";

  // Editable ordering rules. Lead time 0 in the stepper means "use the supplier's".
  const [lead, setLead] = useState(0);
  const [safety, setSafety] = useState(0);
  const [casePack, setCasePack] = useState(1);
  const [moq, setMoq] = useState(0);
  const init = (d?: ForecastDetailV1) => {
    if (!d) return;
    setLead(d.ordering.lead_time_override_days ?? 0);
    setSafety(d.ordering.min_safety_stock ?? 0);
    setCasePack(d.ordering.case_pack ?? 1);
    setMoq(d.ordering.min_order_qty ?? 0);
  };
  useEffect(() => init(fv.data), [fv.data]);
  useEffect(() => { if (fv.data?.title) navigation.setOptions({ title: fv.data.sku || "Product" }); }, [fv.data?.title]);

  const save = useMutation({
    mutationFn: () => api.forecastSettings(id, { lead_time_days: lead > 0 ? lead : null, min_safety_stock: safety, case_pack: Math.max(1, casePack), min_order_qty: moq }),
    onSuccess: () => {
      haptic.success();
      notify("Saved", "The forecast for this product is being recalculated. Numbers update in a few seconds.");
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["forecastV1", id] });
        qc.invalidateQueries({ queryKey: ["forecasts"] });
      }, 4000);
    },
    onError: (e: any) => { haptic.warning(); notify("Could not save", e?.message); },
  });

  if (fv.isPending) return <View style={{ flex: 1, backgroundColor: t.bg }}><ProductSkeleton /></View>;
  if (fv.isError || !fv.data)
    return <StatusView icon="alert-circle-outline" toneName="danger" title="Could not load product" body={(fv.error as Error)?.message} action={<Button title="Try again" variant="secondary" icon="refresh" onPress={() => fv.refetch()} />} />;

  const d = fv.data;
  const n = d.numbers;
  const o = d.ordering;
  const untracked = d.status === "untracked";
  const meta = statusOf(d.status);
  const rec = recommendation(d, currency);
  const recTone = tone(t, rec.tone);
  const dirty =
    lead !== (o.lead_time_override_days ?? 0) || safety !== (o.min_safety_stock ?? 0) || casePack !== (o.case_pack ?? 1) || moq !== (o.min_order_qty ?? 0);
  const canOrder = n.suggested_quantity > 0 && !untracked && d.status !== "no_sales";
  const outIn = n.runs_out_on ? daysUntil(n.runs_out_on) : null;
  const acc = d.accuracy != null ? Math.round(d.accuracy * 100) : null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, maxWidth: 760, width: "100%", alignSelf: "center" }}
      refreshControl={<RefreshControl refreshing={fv.isRefetching} onRefresh={() => { fv.refetch(); }} tintColor={t.primary} colors={[t.primary]} />}
    >
      {/* Header */}
      <View style={{ flexDirection: "row" }}>
        <Thumb uri={d.image_url} size={72} />
        <View style={{ flex: 1, marginLeft: space.md }}>
          <Text style={[type.title, { color: t.text }]}>{d.title}</Text>
          <Text style={[type.caption, { color: t.textMuted, marginTop: 2 }]}>
            {[d.sku ? `SKU ${d.sku}` : "No SKU", d.vendor, d.price != null ? money(d.price, currency) : null].filter(Boolean).join(" · ")}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8 }}>
            <StatusBadge status={d.status} size="md" />
            <Text style={[type.caption, { color: t.textSecondary, marginLeft: 10, flex: 1 }]} numberOfLines={2}>{meta.hint}</Text>
          </View>
        </View>
      </View>

      {/* Recommendation */}
      <Card style={{ marginTop: space.lg, borderColor: recTone.fg }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: recTone.bg, alignItems: "center", justifyContent: "center", marginRight: space.md }}>
            <Ionicons name={rec.icon} size={21} color={recTone.fg} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[type.label, { color: recTone.fg }]}>Recommended action</Text>
            <Text style={[type.heading, { color: t.text, marginTop: 2 }]}>{rec.title}</Text>
            <Text style={[type.caption, { color: t.textSecondary, marginTop: 4 }]}>{d.summary}</Text>
            {n.revenue_at_risk ? <Text style={[type.caption, { color: t.danger, marginTop: 4 }]}>{money(n.revenue_at_risk, currency)} of sales at risk over the next 8 weeks.</Text> : null}
          </View>
        </View>
        {canOrder ? (
          <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.md }}>
            {n.in_draft > 0 ? (
              <Button title="Open drafts" icon="document-text-outline" onPress={() => (navigation as any).navigate("Tabs", { screen: "Orders" })} style={{ flex: 1 }} small />
            ) : (
              <Button title="Reorder" icon="cart-outline" onPress={() => navigation.navigate("Reorder", { id, title: d.title })} style={{ flex: 1 }} small />
            )}
            <Button title="Ask about it" icon="sparkles-outline" variant="secondary" onPress={() => navigation.navigate("Ask", { prompt: `Why is ${d.title}${d.sku ? ` (${d.sku})` : ""} ${meta.label.toLowerCase()}, and what should I do?` })} style={{ flex: 1 }} small />
          </View>
        ) : null}
      </Card>

      {untracked ? (
        <View style={{ marginTop: space.md }}>
          <Notice icon="eye-off-outline" toneName="accent" title="Stock not tracked in your store">
            Demand is forecast, but stock, days of cover and the run-out date are unknown until inventory tracking is turned on.
          </Notice>
        </View>
      ) : null}

      <SectionTitle>Status</SectionTitle>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        <KpiTile label="On hand" icon="cube-outline" toneName="info" value={untracked ? "-" : num(n.on_hand)} sub={n.on_order || n.in_draft ? `${num(n.on_order)} on order · ${num(n.in_draft)} in drafts` : "units in stock"} />
        <KpiTile label="Days of cover" icon="hourglass-outline" toneName={d.status === "reorder_now" ? "danger" : d.status === "watch" ? "warning" : "neutral"} value={n.cover_days != null ? `${Math.round(n.cover_days)} d` : "-"} sub={`lead time ${n.lead_time_days} d`} />
        <KpiTile label="Runs out" icon="time-outline" toneName={n.runs_out_on ? "warning" : "neutral"} value={dateLabel(n.runs_out_on)} sub={outIn != null ? `in ${outIn} days · order today lands ${dateLabel(n.order_today_lands_on)}` : "not within the forecast"} />
        <KpiTile label="Suggested order" icon="cart-outline" toneName="primary" value={num(n.suggested_quantity)} sub={`reorder point ${num(n.reorder_point)} · safety ${num(Math.round(n.safety_stock ?? 0))}`} />
      </View>

      <SectionTitle>Stock projection</SectionTitle>
      <Card>
        {d.stock_curve && !untracked ? (
          <>
            <StockChart curve={d.stock_curve} />
            <Legend
              items={[
                { color: t.chartHistory, label: "Stock, last 3 weeks" },
                { color: t.chartForecast, label: "Projected stock" },
                { color: t.chartForecast, label: "Likely range (80%)", area: true },
                { color: t.warning, label: "Reorder point", dashed: true },
                { color: t.success, label: "Order today lands", dashed: true },
              ]}
            />
          </>
        ) : (
          <Text style={[type.caption, { color: t.textMuted }]}>
            {untracked ? "Stock is not tracked for this product, so there is no stock projection." : "No stock projection yet. It appears after the next forecast run."}
          </Text>
        )}
      </Card>

      <SectionTitle>Demand</SectionTitle>
      <Card>
        <View style={{ flexDirection: "row", marginBottom: space.md, gap: space.sm }}>
          <Stat label="Forecast a day" value={rate(n.forecast_per_day)} />
          <Stat label="Sold a day, 14 d" value={rate(n.rate_per_day)} />
          <Stat label="Confidence" value={d.confidence ? cap(d.confidence) : "-"} sub={acc != null ? `${acc}% accurate weekly` : undefined} />
        </View>
        <WeeklyBars data={d.weekly_demand ?? []} />
        <Legend items={[{ color: t.chartHistory, label: "Units sold a week" }, { color: t.chartForecast, label: "Forecast a week", dashed: true }]} />
        <View style={{ marginTop: space.md, borderTopWidth: 1, borderTopColor: t.border }}>
          <Row icon="pulse-outline" toneName="primary" title={d.model ? `Model: ${d.model}` : "No forecast yet"} subtitle={d.model ? `${MODEL[d.model] ?? d.model} · run ${dateLabel(d.run_date)}` : "The next run will add one"} last />
        </View>
      </Card>

      <SectionTitle>Ordering</SectionTitle>
      <Card style={{ paddingVertical: 4 }}>
        <Row icon="business-outline" toneName="primary" title={o.supplier ? o.supplier.name : "No supplier yet"} subtitle={o.supplier ? `Supplier${o.supplier_source ? `, chosen by ${o.supplier_source}` : ""}` : "Add suppliers in the Orders tab"} />
        <Row icon="time-outline" title={`Lead time ${n.lead_time_days} days`} subtitle={o.lead_time_override_days ? "Set for this product" : `From the supplier${o.lead_time_source ? ` (${o.lead_time_source})` : ""}`} />
        <Row icon="pricetag-outline" title={o.unit_cost != null ? `Unit cost ${money(o.unit_cost, currency)}` : "No unit cost"} subtitle={`Case pack ${o.case_pack ?? 1} · minimum order ${o.min_order_qty ?? 0}`} last />
      </Card>

      <SectionTitle>Reorder rules</SectionTitle>
      <Card>
        <View style={{ flexDirection: "row", gap: space.md }}>
          <Stepper label="Lead time" value={lead} onChange={setLead} min={0} unit={lead > 0 ? "days, this product only" : "0 = use the supplier's"} />
          <Stepper label="Min. safety stock" value={safety} onChange={setSafety} min={0} unit="units kept at least" />
        </View>
        <View style={{ flexDirection: "row", gap: space.md, marginTop: space.md }}>
          <Stepper label="Case pack" value={casePack} onChange={setCasePack} min={1} unit="order in multiples of" />
          <Stepper label="Minimum order" value={moq} onChange={setMoq} min={0} unit="units per order" />
        </View>
        <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.lg }}>
          {dirty ? <Button title="Undo" variant="secondary" onPress={() => init(d)} style={{ flex: 1 }} /> : null}
          <Button title={save.isSuccess && !dirty ? "Saved" : "Save rules"} icon={save.isSuccess && !dirty ? "checkmark" : undefined} onPress={() => save.mutate()} loading={save.isPending} disabled={!dirty} style={{ flex: 2 }} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "flex-start", marginTop: space.sm }}>
          <Ionicons name="information-circle-outline" size={14} color={t.textMuted} style={{ marginRight: 6, marginTop: 2 }} />
          <Text style={[type.caption, { color: t.textMuted, flex: 1 }]}>
            Safety stock is calculated from how much demand and delivery times vary; the minimum here is a floor. Suggested orders are rounded up to the case pack and minimum order.
          </Text>
        </View>
      </Card>
    </ScrollView>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
