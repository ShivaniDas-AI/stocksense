import React, { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button, Card, Input } from "../components/ui";
import { colors, radius, space } from "../theme";
import type { RootStackParamList } from "../navigation";
import { DEFAULT_API_URL } from "../config";

const PLATFORM = { shopify: "Shopify", bigcommerce: "BigCommerce", woocommerce: "WooCommerce" } as const;

export function SettingsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { apiUrl, setApiUrl, signIn, signOut } = useAuth();
  const qc = useQueryClient();
  const [url, setUrl] = useState(apiUrl);
  const [urlMsg, setUrlMsg] = useState<string | null>(null);

  const stores = useQuery({ queryKey: ["stores"], queryFn: api.stores });
  const switchStore = useMutation({
    mutationFn: (id: string) => api.switchStore(id),
    onSuccess: async (r) => {
      await signIn(r.token);
      qc.clear();
    },
  });

  async function saveUrl() {
    setUrlMsg(null);
    try {
      await setApiUrl(url);
      await api.health();
      setUrlMsg("Server reachable.");
      qc.clear();
    } catch (e: any) {
      setUrlMsg(e?.message || "Could not reach that server.");
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.heading}>Settings</Text>

        <Text style={styles.section}>Stores on this phone</Text>
        <Card>
          {(stores.data?.stores ?? []).map((s) => {
            const active = String(s.id) === String(stores.data?.active);
            return (
              <Pressable key={s.id} onPress={() => !active && switchStore.mutate(s.id)} style={[styles.storeRow, active && styles.storeRowOn]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.storeName}>{s.store_domain}</Text>
                  <Text style={styles.storeSub}>{PLATFORM[s.platform]}</Text>
                </View>
                <Text style={[styles.storeState, active && { color: colors.green }]}>{active ? "active" : "switch"}</Text>
              </Pressable>
            );
          })}
          {stores.isError ? <Text style={styles.err}>{(stores.error as Error).message}</Text> : null}
          <View style={{ marginTop: space.sm }}>
            <Button title="+ Add another store" variant="ghost" onPress={() => nav.navigate("Connect")} />
          </View>
        </Card>

        <Text style={styles.section}>Server</Text>
        <Card>
          <Input label="API base URL" value={url} onChangeText={setUrl} keyboardType="url" placeholder={DEFAULT_API_URL} />
          <Text style={styles.hint}>
            Today this is the ngrok tunnel to the Docker server on your laptop. Change it when the server moves to a permanent domain.
          </Text>
          {urlMsg ? <Text style={[styles.hint, { color: urlMsg.startsWith("Server") ? colors.green : colors.red }]}>{urlMsg}</Text> : null}
          <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm }}>
            <View style={{ flex: 1 }}><Button title="Save & test" onPress={saveUrl} /></View>
            <View style={{ flex: 1 }}><Button title="Reset" variant="ghost" onPress={() => setUrl(DEFAULT_API_URL)} /></View>
          </View>
        </Card>

        <View style={{ marginTop: space.xl }}>
          <Button
            title="Log out of this phone"
            variant="danger"
            onPress={() =>
              Alert.alert("Log out?", "The store stays connected on the server. You can reconnect with the same token.", [
                { text: "Cancel", style: "cancel" },
                { text: "Log out", style: "destructive", onPress: () => { qc.clear(); signOut(); } },
              ])
            }
          />
        </View>
        <Text style={styles.footer}>StockSense · AI inventory forecasting</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  body: { padding: space.lg, paddingBottom: space.xl * 2 },
  heading: { color: colors.text, fontSize: 20, fontWeight: "800", marginBottom: space.md },
  section: { color: colors.dim, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6, marginTop: space.md },
  storeRow: { flexDirection: "row", alignItems: "center", padding: space.sm, borderRadius: radius.sm, marginBottom: 4 },
  storeRowOn: { backgroundColor: colors.panel2 },
  storeName: { color: colors.text, fontWeight: "600" },
  storeSub: { color: colors.dim, fontSize: 11 },
  storeState: { color: colors.dim, fontSize: 12 },
  hint: { color: colors.dim, fontSize: 11, lineHeight: 16 },
  err: { color: colors.red, fontSize: 12 },
  footer: { color: colors.dim, fontSize: 11, textAlign: "center", marginTop: space.xl },
});
