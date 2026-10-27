import React, { useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button, Card, Input, Row, ScreenHeader, SectionTitle } from "../components/ui";
import { space, type, useTheme } from "../theme";
import type { RootStackParamList } from "../navigation";
import { DEFAULT_API_URL } from "../config";

const PLATFORM = { shopify: "Shopify", bigcommerce: "BigCommerce", woocommerce: "WooCommerce" } as const;

export function SettingsScreen() {
  const t = useTheme();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { apiUrl, setApiUrl, signIn, signOut } = useAuth();
  const qc = useQueryClient();
  const [url, setUrl] = useState(apiUrl);
  const [urlMsg, setUrlMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const stores = useQuery({ queryKey: ["stores"], queryFn: api.stores });
  const switchStore = useMutation({
    mutationFn: (id: string) => api.switchStore(id),
    onSuccess: async (r) => { await signIn(r.token); qc.clear(); },
  });

  async function saveUrl() {
    setUrlMsg(null);
    setTesting(true);
    try {
      await setApiUrl(url);
      await api.health();
      setUrlMsg({ ok: true, text: "Server reachable." });
      qc.clear();
    } catch (e: any) {
      setUrlMsg({ ok: false, text: e?.message || "Could not reach that server." });
    } finally {
      setTesting(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
        <ScreenHeader title="Settings" />

        <SectionTitle>Stores on this phone</SectionTitle>
        <Card style={{ paddingVertical: 4 }}>
          {(stores.data?.stores ?? []).map((s, i, arr) => {
            const active = String(s.id) === String(stores.data?.active);
            return (
              <Row
                key={s.id}
                icon="storefront-outline"
                toneName={active ? "primary" : "neutral"}
                title={s.store_domain}
                subtitle={PLATFORM[s.platform]}
                onPress={active ? undefined : () => switchStore.mutate(s.id)}
                right={active ? <Ionicons name="checkmark-circle" size={20} color={t.primary} /> : <Text style={[type.caption, { color: t.primary, fontWeight: "700" }]}>Switch</Text>}
                last={i === arr.length - 1 && false}
              />
            );
          })}
          {stores.isError ? <Text style={[type.caption, { color: t.danger, paddingVertical: 8 }]}>{(stores.error as Error).message}</Text> : null}
          <Row icon="add-circle-outline" toneName="primary" title="Add another store" subtitle="Connect a second Shopify, BigCommerce or WooCommerce store" onPress={() => nav.navigate("Connect")} last />
        </Card>

        <SectionTitle>Server</SectionTitle>
        <Card>
          <Input
            label="API base URL"
            value={url}
            onChangeText={setUrl}
            keyboardType="url"
            placeholder={DEFAULT_API_URL}
            hint="Currently the ngrok tunnel to the Docker server on your laptop. Change it once the server has a permanent domain."
            error={urlMsg && !urlMsg.ok ? urlMsg.text : null}
          />
          {urlMsg?.ok ? (
            <View style={{ flexDirection: "row", alignItems: "center", marginBottom: space.md }}>
              <Ionicons name="checkmark-circle" size={16} color={t.success} style={{ marginRight: 6 }} />
              <Text style={[type.caption, { color: t.success }]}>{urlMsg.text}</Text>
            </View>
          ) : null}
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button title="Save & test" icon="link-outline" onPress={saveUrl} loading={testing} style={{ flex: 1 }} />
            <Button title="Reset" variant="secondary" onPress={() => setUrl(DEFAULT_API_URL)} style={{ flex: 1 }} />
          </View>
        </Card>

        <SectionTitle>About</SectionTitle>
        <Card style={{ paddingVertical: 4 }}>
          <Row icon="sparkles-outline" toneName="primary" title="Forecasting" subtitle="Statistical models per SKU, refreshed nightly and after each sync" />
          <Row icon="shield-checkmark-outline" toneName="success" title="Your data" subtitle="Store tokens stay on the server; this phone only holds a session key" last />
        </Card>

        <View style={{ marginTop: space.xl }}>
          <Button
            title="Log out of this phone"
            variant="danger"
            icon="log-out-outline"
            onPress={() =>
              Alert.alert("Log out?", "The store stays connected on the server. You can reconnect with the same token.", [
                { text: "Cancel", style: "cancel" },
                { text: "Log out", style: "destructive", onPress: () => { qc.clear(); signOut(); } },
              ])
            }
          />
        </View>
        <Text style={[type.caption, { color: t.textMuted, textAlign: "center", marginTop: space.xl }]}>StockSense · AI inventory forecasting</Text>
      </ScrollView>
    </SafeAreaView>
  );
}
