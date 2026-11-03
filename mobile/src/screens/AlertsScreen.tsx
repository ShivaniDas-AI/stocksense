import React, { useMemo } from "react";
import { Pressable, RefreshControl, SectionList, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { AlertItem } from "../api/types";
import { Card, RiskBadge, ScreenHeader, StatusView } from "../components/ui";
import { fw, radius, riskMeta, space, tone, type, useTheme } from "../theme";
import { haptic } from "../utils/haptics";

function groupLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.floor((start.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "This week";
  return "Earlier";
}

export function AlertsScreen() {
  const t = useTheme();
  const qc = useQueryClient();
  const alerts = useQuery({ queryKey: ["alerts"], queryFn: api.alerts });
  const ack = useMutation({
    mutationFn: (id: string) => api.ackAlert(id),
    onSuccess: () => { haptic.success(); qc.invalidateQueries({ queryKey: ["alerts"] }); },
  });
  const items = alerts.data?.items ?? [];
  const open = items.filter((a) => !a.acknowledged).length;

  const sections = useMemo(() => {
    const order = ["Today", "Yesterday", "This week", "Earlier"];
    const by: Record<string, AlertItem[]> = {};
    for (const a of items) (by[groupLabel(a.sent_at)] ||= []).push(a);
    return order.filter((k) => by[k]?.length).map((k) => ({ title: k, data: by[k] }));
  }, [items]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      {alerts.isError ? (
        <StatusView icon="alert-circle-outline" toneName="danger" title="Could not load alerts" body={(alerts.error as Error).message} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(a) => a.id}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}
          ListHeaderComponent={<ScreenHeader title="Alerts" subtitle={open ? `${open} need attention` : "All caught up"} />}
          refreshControl={<RefreshControl refreshing={alerts.isFetching} onRefresh={() => { haptic.tap(); alerts.refetch(); }} tintColor={t.primary} colors={[t.primary]} />}
          renderSectionHeader={({ section }) => (
            <Text style={[type.label, { color: t.textMuted, marginTop: space.md, marginBottom: space.sm }]}>{section.title}</Text>
          )}
          ListEmptyComponent={
            alerts.isPending ? undefined : (
              <StatusView icon="notifications-off-outline" toneName="success" title="No alerts yet" body="The daily digest logs critical and low-stock products here, once a day, so you are not alerted twice for the same item." />
            )
          }
          renderItem={({ item }) => {
            const meta = riskMeta[item.risk_level] ?? riskMeta.no_demand;
            const c = tone(t, meta.tone);
            return (
              <Card style={{ padding: space.md, marginBottom: space.sm, flexDirection: "row", alignItems: "center", opacity: item.acknowledged ? 0.55 : 1 }}>
                <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: c.bg, alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                  <Ionicons name={item.risk_level === "critical" ? "alert" : "warning-outline"} size={19} color={c.fg} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>{item.title}</Text>
                  <Text style={[type.caption, { color: t.textMuted }]} numberOfLines={1}>
                    {item.sku ? `${item.sku} · ` : ""}{new Date(item.sent_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </Text>
                  <View style={{ marginTop: 6 }}><RiskBadge level={item.risk_level} /></View>
                </View>
                {item.acknowledged ? (
                  <Ionicons name="checkmark-circle" size={22} color={t.success} />
                ) : (
                  <Pressable onPress={() => { haptic.tap(); ack.mutate(item.id); }} style={{ borderWidth: 1, borderColor: t.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8 }}>
                    <Text style={[fw(700), { color: t.primary, fontSize: 13 }]}>Dismiss</Text>
                  </Pressable>
                )}
              </Card>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
