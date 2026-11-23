import React, { useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { Text } from "../components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { api } from "../api/client";
import { warningText, type PurchaseOrder, type Supplier } from "../api/types";
import { Avatar, Button, Card, Chip, Notice, Pill, ScreenHeader, Segmented, Stat, StatusView, notify } from "../components/ui";
import { fw, radius, space, tone, ToneName, type, useTheme } from "../theme";
import { dateLabel, money, num } from "../utils/format";
import type { RootStackParamList } from "../navigation";
import { haptic } from "../utils/haptics";

export const PO_META: Record<string, { label: string; tone: ToneName; icon: React.ComponentProps<typeof Ionicons>["name"] }> = {
  draft: { label: "Draft", tone: "neutral", icon: "create-outline" },
  approved: { label: "Approved", tone: "primary", icon: "checkmark-circle-outline" },
  sent: { label: "Sent", tone: "info", icon: "paper-plane-outline" },
  partial: { label: "Part received", tone: "warning", icon: "cube-outline" },
  received: { label: "Received", tone: "success", icon: "checkmark-done-outline" },
  cancelled: { label: "Cancelled", tone: "danger", icon: "close-circle-outline" },
};
export const poMeta = (s: string) => PO_META[s] ?? PO_META.draft;

const PO_FILTERS = [
  { key: "draft,approved,sent,partial", label: "Open" },
  { key: "draft", label: "Drafts" },
  { key: "approved,sent,partial", label: "On the way" },
  { key: "received", label: "Received" },
  { key: "cancelled", label: "Cancelled" },
];

export function OrdersScreen() {
  const t = useTheme();
  const [tab, setTab] = useState<"orders" | "suppliers">("orders");
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg, maxWidth: 760, width: "100%", alignSelf: "center" }}>
        <ScreenHeader title="Orders" subtitle="Purchase orders and the suppliers behind them" />
        <Segmented options={[{ key: "orders", label: "Purchase orders" }, { key: "suppliers", label: "Suppliers" }]} value={tab} onChange={setTab} />
      </View>
      {tab === "orders" ? <PurchaseOrderList /> : <SupplierList />}
    </SafeAreaView>
  );
}

function PurchaseOrderList() {
  const t = useTheme();
  const qc = useQueryClient();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [filter, setFilter] = useState(PO_FILTERS[0].key);
  const pos = useQuery({ queryKey: ["purchaseOrders", filter], queryFn: () => api.purchaseOrders(filter) });
  const store = useQuery({ queryKey: ["store"], queryFn: api.store });
  const currency = store.data?.currency || "USD";
  const refresh = useMutation({
    mutationFn: api.refreshDrafts,
    onSuccess: (r) => {
      haptic.success();
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      notify("Drafts updated", `${r.created} created, ${r.updated} updated, ${r.removed} removed from the latest forecast.`);
    },
    onError: (e: any) => notify("Could not update drafts", e?.message),
  });

  const items = pos.data?.data ?? [];
  const totalOpen = items.reduce((a, p) => a + (Number(p.total) || 0), 0);

  return (
    <FlatList
      data={items}
      keyExtractor={(p) => String(p.id)}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, maxWidth: 760, width: "100%", alignSelf: "center" }}
      refreshControl={<RefreshControl refreshing={pos.isRefetching} onRefresh={() => { pos.refetch(); }} tintColor={t.primary} colors={[t.primary]} />}
      ListHeaderComponent={
        <View>
          <FlatList
            horizontal
            data={PO_FILTERS}
            keyExtractor={(f) => f.key}
            showsHorizontalScrollIndicator={false}
            style={{ marginBottom: space.md }}
            renderItem={({ item: f }) => <Chip label={f.label} active={filter === f.key} onPress={() => setFilter(f.key)} />}
          />
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: space.md }}>
            <Text style={[type.caption, { color: t.textSecondary, flex: 1 }]}>
              {items.length ? `${items.length} ${items.length === 1 ? "order" : "orders"} · ${money(totalOpen, currency)}` : " "}
            </Text>
            <Button title="Refresh drafts" icon="sparkles-outline" variant="secondary" small onPress={() => refresh.mutate()} loading={refresh.isPending} />
          </View>
          {pos.isError ? <Notice icon="cloud-offline-outline" toneName="danger" title="Could not load orders">{(pos.error as Error).message}</Notice> : null}
        </View>
      }
      ListEmptyComponent={
        pos.isPending ? (
          <View style={{ gap: space.sm }}>{[0, 1, 2].map((i) => <View key={i} style={{ height: 110, borderRadius: radius.lg, backgroundColor: t.skeleton }} />)}</View>
        ) : pos.isError ? undefined : (
          <StatusView icon="document-text-outline" title="No orders here" body="Drafts appear automatically for products that need reordering. You can also create one from a product's Reorder button." />
        )
      }
      renderItem={({ item }) => <PoCard po={item} onPress={() => { haptic.tap(); nav.navigate("PurchaseOrder", { id: item.id, title: item.number }); }} />}
    />
  );
}

