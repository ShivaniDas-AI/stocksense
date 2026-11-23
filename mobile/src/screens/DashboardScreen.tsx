import React, { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { Text, TextInput } from "../components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { api } from "../api/client";
import type { ForecastRow, KpiMetric } from "../api/types";
import { Avatar, Button, Card, Chip, KpiTile, Notice, OptionSheet, Pill, SectionTitle, StatusBadge, StatusView, Thumb, Grid2 } from "../components/ui";
import { DashboardSkeleton } from "../components/Skeleton";
import { StatusBar } from "../components/StatusBar";
import { HBars, Legend, WeeklyBars } from "../components/Charts";
import { fw, radius, Status, STATUS_ORDER, statusMeta, statusOf, space, tone, type, useTheme, useThemeMode } from "../theme";
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

const ALL = STATUS_ORDER.join(",");
const AT_RISK = "reorder_now,watch";

type SortKey = "status" | "runs_out" | "revenue_at_risk" | "cover" | "name";
const SORTS: { key: SortKey; label: string; icon: React.ComponentProps<typeof Ionicons>["name"] }[] = [
  { key: "status", label: "Status, then least cover", icon: "alert-circle-outline" },
  { key: "runs_out", label: "Runs out soonest", icon: "time-outline" },
  { key: "revenue_at_risk", label: "Most revenue at risk", icon: "cash-outline" },
  { key: "cover", label: "Fewest days of cover", icon: "hourglass-outline" },
  { key: "name", label: "Name, A to Z", icon: "text-outline" },
];

export function DashboardScreen() {
  const t = useTheme();
  const { setMode } = useThemeMode();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { signOut } = useAuth();
  const [filter, setFilter] = useState(AT_RISK);
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("status");
  const [sortOpen, setSortOpen] = useState(false);

  // Debounce typing so each keystroke is not a request.
  useEffect(() => {
    const id = setTimeout(() => setQ(qInput.trim()), 250);
    return () => clearTimeout(id);
  }, [qInput]);

  const store = useQuery({
    queryKey: ["store"],
    queryFn: api.store,
    refetchInterval: (query) => (query.state.data?.sync_status === "ready" ? false : 8000),
    retry: 1,
  });
  const ready = store.data?.sync_status === "ready";
  const storeV1 = useQuery({ queryKey: ["storeV1"], queryFn: api.storeV1, enabled: ready, retry: 1 });
  const summary = useQuery({
    queryKey: ["summary"],
    queryFn: api.summary,
    enabled: ready,
    refetchInterval: (query) => (query.state.data?.ready ? 60_000 : 10_000),
  });
  const hasForecast = !!summary.data?.ready;
  const dash = useQuery({ queryKey: ["dashboardV1"], queryFn: api.dashboardV1, enabled: hasForecast, retry: 1 });
  const all = useQuery({ queryKey: ["forecasts", "counts"], queryFn: () => api.forecasts({ limit: 1 }), enabled: hasForecast });
  const list = useQuery({ queryKey: ["forecasts", filter, q, sort], queryFn: () => api.forecasts({ status: filter, q, sort }), enabled: hasForecast });

  const currency = store.data?.currency || "USD";
  const counts = all.data?.counts ?? {};
  const refreshing = store.isRefetching || summary.isRefetching || list.isRefetching || dash.isRefetching;
  const refresh = () => { haptic.tap(); store.refetch(); summary.refetch(); list.refetch(); all.refetch(); dash.refetch(); storeV1.refetch(); };
  const filters = useMemo(() => {
    const n = (k: string) => k.split(",").reduce((a, s) => a + (counts[s] || 0), 0);
    const base: { key: string; label: string; count: number }[] = [
      { key: AT_RISK, label: "At risk", count: n(AT_RISK) },
      ...STATUS_ORDER.map((s) => ({ key: s, label: statusMeta[s].label, count: counts[s] || 0 })),
      { key: ALL, label: "All", count: all.data?.total ?? 0 },
    ];
    return base.filter((f) => f.count > 0 || f.key === AT_RISK || f.key === ALL || f.key === filter);
  }, [counts, all.data?.total, filter]);
  const items = list.data?.data ?? [];

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
    return <Screen><StatusView spinner title="Store synced" body="Waiting for the first forecast run." /></Screen>;
  }

  /* ---------- dashboard ---------- */
  const sm = summary.data;
  const k = sm.kpis;
  const cards = dash.data?.cards;
  const salesDelta = k ? pctChange(k.sales_30d.revenue, k.sales_prev_30d.revenue) : null;
  const danger = tone(t, "danger");
  const reorderNow = counts.reorder_now ?? 0;
  const watch = counts.watch ?? 0;
  const name = storeV1.data?.name || storeName(s.store_domain);
  const pick = (st: Status) => { haptic.tap(); setFilter(st); };
  const openMetric = (metric: KpiMetric, title: string) => { haptic.tap(); nav.navigate("Metric", { metric, title }); };
  const openProduct = (id: number | string, title: string) => { haptic.tap(); nav.navigate("Product", { id: String(id), title }); };

  const header = (
    <View>
      {/* Store header */}
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: space.lg }}>
        <Avatar name={name} />
        <View style={{ flex: 1, marginLeft: space.md }}>
          <Text style={[type.heading, fw(700), { color: t.text, fontSize: 18 }]} numberOfLines={1}>{name}</Text>
          <Text style={[type.caption, { color: t.textSecondary, marginTop: 2 }]} numberOfLines={1}>
            {PLATFORM[s.platform]} · forecast {dateLabel(sm.run_date)} · updated {ago(summary.dataUpdatedAt)}
          </Text>
        </View>
        <Pressable
          onPress={() => { haptic.tap(); setMode(t.dark ? "light" : "dark"); }}
          accessibilityLabel={t.dark ? "Switch to light mode" : "Switch to dark mode"}
          hitSlop={6}
          style={({ pressed }) => ({ width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: t.surfaceAlt, borderWidth: 1, borderColor: t.border, marginLeft: space.sm, opacity: pressed ? 0.75 : 1 })}
        >
          <Ionicons name={t.dark ? "sunny" : "moon"} size={17} color={t.dark ? t.warning : t.textSecondary} />
        </Pressable>
        <Pressable
          onPress={() => { haptic.tap(); nav.navigate("Ask"); }}
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", backgroundColor: t.primarySoft, borderRadius: radius.pill, paddingHorizontal: 12, height: 38, marginLeft: space.sm, opacity: pressed ? 0.75 : 1 })}
        >
          <Ionicons name="sparkles" size={15} color={t.primary} style={{ marginRight: 5 }} />
          <Text style={[fw(700), { color: t.primary, fontSize: 13 }]}>Ask</Text>
        </Pressable>
      </View>

      {/* Hero: what needs attention */}
      <Card>
        <View style={{ flexDirection: "row" }}>
          <Pressable style={{ flex: 1 }} onPress={() => pick("reorder_now")}>
            <Text style={[type.label, { color: t.textMuted }]}>Reorder now</Text>
            <Text style={[type.display, { color: reorderNow > 0 ? t.danger : t.success, marginTop: 4 }]}>{num(reorderNow)}</Text>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              <Pill toneName="warning">{`${watch} to watch`}</Pill>
              {cards?.need_reordering.draft_purchase_orders ? <Pill toneName="primary" icon="document-text-outline">{`${cards.need_reordering.draft_purchase_orders} ${cards.need_reordering.draft_purchase_orders === 1 ? "draft" : "drafts"}`}</Pill> : null}
            </View>
          </Pressable>
          <View style={{ width: 1, backgroundColor: t.border, marginHorizontal: space.lg }} />
          <Pressable style={{ flex: 1 }} onPress={() => openMetric("at_risk", "Revenue at risk")}>
            <Text style={[type.label, { color: t.textMuted }]}>Revenue at risk</Text>
            <Text style={[type.display, { color: t.text, marginTop: 4 }]} numberOfLines={1} adjustsFontSizeToFit>{money(sm.revenue_at_risk, currency)}</Text>
            <Text style={[type.caption, { color: t.textSecondary, marginTop: 6 }]}>on products to reorder now, over the next 8 weeks</Text>
            <Text style={[fw(600), { color: t.primary, fontSize: 12, marginTop: 6 }]}>See all at risk ›</Text>
          </Pressable>
        </View>
        <View style={{ marginTop: space.lg, paddingTop: space.md, borderTopWidth: 1, borderTopColor: t.border }}>
          <StatusBar counts={counts} onPick={pick} />
        </View>
        {k?.next_stockout_date ? (
          <Pressable
            onPress={() => (k as any).next_stockout_variant_id && openProduct((k as any).next_stockout_variant_id, k.next_stockout_title || "Product")}
            style={{ flexDirection: "row", alignItems: "center", marginTop: space.md, backgroundColor: danger.bg, borderRadius: radius.md, padding: 10 }}
          >
            <Ionicons name="time-outline" size={16} color={danger.fg} style={{ marginRight: 8 }} />
            <Text style={[type.caption, { color: t.textSecondary, flex: 1 }]} numberOfLines={2}>
              Next stockout <Text style={[fw(700), { color: t.text }]}>{dateLabel(k.next_stockout_date)}</Text>
              {k.next_stockout_title ? ` · ${k.next_stockout_title}` : ""}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={t.textMuted} />
          </Pressable>
        ) : null}
      </Card>

      {/* KPIs */}
      <SectionTitle action={<Text style={[type.caption, { color: t.textMuted }]}>Tap one for detail</Text>}>Key numbers</SectionTitle>
      <Grid2>
        {k ? <KpiTile label="Sales · 30 days" icon="trending-up-outline" toneName="success" value={money(k.sales_30d.revenue, currency)} sub={`${num(k.sales_30d.units)} units`} delta={salesDelta != null ? { value: salesDelta } : null} onPress={() => openMetric("sales", "Sales")} /> : null}
        {k ? <KpiTile label="Forecast · 30 days" icon="analytics-outline" toneName="primary" value={money(k.forecast_30d.revenue, currency)} sub={`${num(k.forecast_30d.units)} units expected`} onPress={() => openMetric("forecast", "Forecast")} /> : null}
        {cards ? (
          <KpiTile
            label="Forecast accuracy"
            icon="checkmark-done-outline"
            toneName={cards.forecast_accuracy.value != null && cards.forecast_accuracy.value >= 70 ? "success" : "warning"}
            value={cards.forecast_accuracy.value != null ? `${Math.round(cards.forecast_accuracy.value)}%` : "-"}
            sub={cards.forecast_accuracy.value != null ? "weekly sales vs forecast, last 4 weeks" : "needs a few weeks of regular sales"}
            onPress={() => openMetric("accuracy", "Forecast accuracy")}
          />
        ) : null}
        {k ? <KpiTile label="Days of cover" icon="hourglass-outline" toneName={k.median_cover_days != null && k.median_cover_days < 14 ? "warning" : "neutral"} value={k.median_cover_days != null ? `${k.median_cover_days} d` : "-"} sub="median across products" onPress={() => openMetric("cover", "Days of cover")} /> : null}
        {cards ? <KpiTile label="Cash in overstock" icon="layers-outline" toneName={cards.cash_in_overstock.value > 0 ? "info" : "neutral"} value={money(cards.cash_in_overstock.value, currency)} sub={`${num(cards.cash_in_overstock.units)} units past ${cards.cash_in_overstock.overstock_days} days · at ${cards.cash_in_overstock.basis}`} onPress={() => openMetric("overstock", "Cash in overstock")} /> : null}
        {cards ? <KpiTile label="Revenue protected" icon="shield-checkmark-outline" toneName="success" value={money(cards.revenue_protected.value, currency)} sub={`${cards.revenue_protected.alerts} ${cards.revenue_protected.alerts === 1 ? "alert" : "alerts"} fixed · last ${cards.revenue_protected.period_days} days`} onPress={() => openMetric("protected", "Revenue protected")} /> : null}
      </Grid2>

      {dash.data?.units_sold_vs_forecast?.length ? (
        <>
          <SectionTitle>Units sold and forecast</SectionTitle>
          <Card>
            <Text style={[type.caption, { color: t.textSecondary, marginBottom: space.md }]}>
              Weekly units across all products: weeks already sold, then the forecast weeks.
            </Text>
            <WeeklyBars data={dash.data.units_sold_vs_forecast} />
            <Legend items={[{ color: t.chartHistory, label: "Sold" }, { color: t.chartForecast, label: "Forecast", dashed: true }]} />
          </Card>
        </>
      ) : dash.isPending ? (
        <>
          <SectionTitle>Units sold and forecast</SectionTitle>
          <Card><View style={{ height: 200, borderRadius: 12, backgroundColor: t.skeleton }} /></Card>
        </>
      ) : null}

      {dash.data?.running_low?.length ? (
        <>
          <SectionTitle>Running low</SectionTitle>
          <Card>
            <Text style={[type.caption, { color: t.textSecondary, marginBottom: space.md }]}>Days of stock left at the forecast rate. Tap one to open it.</Text>
            <HBars
              unit="days"
              max={Math.max(30, ...dash.data.running_low.map((r) => Number(r.cover_days) || 0))}
              onPress={(i) => { const r = dash.data!.running_low![i]; openProduct(r.variant_id, r.title); }}
              rows={dash.data.running_low.slice(0, 5).map((r) => ({
                label: r.title,
                value: Number(r.cover_days) || 0,
                color: tone(t, statusOf(r.status).tone).fg,
                note: `${statusOf(r.status).label}${r.runs_out_on ? ` · runs out ${dateLabel(r.runs_out_on)}` : ""}${r.sku ? ` · ${r.sku}` : ""}`,
              }))}
            />
          </Card>
        </>
      ) : null}

      {counts.untracked ? (
        <View style={{ marginTop: space.lg }}>
          <Notice icon="eye-off-outline" toneName="accent" title={`${counts.untracked} products are not stock-tracked`}>
            Their demand is forecast, but stock and run-out dates are unknown. Turn tracking on under {TRACKING_HINT[s.platform]}.
          </Notice>
        </View>
      ) : null}

      <SectionTitle
        action={
          <Pressable onPress={() => { haptic.tap(); setSortOpen(true); }} hitSlop={8} style={{ flexDirection: "row", alignItems: "center" }}>
            <Ionicons name="swap-vertical-outline" size={14} color={t.primary} style={{ marginRight: 4 }} />
            <Text style={[fw(600), { color: t.primary, fontSize: 12 }]}>Sort</Text>
          </Pressable>
        }
      >
        Products
      </SectionTitle>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.md }} contentContainerStyle={{ paddingRight: space.lg }}>
        {filters.map((f) => (
          <Chip key={f.key} label={f.label} count={f.count} active={filter === f.key} onPress={() => setFilter(f.key)} />
        ))}
      </ScrollView>
      <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: radius.md, paddingHorizontal: 12, marginBottom: space.md }}>
        <Ionicons name="search-outline" size={18} color={t.textMuted} />
        <TextInput
          style={[fw(400), { flex: 1, width: 0, color: t.text, paddingVertical: 11, paddingHorizontal: 8, fontSize: 15 }]}
          placeholder="Search by name or SKU"
          placeholderTextColor={t.textMuted}
          value={qInput}
          onChangeText={setQInput}
          autoCapitalize="none"
          returnKeyType="search"
        />
        {qInput ? <Pressable onPress={() => setQInput("")} hitSlop={8}><Ionicons name="close-circle" size={18} color={t.textMuted} /></Pressable> : null}
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
        keyExtractor={(r) => String(r.variant_id)}
        ListHeaderComponent={header}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, maxWidth: 760, width: "100%", alignSelf: "center" }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={t.primary} colors={[t.primary]} />}
        ListEmptyComponent={
          list.isLoading ? (
            <View style={{ gap: space.sm }}>{[0, 1, 2].map((i) => <View key={i} style={{ height: 120, borderRadius: radius.lg, backgroundColor: t.skeleton }} />)}</View>
          ) : list.isError ? (
            <Notice icon="cloud-offline-outline" toneName="danger" title="Could not load products">{(list.error as Error).message}</Notice>
          ) : (
            <View style={{ alignItems: "center", padding: space.xl }}>
              <Ionicons name="checkmark-circle-outline" size={28} color={t.success} />
              <Text style={[type.body, { color: t.textSecondary, marginTop: 6 }]}>{q ? `No products match "${q}".` : "No products in this view."}</Text>
            </View>
          )
        }
        renderItem={({ item }) => <ProductRow item={item} currency={currency} onPress={() => openProduct(item.variant_id, item.title)} />}
      />
      <OptionSheet title="Sort products" options={SORTS} value={sort} onSelect={setSort} visible={sortOpen} onClose={() => setSortOpen(false)} />
    </Screen>
  );
}

