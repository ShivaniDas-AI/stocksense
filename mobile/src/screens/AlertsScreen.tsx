import React from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { RiskBadge, StatusView } from "../components/ui";
import { colors, radius, space } from "../theme";

export function AlertsScreen() {
  const qc = useQueryClient();
  const alerts = useQuery({ queryKey: ["alerts"], queryFn: api.alerts });
  const ack = useMutation({
    mutationFn: (id: string) => api.ackAlert(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Text style={styles.heading}>Alerts</Text>
      {alerts.isError ? (
        <StatusView title="Could not load alerts" body={(alerts.error as Error).message} error />
      ) : (
        <FlatList
          data={alerts.data?.items ?? []}
          keyExtractor={(a) => a.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={alerts.isFetching} onRefresh={() => { alerts.refetch(); }} tintColor={colors.green} />}
          ListEmptyComponent={
            alerts.isLoading ? undefined : (
              <Text style={styles.empty}>No alerts yet. The daily digest logs critical and low-stock items here.</Text>
            )
          }
          renderItem={({ item }) => (
            <View style={[styles.row, item.acknowledged && { opacity: 0.55 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.sub}>
                  {item.sku ? `${item.sku} · ` : ""}
                  {new Date(item.sent_at).toLocaleString()}
                </Text>
                <View style={{ marginTop: 6 }}>
                  <RiskBadge level={item.risk_level} />
                </View>
              </View>
              {!item.acknowledged ? (
                <Pressable onPress={() => ack.mutate(item.id)} style={styles.ack}>
                  <Text style={styles.ackText}>Got it</Text>
                </Pressable>
              ) : (
                <Text style={styles.done}>seen</Text>
              )}
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  heading: { color: colors.text, fontSize: 20, fontWeight: "800", paddingHorizontal: space.lg, paddingTop: space.md },
  list: { padding: space.lg },
  row: {
    flexDirection: "row", alignItems: "center", backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: radius.md, padding: space.md, marginBottom: space.sm,
  },
  title: { color: colors.text, fontWeight: "700" },
  sub: { color: colors.dim, fontSize: 11, marginTop: 2 },
  ack: { borderWidth: 1, borderColor: colors.green, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 8 },
  ackText: { color: colors.green, fontWeight: "700", fontSize: 12 },
  done: { color: colors.dim, fontSize: 12 },
  empty: { color: colors.dim, textAlign: "center", padding: space.xl, lineHeight: 20 },
});
