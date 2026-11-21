import React, { useEffect } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api } from "../api/client";
import type { KpiDetail, KpiUnit } from "../api/types";
import { Button, Card, SectionTitle, StatusBadge, StatusView } from "../components/ui";
import { AnswerChart, HBars } from "../components/Charts";
import { fw, space, type, useTheme } from "../theme";
import { dateLabel, money } from "../utils/format";
import type { RootStackParamList } from "../navigation";
import { haptic } from "../utils/haptics";

type Props = NativeStackScreenProps<RootStackParamList, "Metric">;

const ICON: Record<string, React.ComponentProps<typeof Ionicons>["name"]> = {
  sales: "trending-up-outline",
  forecast: "analytics-outline",
  accuracy: "checkmark-done-outline",
  cover: "hourglass-outline",
  overstock: "layers-outline",
  protected: "shield-checkmark-outline",
  at_risk: "alert-circle-outline",
};

/** Format a value by its unit, in the store's currency for money. */
export function fmt(v: unknown, unit: KpiUnit | undefined, currency: string): string {
  if (v === null || v === undefined || v === "") return "-";
  switch (unit) {
    case "money": return money(Number(v), currency);
    case "percent": return `${Math.round(Number(v) * 10) / 10}%`;
    case "days": return Number(v) > 365 ? "1 yr+" : `${Math.round(Number(v))} d`;
    case "date": return dateLabel(String(v));
    case "units":
    case "count": return Math.round(Number(v)).toLocaleString();
    default: return String(v);
  }
}

