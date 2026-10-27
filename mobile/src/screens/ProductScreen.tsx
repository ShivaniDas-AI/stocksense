import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api } from "../api/client";
import { Button, Card, Input, RiskBadge, Stat, StatusView } from "../components/ui";
import { LineChart } from "../components/LineChart";
import { colors, space } from "../theme";
import { dateLabel, num } from "../utils/format";
import type { RootStackParamList } from "../navigation";

type Props = NativeStackScreenProps<RootStackParamList, "Product">;

function toDate(s: string): Date {
  const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function ProductScreen({ route }: Props) {
  const { id } = route.params;
  const qc = useQueryClient();
  const { width } = useWindowDimensions();
  const detail = useQuery({ queryKey: ["variant", id], queryFn: () => api.variant(id) });

  const [lead, setLead] = useState("");
  const [safety, setSafety] = useState("");
  useEffect(() => {
    if (detail.data) {
      setLead(String(detail.data.variant.lead_time_days));
      setSafety(String(detail.data.variant.safety_stock));
    }
  }, [detail.data]);

  const save = useMutation({
    mutationFn: () =>
      api.updateVariant(id, {
        lead_time_days: Math.max(1, parseInt(lead, 10) || 1),
        safety_stock: Math.max(0, parseInt(safety, 10) || 0),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["variant", id] });
      qc.invalidateQueries({ queryKey: ["risks"] });
    },
  });

  if (detail.isLoading) return <StatusView title="Loading..." spinner />;
  if (detail.isError || !detail.data) return <StatusView title="Could not load product" body={(detail.error as Error)?.message} error />;

  const { variant, history, forecast, risk } = detail.data;
  const untracked = risk?.risk_level === "untracked" || !variant.track_inventory;
  const fcPoints = forecast
    ? (typeof forecast.daily_forecast === "string" ? JSON.parse(forecast.daily_forecast) : forecast.daily_forecast) as { d: string; y: number }[]
    : [];

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
      <Text style={styles.title}>{variant.title || variant.product_title}</Text>
      <View style={styles.subRow}>
        {variant.sku ? <Text style={styles.sub}>SKU {variant.sku} · </Text> : null}
        <Text style={styles.sub}>{forecast ? `model ${forecast.model_used}` : "no forecast yet"}</Text>
        {risk ? <View style={{ marginLeft: space.sm }}><RiskBadge level={risk.risk_level} /></View> : null}
      </View>
      {untracked ? <Text style={styles.warn}>Inventory is not tracked in your store for this product, so stock and stockout date are unknown.</Text> : null}

      <View style={styles.cards}>
        <Stat label="Current stock" value={untracked ? "unknown" : num(risk?.current_stock ?? variant.current_stock)} />
        <Stat label="Days of cover" value={risk?.days_of_stock != null ? `${Math.round(Number(risk.days_of_stock))} days` : "-"} />
        <Stat label="Projected stockout" value={dateLabel(risk?.stockout_date)} color={risk?.risk_level === "critical" ? colors.red : undefined} />
        <Stat label="Suggested reorder" value={`${num(risk?.reorder_qty ?? 0)} units`} color={colors.green} />
      </View>

      <Card style={{ marginBottom: space.md }}>
        <LineChart
          width={width - space.lg * 2 - space.md * 2}
          history={history.map((h) => ({ x: toDate(h.sale_date), y: Number(h.units_sold) }))}
          forecast={fcPoints.map((f) => ({ x: toDate(f.d), y: Number(f.y) }))}
        />
        <View style={styles.legend}>
          <Text style={styles.legendItem}><Text style={{ color: colors.blue }}>●</Text> Sales (90d)</Text>
          <Text style={styles.legendItem}><Text style={{ color: colors.green }}>●</Text> Forecast (8w)</Text>
          {forecast ? <Text style={styles.legendItem}>run {dateLabel(forecast.run_date)}</Text> : null}
        </View>
      </Card>

      <Card>
        <Text style={styles.sectionTitle}>Reorder settings</Text>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Input label="Lead time (days)" value={lead} onChangeText={setLead} keyboardType="number-pad" />
          </View>
          <View style={{ flex: 1 }}>
            <Input label="Safety stock (units)" value={safety} onChangeText={setSafety} keyboardType="number-pad" />
          </View>
        </View>
        <Button title={save.isSuccess ? "Saved" : "Save"} onPress={() => save.mutate()} loading={save.isPending} />
        <Text style={styles.note}>Risk levels update on the next forecast run.</Text>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.bg },
  body: { padding: space.lg, paddingBottom: space.xl * 2 },
  title: { color: colors.text, fontSize: 18, fontWeight: "800" },
  subRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", marginTop: 4, marginBottom: space.md },
  sub: { color: colors.dim, fontSize: 12 },
  warn: { color: colors.purple, fontSize: 12, marginBottom: space.md, lineHeight: 17 },
  cards: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.md },
  legend: { flexDirection: "row", gap: 14, marginTop: 6 },
  legendItem: { color: colors.dim, fontSize: 11 },
  sectionTitle: { color: colors.text, fontWeight: "700", marginBottom: space.sm },
  note: { color: colors.dim, fontSize: 11, marginTop: space.sm },
});