function PoCard({ po, onPress }: { po: PurchaseOrder; onPress: () => void }) {
  const t = useTheme();
  const m = poMeta(po.status);
  const c = tone(t, m.tone);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
      <Card style={{ marginBottom: space.sm, padding: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: c.bg, alignItems: "center", justifyContent: "center", marginRight: space.md }}>
            <Ionicons name={m.icon} size={19} color={c.fg} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={[type.bodyStrong, { color: t.text }]}>{po.number}</Text>
              {po.automatic ? <Pill toneName="accent" icon="sparkles-outline">Auto</Pill> : null}
            </View>
            <Text style={[type.caption, { color: t.textSecondary }]} numberOfLines={1}>{po.supplier?.name ?? "No supplier"}{po.location ? ` · to ${po.location.name}` : ""}</Text>
          </View>
          <Pill toneName={m.tone}>{m.label}</Pill>
        </View>
        <View style={{ flexDirection: "row", marginTop: space.md, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: t.border }}>
          <Stat label="Products" value={num(po.line_count)} />
          <Stat label="Units" value={num(po.units)} />
          <Stat label="Total" value={money(po.total, po.currency)} />
          <Stat label={po.status === "received" ? "Received" : "Expected"} value={dateLabel(po.status === "received" ? po.received_at : po.expected_at)} />
        </View>
        {po.warnings?.length ? <Text style={[type.caption, { color: t.warning, marginTop: 6 }]} numberOfLines={2}>{warningText(po.warnings[0])}</Text> : null}
      </Card>
    </Pressable>
  );
}

function SupplierList() {
  const t = useTheme();
  const sup = useQuery({ queryKey: ["suppliers"], queryFn: api.suppliers });
  const items = sup.data?.data ?? [];
  return (
    <FlatList
      data={items}
      keyExtractor={(s) => String(s.id)}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, maxWidth: 760, width: "100%", alignSelf: "center" }}
      refreshControl={<RefreshControl refreshing={sup.isRefetching} onRefresh={() => { sup.refetch(); }} tintColor={t.primary} colors={[t.primary]} />}
      ListHeaderComponent={sup.isError ? <Notice icon="cloud-offline-outline" toneName="danger" title="Could not load suppliers">{(sup.error as Error).message}</Notice> : undefined}
      ListEmptyComponent={
        sup.isPending ? (
          <View style={{ gap: space.sm }}>{[0, 1].map((i) => <View key={i} style={{ height: 140, borderRadius: radius.lg, backgroundColor: t.skeleton }} />)}</View>
        ) : sup.isError ? undefined : (
          <StatusView icon="business-outline" title="No suppliers yet" body="Add suppliers through the API or WhatsApp (Add a supplier). Products are matched to them by vendor or category." />
        )
      }
      renderItem={({ item }) => <SupplierCard s={item} />}
    />
  );
}

function SupplierCard({ s }: { s: Supplier }) {
  const t = useTheme();
  const lt = s.lead_time_effective_days ?? s.lead_time_days;
  const trend = s.lead_time_trend === "slower" ? { tone: "warning" as const, text: "getting slower" } : s.lead_time_trend === "faster" ? { tone: "success" as const, text: "getting faster" } : null;
  const pct = (v: number | null | undefined) => (v == null ? "-" : `${Math.round(v * 100)}%`);
  return (
    <Card style={{ marginBottom: space.sm, padding: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Avatar name={s.name} size={38} />
        <View style={{ flex: 1, marginLeft: space.md }}>
          <Text style={[type.bodyStrong, { color: t.text }]}>{s.name}</Text>
          <Text style={[type.caption, { color: t.textSecondary }]} numberOfLines={1}>
            {[s.contact_name, s.email, s.payment_terms].filter(Boolean).join(" · ") || "No contact details"}
          </Text>
        </View>
        {trend ? <Pill toneName={trend.tone} icon={trend.tone === "warning" ? "trending-down-outline" : "trending-up-outline"}>{trend.text}</Pill> : null}
      </View>
      <View style={{ flexDirection: "row", marginTop: space.md, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: t.border }}>
        <Stat label="Lead time" value={`${Math.round(lt)} d`} sub={s.deliveries_90d ? `${s.deliveries_90d} recent` : "as entered"} />
        <Stat label="On time" value={pct(s.scorecard?.on_time_rate)} />
        <Stat label="Fill rate" value={pct(s.scorecard?.fill_rate)} />
        <Stat label="Products" value={num(s.product_count)} />
      </View>
      {s.vendors.length || s.categories.length ? (
        <Text style={[type.caption, { color: t.textMuted, marginTop: 8 }]} numberOfLines={2}>
          Supplies {[...s.vendors, ...s.categories].join(", ")}
          {s.min_order_value ? ` · minimum order ${money(s.min_order_value, s.currency)}` : ""}
        </Text>
      ) : null}
    </Card>
  );
}
