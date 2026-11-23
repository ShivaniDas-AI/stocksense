import React, { useState } from "react";
import { ActivityIndicator, Alert, Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { Text } from "../components/AppText";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, currentBaseUrl } from "../api/client";
import type { CreatedApiKey } from "../api/types";
import { Button, Card, Input, Notice, SectionTitle, StatusView } from "../components/ui";
import { fw, radius, space, type, useTheme } from "../theme";
import { haptic } from "../utils/haptics";
import { ago } from "../utils/format";

/** Create, copy and revoke keys for the public /v1 API. */
export function ApiKeysScreen() {
  const t = useTheme();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  const keys = useQuery({ queryKey: ["apiKeys"], queryFn: api.apiKeys });
  const create = useMutation({
    mutationFn: () => api.createApiKey(name.trim() || "API key"),
    onSuccess: (k) => {
      haptic.success();
      setFresh(k);
      setCopied(false);
      setName("");
      qc.invalidateQueries({ queryKey: ["apiKeys"] });
    },
    onError: (e: any) => { haptic.warning(); Alert.alert("Could not create key", e?.message || "Please try again."); },
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.revokeApiKey(id),
    onSuccess: () => { haptic.success(); qc.invalidateQueries({ queryKey: ["apiKeys"] }); },
  });

  const confirmRevoke = (id: number, label: string) => {
    const go = () => revoke.mutate(id);
    if (Platform.OS === "web") {
      // eslint-disable-next-line no-alert
      if (typeof window !== "undefined" && window.confirm(`Revoke "${label}"? Anything using it stops working immediately.`)) go();
      return;
    }
    Alert.alert("Revoke key?", `"${label}" stops working immediately. This cannot be undone.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Revoke", style: "destructive", onPress: go },
    ]);
  };

  const copy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    haptic.success();
    setCopied(true);
  };

  const docsUrl = `${currentBaseUrl()}/docs`;
  const items = keys.data?.items ?? [];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }} keyboardShouldPersistTaps="handled">
      <Text style={[type.body, { color: t.textSecondary }]}>
        Keys let other software read this store's forecasts and KPIs through the StockSense API. Each key sees only the active store.
      </Text>

      {fresh ? (
        <Card style={{ marginTop: space.lg, borderColor: t.success }}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: space.sm }}>
            <Ionicons name="checkmark-circle" size={18} color={t.success} style={{ marginRight: 8 }} />
            <Text style={[type.heading, { color: t.text }]}>{fresh.name} created</Text>
          </View>
          <Text style={[type.caption, { color: t.textSecondary, marginBottom: space.sm }]}>
            Copy it now. For security, the full key is shown only once.
          </Text>
          <Pressable onPress={() => copy(fresh.key)} style={{ backgroundColor: t.surfaceAlt, borderWidth: 1, borderColor: t.border, borderRadius: radius.md, padding: space.md }}>
            <Text selectable style={[type.mono, { color: t.text }]}>{fresh.key}</Text>
          </Pressable>
          <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.md }}>
            <Button title={copied ? "Copied" : "Copy key"} icon={copied ? "checkmark" : "copy-outline"} onPress={() => copy(fresh.key)} style={{ flex: 1 }} small />
            <Button title="Done" variant="secondary" onPress={() => setFresh(null)} style={{ flex: 1 }} small />
          </View>
        </Card>
      ) : null}

      <SectionTitle>Create a key</SectionTitle>
      <Card>
        <Input label="Name" placeholder="e.g. Google Sheets sync" value={name} onChangeText={setName} hint="A label so you know where each key is used" />
        <Button title="Create key" icon="key-outline" onPress={() => create.mutate()} loading={create.isPending} />
      </Card>

      <SectionTitle>Active keys</SectionTitle>
      {keys.isPending ? (
        <ActivityIndicator color={t.primary} style={{ marginTop: space.lg }} />
      ) : keys.isError ? (
        <StatusView icon="alert-circle-outline" toneName="danger" title="Could not load keys" body={(keys.error as Error).message} />
      ) : items.length === 0 ? (
        <Card><Text style={[type.caption, { color: t.textMuted, textAlign: "center" }]}>No keys yet.</Text></Card>
      ) : (
        <Card style={{ paddingVertical: 4 }}>
          {items.map((k, i) => (
            <View key={k.id} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 12, borderBottomWidth: i < items.length - 1 ? 1 : 0, borderBottomColor: t.border }}>
              <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: t.primarySoft, alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                <Ionicons name="key-outline" size={17} color={t.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>{k.name}</Text>
                <Text style={[type.caption, { color: t.textMuted }]} numberOfLines={1}>
                  {k.prefix}… · {k.last_used_at ? `used ${ago(Date.parse(k.last_used_at))}` : "never used"}
                </Text>
              </View>
              <Pressable onPress={() => confirmRevoke(k.id, k.name)} hitSlop={8} style={{ paddingHorizontal: 10, paddingVertical: 6 }}>
                <Text style={[fw(700), { color: t.danger, fontSize: 13 }]}>Revoke</Text>
              </Pressable>
            </View>
          ))}
        </Card>
      )}

      <SectionTitle>Using the API</SectionTitle>
      <Notice icon="code-slash-outline" toneName="primary" title="Send the key as a bearer token">
        Authorization: Bearer ss_live_… · 120 requests a minute per key. Full reference and a live console at {docsUrl}
      </Notice>
      <Button title="Open API documentation" variant="secondary" icon="open-outline" onPress={() => Linking.openURL(docsUrl)} />
    </ScrollView>
  );
}
