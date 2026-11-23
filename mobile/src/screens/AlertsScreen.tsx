import React, { useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { Text } from "../components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { api } from "../api/client";
import type { AlertV1 } from "../api/types";
import { Button, Card, Notice, Pill, ScreenHeader, Segmented, StatusView, notify } from "../components/ui";
import { fw, radius, space, tone, ToneName, type, useTheme } from "../theme";
import { money } from "../utils/format";
import type { RootStackParamList } from "../navigation";
import { haptic } from "../utils/haptics";

type IconName = React.ComponentProps<typeof Ionicons>["name"];
const TYPE: Record<string, { label: string; icon: IconName; tone: ToneName }> = {
  stockout_risk: { label: "Stockout risk", icon: "alert-circle", tone: "danger" },
  reorder_point: { label: "Reorder point", icon: "cart", tone: "warning" },
  velocity_shift: { label: "Sales speed change", icon: "speedometer", tone: "primary" },
  lead_time_drift: { label: "Lead time change", icon: "time", tone: "accent" },
  overstock: { label: "Overstock", icon: "layers", tone: "info" },
};
const typeOf = (k: string) => TYPE[k] ?? { label: k.replace(/_/g, " "), icon: "notifications" as IconName, tone: "neutral" as ToneName };

type Tab = "open" | "resolved" | "dismissed";

function when(iso: string) {
  const d = new Date(iso);
  const diff = Math.round((Date.now() - d.getTime()) / 3600000);
  if (diff < 1) return "just now";
  if (diff < 24) return `${diff} h ago`;
  const days = Math.round(diff / 24);
  return days < 7 ? `${days} d ago` : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function AlertsScreen() {
  const t = useTheme();
  const qc = useQueryClient();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [tab, setTab] = useState<Tab>("open");
  const alerts = useQuery({ queryKey: ["alertsV1", tab], queryFn: () => api.alertsV1(tab) });
  const openCount = useQuery({ queryKey: ["alertsV1", "open"], queryFn: () => api.alertsV1("open"), enabled: tab !== "open" });
  const store = useQuery({ queryKey: ["store"], queryFn: api.store });
  const currency = store.data?.currency || "USD";

  const act = useMutation({
    mutationFn: ({ id, action }: { id: number; action: "dismiss" | "reopen" }) => api.alertAction(id, action),
    onSuccess: () => { haptic.success(); qc.invalidateQueries({ queryKey: ["alertsV1"] }); },
    onError: (e: any) => notify("That did not work", e?.message),
  });
  const check = useMutation({
    mutationFn: api.checkAlerts,
    onSuccess: () => { haptic.success(); qc.invalidateQueries({ queryKey: ["alertsV1"] }); },
    onError: (e: any) => notify("Could not check alerts", e?.message),
  });

  const items = alerts.data?.data ?? [];
  const open = tab === "open" ? alerts.data?.total ?? 0 : openCount.data?.total ?? 0;
  const urgent = tab === "open" ? items.filter((a) => a.urgent).length : 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <FlatList
        data={items}
        keyExtractor={(a) => String(a.id)}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, maxWidth: 760, width: "100%", alignSelf: "center", flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={alerts.isRefetching} onRefresh={() => { alerts.refetch(); }} tintColor={t.primary} colors={[t.primary]} />}
        ListHeaderComponent={
          <View>
            <ScreenHeader
              title="Alerts"
              subtitle={open ? `${open} open${urgent ? ` · ${urgent} urgent` : ""}` : "Nothing needs attention"}
              right={<Button title="Check now" small variant="secondary" icon="refresh" onPress={() => check.mutate()} loading={check.isPending} />}
            />
            <View style={{ marginBottom: space.md }}>
              <Segmented options={[{ key: "open", label: "Open", count: open }, { key: "resolved", label: "Resolved" }, { key: "dismissed", label: "Dismissed" }]} value={tab} onChange={setTab} />
            </View>
            {alerts.isError ? <Notice icon="cloud-offline-outline" toneName="danger" title="Could not load alerts">{(alerts.error as Error).message}</Notice> : null}
          </View>
        }
        ListEmptyComponent={
          alerts.isPending ? (
            <View style={{ gap: space.sm }}>{[0, 1, 2].map((i) => <View key={i} style={{ height: 130, borderRadius: radius.lg, backgroundColor: t.skeleton }} />)}</View>
          ) : alerts.isError ? undefined : (
            <StatusView
              icon={tab === "open" ? "checkmark-done-circle-outline" : "archive-outline"}
              toneName={tab === "open" ? "success" : "neutral"}
              title={tab === "open" ? "All clear" : tab === "resolved" ? "No resolved alerts yet" : "No dismissed alerts"}
              body={tab === "open" ? "Alerts open here when a product is at risk of running out, passes its reorder point, sells unusually fast or slow, has a slower supplier, or is overstocked." : "Alerts close on their own when the problem is fixed, for example after an order arrives."}
            />
          )
        }
        renderItem={({ item }) => (
          <AlertCard
            a={item}
            currency={currency}
            busy={act.isPending && act.variables?.id === item.id}
            onOpen={item.product ? () => { haptic.tap(); nav.navigate("Product", { id: String(item.product!.variant_id), title: item.product!.title }); } : undefined}
            onDismiss={() => act.mutate({ id: item.id, action: "dismiss" })}
            onReopen={() => act.mutate({ id: item.id, action: "reopen" })}
          />
        )}
      />
    </SafeAreaView>
  );
}

