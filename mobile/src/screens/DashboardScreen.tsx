import React, { useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { api } from "../api/client";
import type { RiskItem, Summary } from "../api/types";
import { Avatar, Button, Card, Chip, KpiTile, Notice, OptionSheet, Pill, RiskBadge, SectionTitle, StatusView, Thumb } from "../components/ui";
import { DashboardSkeleton } from "../components/Skeleton";
import { RiskBar } from "../components/RiskBar";
import { fw, radius, riskMeta, RiskLevel, space, tone, type, useTheme } from "../theme";
import { ago, dateLabel, days, money, num, pctChange, rate } from "../utils/format";
import type { RootStackParamList } from "../navigation";
import { useAuth } from "../auth/AuthContext";
import { haptic } from "../utils/haptics";

const PLATFORM = { shopify: "Shopify", bigcommerce: "BigCommerce", woocommerce: "WooCommerce" } as const;
const TRACKING_HINT = {
  shopify: "Shopify admin › Products › Inventory › Track quantity",
  bigcommerce: "BigCommerce › Products › Inventory › Track inventory",
  woocommerce: "WooCommerce › Products › Inventory › Manage stock",
} as const;

type Filter = { key: string; label: string; count: (s: Summary) => number | undefined };
const FILTERS: Filter[] = [
  { key: "critical,low_stock", label: "At risk", count: (s) => s.at_risk },
  { key: "critical", label: "Critical", count: (s) => s.critical },
  { key: "healthy", label: "Healthy", count: (s) => s.healthy },
  { key: "overstocked", label: "Overstocked", count: (s) => s.overstocked },
  { key: "untracked", label: "Untracked", count: (s) => s.untracked },
  { key: "critical,low_stock,healthy,overstocked,no_demand,untracked", label: "All", count: (s) => s.skus_forecasted },
];

type SortKey = "risk" | "stockout" | "revenue" | "stock" | "name";
const SORTS: { key: SortKey; label: string; icon: React.ComponentProps<typeof Ionicons>["name"] }[] = [
  { key: "risk", label: "Risk level, then soonest stockout", icon: "alert-circle-outline" },
  { key: "stockout", label: "Soonest stockout first", icon: "time-outline" },
  { key: "revenue", label: "Most revenue at risk first", icon: "cash-outline" },
  { key: "stock", label: "Lowest stock first", icon: "cube-outline" },
  { key: "name", label: "Name, A to Z", icon: "text-outline" },
];

const RISK_RANK: Record<RiskLevel, number> = { critical: 0, low_stock: 1, healthy: 2, overstocked: 3, untracked: 4, no_demand: 5 };

function sortItems(items: RiskItem[], key: SortKey): RiskItem[] {
  const big = 9e15;
  const d = (s: string | null) => (s ? Date.parse(s) : big);
  const copy = [...items];
  switch (key) {
    case "stockout": return copy.sort((a, b) => d(a.stockout_date) - d(b.stockout_date));
    case "revenue": return copy.sort((a, b) => Number(b.revenue_at_risk) - Number(a.revenue_at_risk));
    case "stock": return copy.sort((a, b) => (a.risk_level === "untracked" ? big : a.current_stock) - (b.risk_level === "untracked" ? big : b.current_stock));
    case "name": return copy.sort((a, b) => a.title.localeCompare(b.title));
    default: return copy.sort((a, b) => RISK_RANK[a.risk_level] - RISK_RANK[b.risk_level] || d(a.stockout_date) - d(b.stockout_date));
  }
}

export function DashboardScreen() {
  const t = useTheme();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { signOut } = useAuth();
  const [level, setLevel] = useState(FILTERS[0].key);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("risk");
  const [sortOpen, setSortOpen] = useState(false);

  const store = useQuery({
    queryKey: ["store"],
    queryFn: api.store,
    refetchInterval: (query) => (query.state.data?.sync_status === "ready" ? false : 8000),
    retry: 1,
  });
  const ready = store.data?.sync_status === "ready";
  const summary = useQuery({
    queryKey: ["summary"],
    queryFn: api.summary,
    enabled: ready,
    refetchInterval: (query) => (query.state.data?.ready ? 60_000 : 10_000),
  });
  const hasForecast = !!summary.data?.ready;
  const risks = useQuery({ queryKey: ["risks", level, q], queryFn: () => api.risks(level, q), enabled: hasForecast });

  const currency = store.data?.currency || "USD";
  const refreshing = store.isFetching || summary.isFetching || risks.isFetching;
  const refresh = () => { haptic.tap(); store.refetch(); summary.refetch(); risks.refetch(); };
  const filters = useMemo(
    () => FILTERS.filter((f) => f.key !== "untracked" || (summary.data?.untracked ?? 0) > 0),
    [summary.data?.untracked]
  );
  const items = useMemo(() => sortItems(risks.data?.items ?? [], sort), [risks.data?.items, sort]);

  /* ---------- status screens ---------- */
  if (store.isPending) return <Screen><DashboardSkeleton /></Screen>;
  if (store.isError) {
    const status = (store.error as any)?.status;
    return (
      <Screen>
        <StatusView
          icon={status === 401 ? "key-outline" : "cloud-offline-outline"}
          toneName="danger"
          title={status === 401 ? "Session expired" : "Cannot reach the server"}
          body={(store.error as Error).message}
          action={status === 401 ? <Button title="Connect again" onPress={signOut} /> : <Button title="Try again" variant="secondary" icon="refresh" onPress={() => store.refetch()} />}
        />
      </Screen>
    );
  }
  const s = store.data;
  if (!s) return <Screen><DashboardSkeleton /></Screen>;
  if (s.sync_status === "error")
    return <Screen><StatusView icon="alert-circle-outline" toneName="danger" title="Store sync failed" body={s.sync_error || "The store could not be synced. Check the credentials and connect again."} action={<Button title="Connect again" variant="secondary" onPress={signOut} />} /></Screen>;
  if (s.sync_status === "uninstalled")
    return <Screen><StatusView icon="unlink-outline" toneName="warning" title="Store disconnected" body="The app was uninstalled from the store. Connect it again to resume forecasting." /></Screen>;
  if (!ready)
    return <Screen><StatusView spinner title="Syncing your store" body="Pulling products, inventory and order history. This usually takes under a minute." /></Screen>;
  if (summary.isPending || !summary.data) return <Screen><DashboardSkeleton /></Screen>;
  if (summary.isError) return <Screen><StatusView icon="cloud-offline-outline" toneName="danger" title="Could not load the forecast" body={(summary.error as Error).message} action={<Button title="Try again" variant="secondary" icon="refresh" onPress={() => summary.refetch()} />} /></Screen>;
  if (!summary.data.ready) {
    const job = summary.data.forecast_job;
    if (job === "queued" || job === "running") return <Screen><StatusView spinner title="Running your first forecast" body="Your store is synced. The forecast takes a minute or two." /></Screen>;
    if (job === "error") return <Screen><StatusView icon="warning-outline" toneName="danger" title="Forecast failed" body={summary.data.forecast_error || "The forecast worker reported an error."} /></Screen>;
    if (job === "done" && !summary.data.has_sales) return <Screen><StatusView icon="receipt-outline" title="No orders yet" body="StockSense forecasts from your order history, and this store has no paid orders in the last 18 months. New orders are picked up within minutes." /></Screen>;
    return <Screen><StatusView spinner title="Store synced" body="Waiting for the first forecast run (nightly at 02:00 UTC)." /></Screen>;
  }

  /* ---------- dashboard ---------- */
  const sm = summary.data;
  const k = sm.kpis;
  const salesDelta = k ? pctChange(k.sales_30d.revenue, k.sales_prev_30d.revenue) : null;
  const danger = tone(t, "danger");
  const atRisk = sm.at_risk ?? 0;
  const counts: Partial<Record<RiskLevel, number>> = {
    critical: sm.critical, low_stock: sm.low_stock, healthy: sm.healthy, overstocked: sm.overstocked, no_demand: sm.no_demand, untracked: sm.untracked,
  };
  const pickLevel = (lvl: RiskLevel) => { haptic.tap(); setLevel(lvl); };

  const header = (
    <View>
      {/* Store header */}
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: space.lg }}>
        <Avatar name={s.store_domain} />
        <View style={{ flex: 1, marginLeft: space.md }}>
          <Text style={[type.title, { color: t.text }]} numberOfLines={1}>{s.store_domain}</Text>
          <Text style={[type.caption, { color: t.textSecondary }]} numberOfLines={1}>
            {PLATFORM[s.platform]} · updated {ago(summary.dataUpdatedAt)}
          </Text>
        </View>
        {sm.run_date ? <Pill icon="sparkles-outline" toneName="primary">{`Forecast ${dateLabel(sm.run_date)}`}</Pill> : null}
      </View>

      {/* Hero: stockout risk */}
      <Card>
        <View style={{ flexDirection: "row" }}>
          <View style={{ flex: 1 }}>
            <Text style={[type.label, { color: t.textMuted }]}>SKUs at risk</Text>
            <Text style={[type.display, { color: atRisk > 0 ? t.danger : t.success, marginTop: 4 }]}>{num(atRisk)}</Text>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              <Pill toneName="danger">{`${sm.critical ?? 0} critical`}</Pill>
              <Pill toneName="warning">{`${sm.low_stock ?? 0} low`}</Pill>
            </View>
          </View>
          <View style={{ width: 1, backgroundColor: t.border, marginHorizontal: space.lg }} />
          <View style={{ flex: 1 }}>
            <Text style={[type.label, { color: t.textMuted }]}>Revenue at risk</Text>
            <Text style={[type.display, { color: t.text, marginTop: 4 }]} numberOfLines={1} adjustsFontSizeToFit>{money(sm.revenue_at_risk, currency)}</Text>
            <Text style={[type.caption, { color: t.textSecondary, marginTop: 6 }]}>next 8 weeks if not reordered</Text>
          </View>
        </View>
        <View style={{ marginTop: space.lg, paddingTop: space.md, borderTopWidth: 1, borderTopColor: t.border }}>
          <RiskBar counts={counts} onPick={pickLevel} />
        </View>
        {k?.next_stockout_date ? (
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: space.md, backgroundColor: danger.bg, borderRadius: radius.md, padding: 10 }}>
            <Ionicons name="time-outline" size={16} color={danger.fg} style={{ marginRight: 8 }} />
            <Text style={[type.caption, { color: t.textSecondary, flex: 1 }]} numberOfLines={2}>
              Next stockout <Text style={[fw(700), { color: t.text }]}>{dateLabel(k.next_stockout_date)}</Text>
              {k.next_stockout_title ? ` · ${k.next_stockout_title}` : ""}
            </Text>
          </View>
        ) : null}
      </Card>

      {k ? (
        <>
          <SectionTitle>Inventory KPIs</SectionTitle>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            <KpiTile label="Sales · 30 days" icon="trending-up-outline" toneName="success" value={money(k.sales_30d.revenue, currency)} sub={`${num(k.sales_30d.units)} units`} delta={salesDelta != null ? { value: salesDelta } : null} />
            <KpiTile label="Forecast · 30 days" icon="analytics-outline" toneName="primary" value={money(k.forecast_30d.revenue, currency)} sub={`${num(k.forecast_30d.units)} units expected`} />
            <KpiTile label="Inventory value" icon="cube-outline" toneName="info" value={money(k.inventory_value, currency)} sub={`${num(k.units_on_hand)} units on hand · retail`} />
            <KpiTile label="Days of cover" icon="hourglass-outline" toneName={k.median_cover_days != null && k.median_cover_days < 14 ? "warning" : "neutral"} value={k.median_cover_days != null ? `${k.median_cover_days} d` : "-"} sub={k.healthy_pct != null ? `${k.healthy_pct}% of SKUs healthy` : "median across SKUs"} />
            <KpiTile label="Reorder now" icon="cart-outline" toneName={k.reorder_units > 0 ? "danger" : "neutral"} value={num(k.reorder_units)} sub={`${money(k.reorder_value, currency)} at retail`} onPress={() => pickLevel("critical")} />
            <KpiTile label="Overstock" icon="layers-outline" toneName={k.overstock_units > 0 ? "warning" : "neutral"} value={num(sm.overstocked)} sub={k.overstock_units > 0 ? `${num(k.overstock_units)} units · ${money(k.overstock_value, currency)}` : "beyond 120 days of demand"} onPress={() => pickLevel("overstocked")} />
          </View>
          {k.sell_through_30d != null ? (
            <Text style={[type.caption, { color: t.textMuted, marginTop: space.sm }]}>
              Sell-through 30 d: {k.sell_through_30d}% · money figures use retail prices; unit cost is not synced.
            </Text>
          ) : null}
        </>
      ) : null}

      {sm.untracked ? (
        <View style={{ marginTop: space.lg }}>
          <Notice icon="eye-off-outline" toneName="accent" title={`${sm.untracked} of ${sm.skus_forecasted} products are not stock-tracked`}>
            Their demand is forecast, but stock and stockout dates are unknown. Turn tracking on under {TRACKING_HINT[s.platform]}.
          </Notice>
        </View>
      ) : null}

      <SectionTitle
        action={
          <Pressable onPress={() => { haptic.tap(); setSortOpen(true); }} style={{ flexDirection: "row", alignItems: "center" }}>
            <Ionicons name="swap-vertical-outline" size={14} color={t.primary} style={{ marginRight: 4 }} />
            <Text style={[fw(600), { color: t.primary, fontSize: 12 }]}>Sort</Text>
          </Pressable>
        }
      >
        Products
      </SectionTitle>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.md }} contentContainerStyle={{ paddingRight: space.lg }}>
        {filters.map((f) => (
          <Chip key={f.key} label={f.label} count={f.count(sm)} active={level === f.key} onPress={() => setLevel(f.key)} />
        ))}
      </ScrollView>
      <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: radius.md, paddingHorizontal: 12, marginBottom: space.md }}>
        <Ionicons name="search-outline" size={18} color={t.textMuted} />
        <TextInput
          style={[fw(400), { flex: 1, color: t.text, paddingVertical: 11, paddingHorizontal: 8, fontSize: 15 }]}
          placeholder="Search by name or SKU"
          placeholderTextColor={t.textMuted}
          value={q}
          onChangeText={setQ}
          autoCapitalize="none"
          returnKeyType="search"
        />
        {q ? <Pressable onPress={() => setQ("")} hitSlop={8}><Ionicons name="close-circle" size={18} color={t.textMuted} /></Pressable> : null}
      </View>
      {items.length ? (
        <Text style={[type.caption, { color: t.textMuted, marginBottom: space.sm }]}>
          {items.length} {items.length === 1 ? "product" : "products"} · {SORTS.find((x) => x.key === sort)?.label.toLowerCase()}
        </Text>
      ) : null}
    </View>
  );

  return (
    <Screen>
      <FlatList
        data={items}
        keyExtractor={(r) => r.variant_id}
        ListHeaderComponent={header}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={t.primary} colors={[t.primary]} />}
        ListEmptyComponent={
          risks.isLoading ? undefined : (
            <View style={{ alignItems: "center", padding: space.xl }}>
              <Ionicons name="checkmark-circle-outline" size={28} color={t.success} />
              <Text style={[type.body, { color: t.textSecondary, marginTop: 6 }]}>No products in this view.</Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <ProductRow item={item} currency={currency} onPress={() => { haptic.tap(); nav.navigate("Product", { id: item.variant_id, title: item.title }); }} />
        )}
      />
      <OptionSheet title="Sort products" options={SORTS} value={sort} onSelect={setSort} visible={sortOpen} onClose={() => setSortOpen(false)} />
    </Screen>
  );
}