export function MetricScreen({ route, navigation }: Props) {
  const { metric } = route.params;
  const t = useTheme();
  const q = useQuery({ queryKey: ["kpi", metric], queryFn: () => api.kpi(metric) });
  useEffect(() => { if (q.data?.title) navigation.setOptions({ title: q.data.title }); }, [q.data?.title]);

  if (q.isPending) return <StatusView spinner title="Loading the detail" />;
  if (q.isError || !q.data)
    return <StatusView icon="alert-circle-outline" toneName="danger" title="Could not load this number" body={(q.error as Error)?.message} action={<Button title="Try again" variant="secondary" onPress={() => q.refetch()} />} />;

  const d: KpiDetail = q.data;
  const c = d.currency;
  const open = (row: Record<string, any>) => {
    if (row.variant_id == null) return;
    haptic.tap();
    navigation.navigate("Product", { id: String(row.variant_id), title: row.title ?? "Product" });
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, maxWidth: 760, width: "100%", alignSelf: "center" }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} tintColor={t.primary} colors={[t.primary]} />}
    >
      {/* Summary */}
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: space.sm }}>
          <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: t.primarySoft, alignItems: "center", justifyContent: "center", marginRight: space.md }}>
            <Ionicons name={ICON[d.metric] ?? "stats-chart-outline"} size={18} color={t.primary} />
          </View>
          <Text style={[type.heading, fw(700), { color: t.text, flex: 1 }]}>{d.title}</Text>
        </View>
        <Text style={[type.body, { color: t.textSecondary }]}>{d.summary}</Text>
      </Card>

      {/* Headline figures */}
      {d.headline.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.md }}>
          {d.headline.map((h) => {
            const up = (h.change_pct ?? 0) >= 0;
            return (
              <Card key={h.label} style={{ flexGrow: 1, flexBasis: "46%", padding: space.md }}>
                <Text style={[type.label, { color: t.textMuted }]} numberOfLines={2}>{h.label}</Text>
                <Text style={[type.kpi, { color: t.text, marginTop: 4 }]} numberOfLines={1} adjustsFontSizeToFit>{fmt(h.value, h.unit, c)}</Text>
                <View style={{ flexDirection: "row", alignItems: "center", marginTop: 2, minHeight: 18 }}>
                  {h.change_pct != null ? (
                    <View style={{ flexDirection: "row", alignItems: "center", marginRight: 6 }}>
                      <Ionicons name={up ? "arrow-up" : "arrow-down"} size={11} color={up ? t.success : t.danger} />
                      <Text style={[fw(700), { color: up ? t.success : t.danger, fontSize: 12 }]}>{Math.abs(h.change_pct)}%</Text>
                    </View>
                  ) : null}
                  {h.sub ? <Text style={[type.caption, { color: t.textSecondary, flex: 1 }]} numberOfLines={2}>{/^\d{4}-\d{2}-\d{2}$/.test(h.sub) ? dateLabel(h.sub) : h.sub}</Text> : null}
                </View>
              </Card>
            );
          })}
        </View>
      ) : null}

      {/* Charts */}
      {d.charts.map((ch) => (
        <View key={ch.title}>
          <SectionTitle>{ch.title}</SectionTitle>
          <Card>
            {ch.caption ? <Text style={[type.caption, { color: t.textSecondary, marginBottom: space.md }]}>{ch.caption}</Text> : null}
            {ch.type === "hbar" ? (
              <HBars
                unit=""
                format={(v) => fmt(v, ch.unit, c)}
                rows={(ch.series[0]?.points ?? []).map((p, i) => ({ label: p.x, value: p.y, color: i === 0 ? t.primary : t.chartForecast }))}
              />
            ) : (
              <>
                <AnswerChart chart={{ type: ch.type, title: ch.title, series: ch.series }} height={210} />
                {ch.series.length > 1 ? (
                  <View style={{ flexDirection: "row", gap: 14, marginTop: 10 }}>
                    {ch.series.map((s, i) => (
                      <View key={s.name} style={{ flexDirection: "row", alignItems: "center" }}>
                        <View style={{ width: 14, height: 3, borderRadius: 2, backgroundColor: s.style === "forecast" ? t.chartForecast : i === 0 ? t.chartHistory : t.chartForecast, marginRight: 6 }} />
                        <Text style={[type.caption, { color: t.textSecondary }]}>{s.name}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                <Text style={[type.caption, { color: t.textMuted, marginTop: 6 }]}>
                  {ch.unit === "money" ? `Amounts in ${c}` : ch.unit === "percent" ? "Percent" : ch.unit === "units" ? "Units" : ""}
                </Text>
              </>
            )}
          </Card>
        </View>
      ))}

      {/* Tables */}
      {d.tables.map((tb) => (
        <View key={tb.title}>
          <SectionTitle>{tb.title}</SectionTitle>
          <Card style={{ paddingVertical: 4 }}>
            {tb.caption ? <Text style={[type.caption, { color: t.textSecondary, paddingTop: space.sm }]}>{tb.caption}</Text> : null}
            {tb.rows.length === 0 ? <Text style={[type.body, { color: t.textSecondary, paddingVertical: space.md }]}>Nothing to show yet.</Text> : null}
            {tb.rows.length ? (
              <View style={{ flexDirection: "row", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.border }}>
                {tb.columns.map((col, i) => (
                  <Text key={col.key} style={[fw(600), { color: t.textMuted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, flex: i === 0 ? 2.2 : 1, textAlign: i === 0 ? "left" : "right" }]} numberOfLines={1}>{col.label}</Text>
                ))}
              </View>
            ) : null}
            {tb.rows.map((row, ri) => (
              <Pressable
                key={ri}
                disabled={row.variant_id == null}
                onPress={() => open(row)}
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: ri < tb.rows.length - 1 ? 1 : 0, borderBottomColor: t.border, opacity: pressed ? 0.7 : 1 })}
              >
                {tb.columns.map((col, i) =>
                  i === 0 ? (
                    <View key={col.key} style={{ flex: 2.2, paddingRight: 8 }}>
                      <Text style={[type.captionStrong, { color: t.text }]} numberOfLines={2}>{String(row[col.key] ?? "-")}</Text>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
                        {row.sku ? <Text style={[type.caption, { color: t.textMuted, fontSize: 11 }]} numberOfLines={1}>{row.sku}</Text> : null}
                        {row.status ? <StatusBadge status={row.status} /> : null}
                      </View>
                    </View>
                  ) : (
                    <Text
                      key={col.key}
                      style={[fw(col.unit === "money" ? 700 : 600), { flex: 1, textAlign: "right", fontSize: 13, color: col.key === "change_pct" && row[col.key] != null ? (row[col.key] >= 0 ? t.success : t.danger) : t.text }]}
                      numberOfLines={1}
                    >
                      {col.key === "change_pct" && row[col.key] != null ? `${row[col.key] >= 0 ? "+" : ""}${fmt(row[col.key], "percent", c)}` : fmt(row[col.key], col.unit, c)}
                    </Text>
                  )
                )}
              </Pressable>
            ))}
          </Card>
        </View>
      ))}

      <View style={{ marginTop: space.lg }}>
        <Button title="Ask StockSense about this" icon="sparkles-outline" variant="secondary" onPress={() => navigation.navigate("Ask", { prompt: `Explain my ${d.title.toLowerCase()} and what I should do about it.` })} />
        {d.run_date ? <Text style={[type.caption, { color: t.textMuted, textAlign: "center", marginTop: space.sm }]}>Forecast run {dateLabel(d.run_date)}</Text> : null}
      </View>
    </ScrollView>
  );
}

