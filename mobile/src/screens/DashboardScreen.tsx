import React, { useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { api } from "../api/client";
import type { RiskItem } from "../api/types";
import { Button, Chip, Notice, RiskBadge, Stat, StatusView } from "../components/ui";
import { colors, radius, space } from "../theme";
import { dateLabel, days, money, num, rate } from "../utils/format";
import type { RootStackParamList } from "../navigation";
import { useAuth } from "../auth/AuthContext";

const PLATFORM = { shopify: "Shopify", bigcommerce: "BigCommerce", woocommerce: "WooCommerce" } as const;
const TRACKING_HINT = {
  shopify: "Shopify admin › Products › Inventory › Track quantity",
  bigcommerce: "BigCommerce › Products › Inventory › Track inventory",
  woocommerce: "WooCommerce › Products › Inventory › Manage stock",
} as const;

const LEVELS: { key: string; label: string }[] = [
  { key: "critical,low_stock", label: "At risk" },
  { key: "critical", label: "Critical" },
  { key: "healthy", label: "Healthy" },
  { key: "overstocked", label: "Overstocked" },
  { key: "untracked", label: "Untracked" },
  { key: "critical,low_stock,healthy,overstocked,no_demand,untracked", label: "All" },
];

export function DashboardScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { signOut } = useAuth();
  const [level, setLevel] = useState(LEVELS[0].key);
  const [q, setQ] = useState("");

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

  const risks = useQuery({
    queryKey: ["risks", level, q],
    queryFn: () => api.risks(level, q),
    enabled: hasForecast,
  });

  const currency = store.data?.currency || "USD";
  const refreshing = store.isFetching || summary.isFetching || risks.isFetching;
  const refresh = () => {
    store.refetch();
    summary.refetch();
    risks.refetch();
  };

  const showUntrackedChip = (summary.data?.untracked ?? 0) > 0;
  const chips = useMemo(() => LEVELS.filter((l) => l.key !== "untracked" || showUntrackedChip), [showUntrackedChip]);

  /* ---------- status screens ---------- */
  if (store.isLoading) return <Screen><StatusView title="Loading..." spinner /></Screen>;
  if (store.isError) {
    const status = (store.error as any)?.status;
    return (
      <Screen>
        <StatusView
          title={status === 401 ? "Session expired" : "Cannot reach the server"}
          body={(store.error as Error).message}
          error
          action={
            status === 401 ? (
              <Button title="Connect again" onPress={signOut} />
            ) : (
              <Button title="Retry" onPress={() => store.refetch()} variant="ghost" />
            )
          }
        />
      </Screen>
    );
  }
  const s = store.data!;
  if (s.sync_status === "error") {
    return (
      <Screen>
        <StatusView title="Store sync failed" body={s.sync_error || "The store could not be synced. Check the credentials and connect again."} error
          action={<Button title="Connect again" onPress={signOut} variant="ghost" />} />
      </Screen>
    );
  }
  if (s.sync_status === "uninstalled") {
    return <Screen><StatusView title="Store disconnected" body="The app was uninstalled from the store. Connect it again to resume forecasting." error /></Screen>;
  }
  if (!ready) {
    return <Screen><StatusView title="Syncing your store..." body="Pulling products, inventory and order history. This usually takes under a minute." spinner /></Screen>;
  }
  if (summary.isLoading) return <Screen><StatusView title="Loading forecast..." spinner /></Screen>;
  if (summary.data && !summary.data.ready) {
    const job = summary.data.forecast_job;
    if (job === "queued" || job === "running")
      return <Screen><StatusView title="Store synced. Running your first forecast..." body="This takes a minute or two." spinner /></Screen>;
    if (job === "error")
      return <Screen><StatusView title="Forecast failed" body={summary.data.forecast_error || "The forecast worker reported an error."} error /></Screen>;
    if (job === "done" && !summary.data.has_sales)
      return <Screen><StatusView title="No orders found" body="StockSense forecasts from your order history, and this store has no paid orders in the last 18 months. Once orders come in they are picked up within minutes." /></Screen>;
    return <Screen><StatusView title="Store synced" body="Waiting for the first forecast run (nightly at 02:00 UTC)." spinner /></Screen>;
  }

  /* ---------- dashboard ---------- */
  const sm = summary.data!;
  const header = (
    <View>
      <View style={styles.storeRow}>
        <Text style={styles.storeName} numberOfLines={1}>
          {PLATFORM[s.platform]} · {s.store_domain}
        </Text>
        {sm.run_date ? <Text style={styles.pill}>forecast {dateLabel(sm.run_date)}</Text> : null}
      </View>

      {sm.untracked ? (
        <Notice>
          <Text style={{ color: colors.text }}>{sm.untracked} of {sm.skus_forecasted} forecasted products</Text> have inventory tracking turned off in{" "}
          {PLATFORM[s.platform]}, so their stock and stockout date are unknown. Turn it on under {TRACKING_HINT[s.platform]}.
        </Notice>
      ) : null}

      <View style={styles.cards}>
        <Stat label="SKUs tracked" value={num(sm.skus_tracked)} sub={sm.untracked ? `${sm.untracked} untracked` : "8-week forecast"} />
        <Stat label="At risk" value={num(sm.at_risk)} sub={`${sm.critical} critical · ${sm.low_stock} low`} color={colors.amber} />
        <Stat label="Critical" value={num(sm.critical)} sub="before reorder arrives" color={colors.red} />
        <Stat label="Revenue at risk" value={money(sm.revenue_at_risk, currency)} sub="next 8 weeks" color={colors.green} />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.sm }}>
        {chips.map((c) => (
          <Chip key={c.key} label={c.label} active={level === c.key} onPress={() => setLevel(c.key)} />
        ))}
      </ScrollView>
      <TextInput
        style={styles.search}
        placeholder="Search by name or SKU..."
        placeholderTextColor={colors.dim}
        value={q}
        onChangeText={setQ}
        autoCapitalize="none"
      />
    </View>
  );

  return (
    <Screen>
      <FlatList
        data={risks.data?.items ?? []}
        keyExtractor={(r) => r.variant_id}
        ListHeaderComponent={header}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.green} />}
        ListEmptyComponent={
          risks.isLoading ? undefined : <Text style={styles.empty}>No SKUs in this view.</Text>
        }
        renderItem={({ item }) => (
          <RiskRow item={item} currency={currency} onPress={() => nav.navigate("Product", { id: item.variant_id, title: item.title })} />
        )}
      />
    </Screen>
  );
}