function AlertCard({ a, currency, busy, onOpen, onDismiss, onReopen }: { a: AlertV1; currency: string; busy: boolean; onOpen?: () => void; onDismiss: () => void; onReopen: () => void }) {
  const t = useTheme();
  const m = typeOf(a.type);
  const c = tone(t, m.tone);
  return (
    <Card style={{ marginBottom: space.sm, padding: 0, overflow: "hidden", opacity: a.status === "open" ? 1 : 0.85 }}>
      <Pressable onPress={onOpen} disabled={!onOpen} style={({ pressed }) => ({ padding: space.md, opacity: pressed ? 0.8 : 1 })}>
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
          <View style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: c.bg, alignItems: "center", justifyContent: "center", marginRight: 10 }}>
            <Ionicons name={m.icon} size={16} color={c.fg} />
          </View>
          <Text style={[fw(700), { color: c.fg, fontSize: 12, flex: 1, textTransform: "uppercase", letterSpacing: 0.4 }]}>{m.label}</Text>
          {a.urgent && a.status === "open" ? <Pill toneName="danger">Urgent</Pill> : null}
          <Text style={[type.caption, { color: t.textMuted, marginLeft: 8 }]}>{when(a.status === "resolved" && a.resolved_at ? a.resolved_at : a.opened_at)}</Text>
        </View>
        <Text style={[type.bodyStrong, { color: t.text }]}>{a.title}</Text>
        <Text style={[type.caption, { color: t.textSecondary, marginTop: 4 }]}>{a.message}</Text>
        {a.what_to_do && a.status === "open" ? (
          <View style={{ flexDirection: "row", alignItems: "flex-start", marginTop: 8, backgroundColor: t.surfaceAlt, borderRadius: radius.sm, padding: 8 }}>
            <Ionicons name="bulb-outline" size={14} color={t.primary} style={{ marginRight: 6, marginTop: 2 }} />
            <Text style={[type.caption, { color: t.text, flex: 1 }]}>{a.what_to_do}</Text>
          </View>
        ) : null}
        {a.status === "resolved" ? (
          <Text style={[type.caption, { color: t.success, marginTop: 6 }]}>
            Resolved{a.resolved_by_purchase_order ? ` by ${a.resolved_by_purchase_order.number}` : " automatically"}
          </Text>
        ) : null}
      </Pressable>
      <View style={{ flexDirection: "row", alignItems: "center", borderTopWidth: 1, borderTopColor: t.border, paddingHorizontal: space.md, paddingVertical: 8 }}>
        <Text style={[type.caption, { color: a.revenue_at_risk ? t.danger : t.textMuted, flex: 1 }]}>
          {a.revenue_at_risk ? `${money(a.revenue_at_risk, currency)} at risk` : a.product?.sku ?? ""}
        </Text>
        {a.status === "open" ? (
          <Button title="Dismiss" small variant="secondary" onPress={onDismiss} loading={busy} />
        ) : a.status === "dismissed" ? (
          <Button title="Reopen" small variant="secondary" onPress={onReopen} loading={busy} />
        ) : null}
        {onOpen ? <Button title="Open" small onPress={onOpen} style={{ marginLeft: 8 }} /> : null}
      </View>
    </Card>
  );
}
