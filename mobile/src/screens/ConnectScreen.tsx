import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button, Card, Chip, Input } from "../components/ui";
import { colors, space } from "../theme";

type Tab = "bigcommerce" | "shopify" | "woocommerce";

/**
 * Connect a store with an API token. OAuth installs stay on the web; the
 * token routes are what the server exposes for API clients and what this
 * app uses for all three platforms.
 */
export function ConnectScreen({ onDone }: { onDone?: () => void }) {
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

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const r =
        tab === "bigcommerce"
          ? await api.connectBigCommerce(bcHash.trim(), bcToken.trim())
          : tab === "shopify"
          ? await api.connectShopify(shop.trim(), shopToken.trim())
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
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.logo}>
            STOCK<Text style={{ color: colors.green }}>SENSE</Text>
          </Text>
          <Text style={styles.tag}>Connect your store to start forecasting stockouts.</Text>

          <View style={styles.tabs}>
            <Chip label="BigCommerce" active={tab === "bigcommerce"} onPress={() => setTab("bigcommerce")} />
            <Chip label="Shopify" active={tab === "shopify"} onPress={() => setTab("shopify")} />
            <Chip label="WooCommerce" active={tab === "woocommerce"} onPress={() => setTab("woocommerce")} />
          </View>

          <Card>
            {tab === "bigcommerce" && (
              <>
                <Input label="Store hash" placeholder="e.g. abc123xyz" value={bcHash} onChangeText={setBcHash} />
                <Input label="Access token" placeholder="Access token" value={bcToken} onChangeText={setBcToken} secureTextEntry />
                <Text style={styles.hint}>
                  Control panel › Settings › API › Store-level API accounts. Needs Products and Orders read-only.
                </Text>
              </>
            )}
            {tab === "shopify" && (
              <>
                <Input label="Store" placeholder="your-store.myshopify.com" value={shop} onChangeText={setShop} keyboardType="url" />
                <Input label="Admin API access token" placeholder="shpat_..." value={shopToken} onChangeText={setShopToken} secureTextEntry />
                <Text style={styles.hint}>Store admin › Settings › Apps › Develop apps › your app › API credentials.</Text>
              </>
            )}
            {tab === "woocommerce" && (
              <>
                <Input label="Site" placeholder="yourstore.com" value={wooSite} onChangeText={setWooSite} keyboardType="url" />
                <Input label="Consumer key" placeholder="ck_..." value={wooKey} onChangeText={setWooKey} />
                <Input label="Consumer secret" placeholder="cs_..." value={wooSecret} onChangeText={setWooSecret} secureTextEntry />
                <Text style={styles.hint}>WooCommerce › Settings › Advanced › REST API › Add key (Read access).</Text>
              </>
            )}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={{ marginTop: space.md }}>
              <Button title="Connect store" onPress={connect} loading={busy} />
            </View>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  body: { padding: space.lg, paddingTop: space.xl * 2 },
  logo: { color: colors.text, fontSize: 24, fontWeight: "800", letterSpacing: 0.5 },
  tag: { color: colors.dim, marginTop: 4, marginBottom: space.lg },
  tabs: { flexDirection: "row", marginBottom: space.md },
  hint: { color: colors.dim, fontSize: 12, lineHeight: 17 },
  error: { color: colors.red, fontSize: 12, marginTop: space.sm },
});