function RiskRow({ item, currency, onPress }: { item: RiskItem; currency: string; onPress: () => void }) {
  const untracked = item.risk_level === "untracked";
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.panel2 }]}>
      <View style={styles.rowTop}>
        <View style={{ flex: 1, marginRight: space.sm }}>
          <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
          {item.sku ? <Text style={styles.sku}>{item.sku}</Text> : null}
        </View>
        <RiskBadge level={item.risk_level} />
      </View>
      <View style={styles.metrics}>
        <Metric label="Stock" value={untracked ? "unknown" : num(item.current_stock)} />
        <Metric label="Avg/day" value={rate(item.avg_daily_demand)} />
        <Metric label="Cover" value={days(item.days_of_stock)} />
        <Metric label="Stockout" value={dateLabel(item.stockout_date)} />
        <Metric label="Reorder" value={num(item.reorder_qty)} />
        <Metric label="At risk" value={Number(item.revenue_at_risk) > 0 ? money(item.revenue_at_risk, currency) : "-"} />
      </View>
    </Pressable>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top"]}>{children}</SafeAreaView>;
}

const styles = StyleSheet.create({
  list: { padding: space.lg, paddingBottom: space.xl * 2 },
  storeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: space.md },
  storeName: { color: colors.text, fontWeight: "700", flex: 1, marginRight: space.sm },
  pill: { color: colors.green, fontSize: 11, borderWidth: 1, borderColor: colors.greenDim, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  cards: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.md },
  search: {
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
    color: colors.text, paddingHorizontal: 12, paddingVertical: 9, marginBottom: space.md,
  },
  row: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, padding: space.md, marginBottom: space.sm },
  rowTop: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  title: { color: colors.text, fontWeight: "700" },
  sku: { color: colors.dim, fontSize: 11, marginTop: 2 },
  metrics: { flexDirection: "row", flexWrap: "wrap", marginTop: space.sm, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space.sm },
  metric: { width: "33.33%", paddingVertical: 3 },
  metricLabel: { color: colors.dim, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 },
  metricValue: { color: colors.text, fontSize: 13, fontWeight: "600" },
  empty: { color: colors.dim, textAlign: "center", padding: space.xl },
});