function ProductRow({ item, currency, onPress }: { item: ForecastRow; currency: string; onPress: () => void }) {
  const t = useTheme();
  const c = tone(t, statusOf(item.status).tone);
  const untracked = item.status === "untracked";
  const urgent = item.status === "reorder_now";
  const atRisk = Number(item.revenue_at_risk) || 0;
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
                {item.sku ? item.sku : "No SKU"} · {rate(item.forecast_per_day)}/day{item.supplier ? ` · ${item.supplier.name}` : ""}
              </Text>
            </View>
            <StatusBadge status={item.status} />
          </View>
          <View style={{ flexDirection: "row", marginTop: space.md, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: t.border }}>
            <Metric label="Stock" value={untracked ? "-" : num(item.on_hand)} sub={item.on_order ? `+${num(item.on_order)} on order` : undefined} />
            <Metric label="Cover" value={days(item.cover_days)} warn={urgent} />
            <Metric label="Runs out" value={dateLabel(item.runs_out_on)} warn={urgent} />
            <Metric label="Order" value={item.suggested_quantity ? num(item.suggested_quantity) : "-"} />
            <Metric label="At risk" value={atRisk > 0 ? money(atRisk, currency) : "-"} />
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

function Metric({ label, value, warn, sub }: { label: string; value: string; warn?: boolean; sub?: string }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1 }}>
      <Text style={[fw(600), { color: t.textMuted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }]} numberOfLines={1}>{label}</Text>
      <Text style={[fw(700), { color: warn ? t.danger : t.text, fontSize: 13, marginTop: 2 }]} numberOfLines={1}>{value}</Text>
      {sub ? <Text style={[fw(500), { color: t.textMuted, fontSize: 10 }]} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

/** "demo-goods.myshopify.com" -> "demo-goods"; other domains stay as they are. */
function storeName(domain: string) {
  return domain.replace(/\.myshopify\.com$/i, "");
}

function Screen({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>{children}</SafeAreaView>;
}
