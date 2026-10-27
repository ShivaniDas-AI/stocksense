import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button, Card, Chip, Input, Notice } from "../components/ui";
import { radius, space, type, useTheme } from "../theme";

type Tab = "bigcommerce" | "shopify" | "woocommerce";

const HELP: Record<Tab, string> = {
  bigcommerce: "Control panel › Settings › API › Store-level API accounts. The account needs Products and Orders set to read-only.",
  shopify: "Store admin › Settings › Apps › Develop apps › your app › API credentials. Scopes: read_products, read_orders, read_inventory.",
  woocommerce: "WooCommerce › Settings › Advanced › REST API › Add key with Read access.",
};

/**
 * Connect a store with an API token. OAuth installs stay on the web; the
 * token routes are what the server exposes for API clients.
 */
export function ConnectScreen({ onDone }: { onDone?: () => void }) {
  const t = useTheme();
  const { signIn } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("bigcommerce");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [bcHash, setBcHash] = useState("");
  const [bcToken, setBcToken] = useState("");
  const [shop, setShop] = useState("");
  const [shopToken, setShopToken] = useState("");
  const [wooSite, setWooSite] = useState("");
  const [wooKey, setWooKey] = useState("");
  const [wooSecret, setWooSecret] = useState("");

  const canSubmit =
    tab === "bigcommerce" ? !!bcHash.trim() && !!bcToken.trim()
    : tab === "shopify" ? !!shop.trim() && !!shopToken.trim()
    : !!wooSite.trim() && !!wooKey.trim() && !!wooSecret.trim();

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const r =
        tab === "bigcommerce" ? await api.connectBigCommerce(bcHash.trim(), bcToken.trim())
        : tab === "shopify" ? await api.connectShopify(shop.trim(), shopToken.trim())
        : await api.connectWoo(wooSite.trim(), wooKey.trim(), wooSecret.trim());
      if (!r.ok || !r.token) throw new Error(r.error || "Connection failed");
      await signIn(r.token);
      qc.clear();
      onDone?.();
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : e?.message || "Connection failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: space.xxl }} keyboardShouldPersistTaps="handled">
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: space.sm }}>
            <View style={{ width: 44, height: 44, borderRadius: radius.md, backgroundColor: t.primary, alignItems: "center", justifyContent: "center", marginRight: 12 }}>
              <Ionicons name="cube" size={24} color={t.primaryText} />
            </View>
            <View>
              <Text style={[type.title, { color: t.text }]}>StockSense</Text>
              <Text style={[type.caption, { color: t.textSecondary }]}>Inventory forecasting</Text>
            </View>
          </View>
          <Text style={[type.body, { color: t.textSecondary, marginTop: space.sm, marginBottom: space.xl }]}>
            Connect a store to see which products will run out, when, and how much to reorder.
          </Text>

          <Text style={[type.label, { color: t.textMuted, marginBottom: 8 }]}>Platform</Text>
          <View style={{ flexDirection: "row", marginBottom: space.lg }}>
            <Chip label="BigCommerce" active={tab === "bigcommerce"} onPress={() => setTab("bigcommerce")} />
            <Chip label="Shopify" active={tab === "shopify"} onPress={() => setTab("shopify")} />
            <Chip label="WooCommerce" active={tab === "woocommerce"} onPress={() => setTab("woocommerce")} />
          </View>

          <Card>
            {tab === "bigcommerce" && (
              <>
                <Input label="Store hash" placeholder="e.g. abc123xyz" value={bcHash} onChangeText={setBcHash} hint="The part after /stores/ in your API path" />
                <Input label="Access token" placeholder="Paste the access token" value={bcToken} onChangeText={setBcToken} secureTextEntry />
              </>
            )}
            {tab === "shopify" && (
              <>
                <Input label="Store" placeholder="your-store.myshopify.com" value={shop} onChangeText={setShop} keyboardType="url" />
                <Input label="Admin API access token" placeholder="shpat_..." value={shopToken} onChangeText={setShopToken} secureTextEntry />
              </>
            )}
            {tab === "woocommerce" && (
              <>
                <Input label="Site" placeholder="yourstore.com" value={wooSite} onChangeText={setWooSite} keyboardType="url" />
                <Input label="Consumer key" placeholder="ck_..." value={wooKey} onChangeText={setWooKey} />
                <Input label="Consumer secret" placeholder="cs_..." value={wooSecret} onChangeText={setWooSecret} secureTextEntry />
              </>
            )}
            {error ? (
              <Notice icon="alert-circle-outline" toneName="danger">{error}</Notice>
            ) : null}
            <Button title="Connect store" icon="link-outline" onPress={connect} loading={busy} disabled={!canSubmit} />
          </Card>

          <View style={{ marginTop: space.lg }}>
            <Notice icon="help-circle-outline" toneName="neutral" title="Where to find these">{HELP[tab]}</Notice>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
