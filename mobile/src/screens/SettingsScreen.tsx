import React, { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Avatar, Button, Card, Input, Pill, Row, ScreenHeader, SectionTitle, confirm, notify } from "../components/ui";
import { dateLabel } from "../utils/format";
import { fw, space, type, useTheme } from "../theme";
import { haptic } from "../utils/haptics";
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
  const plan = useQuery({ queryKey: ["plan"], queryFn: api.plan, retry: 0 });
  const askUsage = useQuery({ queryKey: ["askUsage"], queryFn: api.askUsage, retry: 0 });
  const switchStore = useMutation({
    mutationFn: (id: string) => api.switchStore(id),
    // Reset (not clear) so active screens refetch straight away for the new store.
    onSuccess: async (r) => { await signIn(r.token); await qc.resetQueries(); },
    onError: (e: any) => notify("Could not switch store", e?.message || "Please try again."),
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
          {(stores.data?.stores ?? []).map((s) => {
            const active = String(s.id) === String(stores.data?.active);
            return (
              <Pressable
                key={s.id}
                disabled={active || switchStore.isPending}
                onPress={() => { haptic.tap(); switchStore.mutate(s.id); }}
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.border, opacity: pressed ? 0.7 : 1 })}
              >
                <Avatar name={s.store_domain} size={36} toneName={active ? "primary" : "neutral"} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>{s.store_domain}</Text>
                  <Text style={[type.caption, { color: t.textSecondary }]}>{PLATFORM[s.platform]}{active ? " · active" : ""}</Text>
                </View>
                {active ? <Ionicons name="checkmark-circle" size={20} color={t.primary} /> : switchStore.isPending ? <ActivityIndicator color={t.primary} /> : <Text style={[fw(700), { color: t.primary, fontSize: 13 }]}>Switch</Text>}
              </Pressable>
            );
          })}
          {stores.isError ? <Text style={[type.caption, { color: t.danger, paddingVertical: 8 }]}>{(stores.error as Error).message}</Text> : null}
          <Row icon="add-circle-outline" toneName="primary" title="Add another store" subtitle="Connect a second Shopify, BigCommerce or WooCommerce store" onPress={() => nav.navigate("Connect")} last />
        </Card>

        {plan.data ? (
          <>
            <SectionTitle>Plan</SectionTitle>
            <Card>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={[type.heading, fw(700), { color: t.text }]}>{plan.data.name}</Text>
                  <Text style={[type.caption, { color: t.textSecondary }]}>
                    {`$${plan.data.price} a month`}
                    {plan.data.trial_ends_at ? ` · trial ends ${dateLabel(plan.data.trial_ends_at)}` : ""}
                  </Text>
                </View>
                <Pill toneName="primary" icon="refresh-outline">{`${plan.data.limits.forecast_rebuild} forecasts`}</Pill>
              </View>
              <View style={{ flexDirection: "row", marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: t.border }}>
                <Usage label="Products" used={plan.data.usage.skus} limit={plan.data.limits.skus} />
                <Usage label="Locations" used={plan.data.usage.locations} limit={plan.data.limits.locations} />
                <Usage label="Ask, this month" used={plan.data.usage.ask_questions_this_month} limit={plan.data.limits.ask_questions_per_month} />
              </View>
            </Card>
          </>
        ) : null}

        <SectionTitle>Assistants</SectionTitle>
        <Card style={{ paddingVertical: 4 }}>
          <Row icon="sparkles-outline" toneName="primary" title="Ask StockSense" subtitle={askUsage.data && !askUsage.data.configured ? "Not switched on: tap to see how to add the AI key" : "Questions in your own words, answered from live forecasts"} onPress={() => nav.navigate("Ask")} right={askUsage.data ? <Pill toneName={askUsage.data.configured ? "success" : "warning"}>{askUsage.data.configured ? `On · ${askUsage.data.provider === "openai" ? "OpenAI" : askUsage.data.provider === "gemini" ? "Gemini" : "Claude"}` : askUsage.data.key_problem ? "Wrong key" : "Needs key"}</Pill> : undefined} />
          <Row icon="logo-whatsapp" toneName="success" title="WhatsApp chat" subtitle="Try the WhatsApp assistant right here" onPress={() => nav.navigate("WhatsAppChat")} last />
        </Card>

        <SectionTitle>Developers</SectionTitle>
        <Card style={{ paddingVertical: 4 }}>
          <Row icon="key-outline" toneName="primary" title="API keys" subtitle="Connect other tools to this store's forecasts and KPIs" onPress={() => nav.navigate("ApiKeys")} last />
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
          <Row icon="sparkles-outline" toneName="primary" title="Forecasting" subtitle="Statistical models per product, refreshed on your plan's schedule and after each sync" />
          <Row icon="shield-checkmark-outline" toneName="success" title="Your data" subtitle="Store tokens stay on the server; this phone only holds a session key" last />
        </Card>

        <View style={{ marginTop: space.xl }}>
          <Button
            title="Log out of this phone"
            variant="danger"
            icon="log-out-outline"
            onPress={() =>
              confirm("Log out?", "The store stays connected on the server. You can reconnect with the same token.", "Log out", async () => { await signOut(); qc.clear(); }, true)
            }
          />
        </View>
        <Text style={[type.caption, { color: t.textMuted, textAlign: "center", marginTop: space.xl }]}>StockSense · AI inventory forecasting</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Usage({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const t = useTheme();
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <View style={{ flex: 1, marginRight: 10 }}>
      <Text style={[fw(600), { color: t.textMuted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }]} numberOfLines={1}>{label}</Text>
      <Text style={[fw(700), { color: t.text, fontSize: 15, marginTop: 3 }]}>
        {used.toLocaleString()}
        <Text style={[fw(500), { color: t.textMuted, fontSize: 12 }]}>{limit == null ? " / unlimited" : limit === 0 ? " / not included" : ` / ${limit.toLocaleString()}`}</Text>
      </Text>
      {limit ? (
        <View style={{ height: 4, borderRadius: 2, backgroundColor: t.surfaceAlt, marginTop: 6, overflow: "hidden" }}>
          <View style={{ width: `${pct}%`, height: 4, backgroundColor: pct > 90 ? t.danger : t.primary }} />
        </View>
      ) : null}
    </View>
  );
}