function ProductRow({ item, currency, onPress }: { item: RiskItem; currency: string; onPress: () => void }) {
  const t = useTheme();
  const meta = riskMeta[item.risk_level] ?? riskMeta.no_demand;
  const c = tone(t, meta.tone);
  const untracked = item.risk_level === "untracked";
  const revenueAtRisk = Number(item.revenue_at_risk);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
      <Card style={{ padding: 0, marginBottom: space.sm, flexDirection: "row", overflow: "hidden" }}>
        <View style={{ width: 4, backgroundColor: c.fg }} />
        <View style={{ flex: 1, padding: space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Thumb uri={item.image_url} />
            <View style={{ flex: 1, marginHorizontal: space.md }}>
              <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={2}>{item.title}</Text>
              <Text style={[type.caption, { color: t.textMuted }]} numberOfLines={1}>
                {item.sku ? `SKU ${item.sku}` : "No SKU"} · {rate(item.avg_daily_demand)}/day
              </Text>
            </View>
            <RiskBadge level={item.risk_level} />
          </View>
          <View style={{ flexDirection: "row", marginTop: space.md, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: t.border }}>
            <Metric label="Stock" value={untracked ? "—" : num(item.current_stock)} />
            <Metric label="Cover" value={days(item.days_of_stock)} warn={item.risk_level === "critical"} />
            <Metric label="Stockout" value={dateLabel(item.stockout_date)} warn={item.risk_level === "critical"} />
            <Metric label="Reorder" value={num(item.reorder_qty)} />
            <Metric label="At risk" value={revenueAtRisk > 0 ? money(revenueAtRisk, currency) : "—"} />
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

function Metric({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1 }}>
      <Text style={[fw(600), { color: t.textMuted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }]}>{label}</Text>
      <Text style={[fw(700), { color: warn ? t.danger : t.text, fontSize: 13, marginTop: 2 }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>{children}</SafeAreaView>;
}
