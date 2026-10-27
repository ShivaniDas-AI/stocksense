import React, { useEffect, useState } from "react";
import { ScrollView, Text, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api } from "../api/client";
import { Button, Card, KpiTile, Notice, RiskBadge, Row, SectionTitle, StatusView, Stepper } from "../components/ui";
import { LineChart } from "../components/LineChart";
import { riskMeta, space, type, useTheme } from "../theme";
import { dateLabel, money, num, rate } from "../utils/format";
import type { RootStackParamList } from "../navigation";

type Props = NativeStackScreenProps<RootStackParamList, "Product">;

function toDate(s: string): Date {
  const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
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
      qc.invalidateQueries({ queryKey: ["variant", id] });
      qc.invalidateQueries({ queryKey: ["risks"] });
    },
  });

  if (detail.isLoading) return <StatusView title="Loading product" spinner />;
  if (detail.isError || !detail.data)
    return <StatusView icon="alert-circle-outline" toneName="danger" title="Could not load product" body={(detail.error as Error)?.message} />;

  const { variant, history, forecast, risk } = detail.data;
  const untracked = risk?.risk_level === "untracked" || !variant.track_inventory;
  const fcPoints = forecast
    ? ((typeof forecast.daily_forecast === "string" ? JSON.parse(forecast.daily_forecast) : forecast.daily_forecast) as { d: string; y: number }[])
    : [];
  const dirty = detail.data && (lead !== variant.lead_time_days || safety !== variant.safety_stock);
  const meta = risk ? riskMeta[risk.risk_level] : null;
  const revenueAtRisk = Number(risk?.revenue_at_risk ?? 0);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
      <Text style={[type.title, { color: t.text }]}>{variant.title || variant.product_title}</Text>
      <Text style={[type.caption, { color: t.textMuted, marginTop: 2 }]}>
        {variant.sku ? `SKU ${variant.sku}` : "No SKU"}{variant.price ? ` · ${money(variant.price, currency)}` : ""}
      </Text>
      {risk ? (
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: space.md }}>
          <RiskBadge level={risk.risk_level} size="md" />
          {meta ? <Text style={[type.caption, { color: t.textSecondary, marginLeft: 10, flex: 1 }]}>{meta.hint}</Text> : null}
        </View>
      ) : null}

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
        <KpiTile label="Stockout" icon="time-outline" toneName={risk?.stockout_date ? "warning" : "neutral"} value={dateLabel(risk?.stockout_date)} sub="projected date" />
        <KpiTile label="Reorder" icon="cart-outline" toneName="primary" value={`${num(risk?.reorder_qty ?? 0)}`} sub={`units · point ${num(risk?.reorder_point)}`} />
      </View>
      {revenueAtRisk > 0 ? (
        <Text style={[type.caption, { color: t.danger, marginTop: space.sm }]}>
          {money(revenueAtRisk, currency)} of sales at risk in the next 8 weeks if not reordered.
        </Text>
      ) : null}

      <SectionTitle>Demand</SectionTitle>
      <Card>
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
          <Row icon="pulse-outline" toneName="primary" title={forecast ? `${rate(forecast.avg_daily_demand)} units / day` : "No forecast yet"} subtitle={forecast ? `Average forecast demand · model ${forecast.model_used} · run ${dateLabel(forecast.run_date)}` : "The nightly run will add one"} last />
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

function Legend({ color, label }: { color: string; label: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <View style={{ width: 10, height: 3, borderRadius: 2, backgroundColor: color, marginRight: 6 }} />
      <Text style={[type.caption, { color: t.textSecondary }]}>{label}</Text>
    </View>
  );
}
