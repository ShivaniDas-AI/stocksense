import React, { useEffect, useState } from "react";
import { Linking, Pressable, RefreshControl, ScrollView, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { api } from "../api/client";
import type { WhatsAppActivity, WhatsAppLinkCode } from "../api/types";
import { Button, Card, Notice, Pill, Row, ScreenHeader, SectionTitle, StatusView, confirm, notify } from "../components/ui";
import { fw, radius, space, tone, ToneName, type, useTheme } from "../theme";
import type { RootStackParamList } from "../navigation";
import { haptic } from "../utils/haptics";

export const WA_GREEN = "#25D366";

const ACT: Record<string, { label: string; tone: ToneName }> = {
  pending: { label: "Waiting for approval", tone: "warning" },
  approved: { label: "Approved", tone: "primary" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
};

function useCountdown(expiresAt?: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const s = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return { seconds: s, text: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` };
}

export function WhatsAppScreen() {
  const t = useTheme();
  const qc = useQueryClient();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const status = useQuery({ queryKey: ["whatsapp"], queryFn: api.whatsapp, refetchInterval: 15_000 });
  const activity = useQuery({ queryKey: ["whatsappActivity"], queryFn: api.whatsappActivity, refetchInterval: 30_000 });
  const [code, setCode] = useState<WhatsAppLinkCode | null>(null);
  const live = code ?? (status.data?.link_code ? { ...status.data.link_code, send_to: status.data.business_number, open_whatsapp_url: null } : null);
  const left = useCountdown(live?.expires_at);
  const expired = left ? left.seconds <= 0 : false;

  const makeCode = useMutation({
    mutationFn: api.whatsappLinkCode,
    onSuccess: (c) => { haptic.success(); setCode(c); qc.invalidateQueries({ queryKey: ["whatsapp"] }); },
    onError: (e: any) => notify("Could not create a code", e?.message),
  });
  const setRole = useMutation({
    mutationFn: ({ id, can }: { id: number; can: boolean }) => api.whatsappSetRole(id, can ? "can_approve" : "view_only"),
    onSuccess: () => { haptic.tap(); qc.invalidateQueries({ queryKey: ["whatsapp"] }); },
    onError: (e: any) => notify("Could not change the role", e?.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.whatsappDisconnect(id),
    onSuccess: () => { haptic.success(); qc.invalidateQueries({ queryKey: ["whatsapp"] }); },
    onError: (e: any) => notify("Could not remove the number", e?.message),
  });

  // A phone that just linked ends the code; clear the local copy too.
  useEffect(() => {
    if (code && status.data && !status.data.link_code && status.data.connected_numbers.length) setCode(null);
  }, [status.data]);

  if (status.isPending) return <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}><StatusView spinner title="Loading WhatsApp" /></SafeAreaView>;
  if (status.isError || !status.data)
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
        <StatusView icon="cloud-offline-outline" toneName="danger" title="Could not load WhatsApp settings" body={(status.error as Error)?.message} action={<Button title="Try again" variant="secondary" onPress={() => status.refetch()} />} />
      </SafeAreaView>
    );

  const w = status.data;
  const numbers = w.connected_numbers;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, maxWidth: 760, width: "100%", alignSelf: "center" }}
        refreshControl={<RefreshControl refreshing={status.isRefetching} onRefresh={() => { status.refetch(); activity.refetch(); }} tintColor={t.primary} colors={[t.primary]} />}
      >
        <ScreenHeader title="WhatsApp" subtitle="Run StockSense from a chat, with approvals" />

        {/* Hero */}
        <Card style={{ backgroundColor: t.dark ? "#0F2A1E" : "#ECFDF3", borderColor: t.dark ? "#1F4D37" : "#BBF7D0" }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: WA_GREEN, alignItems: "center", justifyContent: "center", marginRight: space.md }}>
              <Ionicons name="logo-whatsapp" size={28} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[type.heading, fw(700), { color: t.text }]}>StockSense assistant</Text>
              <View style={{ flexDirection: "row", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                <Pill toneName={w.enabled ? "success" : "warning"} icon={w.enabled ? "checkmark-circle" : "construct-outline"}>{w.enabled ? "Live on WhatsApp" : "Preview mode"}</Pill>
                <Pill toneName={w.ai_answers ? "primary" : "neutral"} icon="sparkles-outline">{w.ai_answers ? "AI answers on" : "Menus only"}</Pill>
              </View>
            </View>
          </View>
          <Text style={[type.caption, { color: t.textSecondary, marginTop: space.md }]}>
            {w.enabled
              ? `Message ${w.business_number ?? "the StockSense number"} from a linked phone: today's summary, what to reorder, forecasts, purchase orders, suppliers, alerts and transfers. Every change waits for your Approve.`
              : "The assistant is not connected to Meta's WhatsApp Cloud API on the server yet. Everything works here in the app: link your number below, then open the chat preview."}
          </Text>
          <Button title="Open the chat" icon="chatbubbles-outline" onPress={() => nav.navigate("WhatsAppChat")} style={{ marginTop: space.md, backgroundColor: "#128C7E" }} />
        </Card>
        {w.note ? <View style={{ marginTop: space.md }}><Notice icon="information-circle-outline" toneName="primary">{w.note}</Notice></View> : null}

        {/* Link a phone */}
        <SectionTitle>Link a phone</SectionTitle>
        <Card>
          {live && !expired ? (
            <View style={{ alignItems: "center" }}>
              <Text style={[type.label, { color: t.textMuted }]}>Your link code</Text>
              <Text style={[fw(800), { color: t.text, fontSize: 40, letterSpacing: 8, marginTop: 6 }]} selectable>{live.code}</Text>
              <Text style={[type.caption, { color: left && left.seconds < 60 ? t.danger : t.textSecondary, marginTop: 2 }]}>Expires in {left?.text}</Text>
              <Text style={[type.body, { color: t.textSecondary, textAlign: "center", marginTop: space.md }]}>
                From the phone you want to connect, send <Text style={[fw(700), { color: t.text }]}>link {live.code}</Text>
                {live.send_to ? <> to <Text style={[fw(700), { color: t.text }]}>{live.send_to}</Text></> : null} on WhatsApp.
              </Text>
              {live.open_whatsapp_url ? (
                <Button title="Open WhatsApp" icon="logo-whatsapp" onPress={() => Linking.openURL(live.open_whatsapp_url!)} style={{ marginTop: space.md, alignSelf: "stretch", backgroundColor: "#128C7E" }} />
              ) : (
                <Button title="Link from the chat preview" icon="chatbubbles-outline" variant="secondary" onPress={() => nav.navigate("WhatsAppChat")} style={{ marginTop: space.md, alignSelf: "stretch" }} />
              )}
            </View>
          ) : (
            <View>
              <Text style={[type.body, { color: t.textSecondary }]}>
                Create a 6-digit code, then send it from the phone you want to connect. Codes work for 10 minutes. You can link several phones: the owner, a buyer, a warehouse lead.
              </Text>
              <Button title={expired ? "Code expired: create a new one" : "Create link code"} icon="key-outline" onPress={() => makeCode.mutate()} loading={makeCode.isPending} style={{ marginTop: space.md }} />
            </View>
          )}
        </Card>

        {/* Linked numbers */}
        <SectionTitle>{`Linked phones (${numbers.length})`}</SectionTitle>
        <Card style={{ paddingVertical: numbers.length ? 4 : space.lg }}>
          {numbers.length === 0 ? <Text style={[type.body, { color: t.textSecondary }]}>No phones linked yet.</Text> : null}
          {numbers.map((n, i) => (
            <View key={n.id} style={{ paddingVertical: 12, borderBottomWidth: i < numbers.length - 1 ? 1 : 0, borderBottomColor: t.border }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: WA_GREEN + "22", alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                  <Ionicons name="person" size={17} color="#128C7E" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[type.bodyStrong, { color: t.text }]}>{n.phone}</Text>
                  <Text style={[type.caption, { color: t.textSecondary }]}>
                    Linked {new Date(n.connected_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                    {n.last_message_at ? ` · last message ${new Date(n.last_message_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : ""}
                  </Text>
                </View>
                <Pressable hitSlop={8} onPress={() => confirm("Remove this phone?", `${n.phone} will no longer reach your store on WhatsApp.`, "Remove", () => remove.mutate(n.id), true)}>
                  <Ionicons name="trash-outline" size={19} color={t.danger} />
                </Pressable>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", marginTop: 10, marginLeft: 48 }}>
                <View style={{ flex: 1 }}>
                  <Text style={[type.captionStrong, { color: t.text }]}>Can approve changes</Text>
                  <Text style={[type.caption, { color: t.textMuted }]}>{n.role === "can_approve" ? "Approves orders, sends them, adds suppliers" : "Sees everything, changes nothing"}</Text>
                </View>
                <Switch
                  value={n.role === "can_approve"}
                  onValueChange={(v) => setRole.mutate({ id: n.id, can: v })}
                  trackColor={{ true: "#128C7E", false: t.border }}
                  thumbColor="#fff"
                  disabled={setRole.isPending}
                />
              </View>
            </View>
          ))}
        </Card>

        {/* What it can do */}
        <SectionTitle>In the chat</SectionTitle>
        <Card style={{ paddingVertical: 4 }}>
          <Row icon="today-outline" toneName="primary" title="Today's summary" subtitle="Stock at risk, drafts waiting, cash in overstock" />
          <Row icon="cart-outline" toneName="danger" title="Reorder now" subtitle="What to order, how much and from whom; draft it in a tap" />
          <Row icon="analytics-outline" toneName="info" title="Product forecast" subtitle="Search by name or SKU; get the stock chart as an image" />
          <Row icon="document-text-outline" toneName="neutral" title="Purchase orders" subtitle="Approve, send and receive" />
          <Row icon="shield-checkmark-outline" toneName="success" title="Safe by design" subtitle="Every change shows first and runs only when you tap Approve within 30 minutes" last />
        </Card>

        {/* Activity */}
        <SectionTitle>Activity</SectionTitle>
        <Card style={{ paddingVertical: (activity.data ?? []).length ? 4 : space.lg }}>
          {(activity.data ?? []).length === 0 ? (
            <Text style={[type.body, { color: t.textSecondary }]}>{activity.isPending ? "Loading…" : "Changes asked for on WhatsApp appear here, with who approved them."}</Text>
          ) : null}
          {(activity.data ?? []).map((a, i, arr) => <ActivityRow key={a.id} a={a} last={i === arr.length - 1} />)}
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function ActivityRow({ a, last }: { a: WhatsAppActivity; last: boolean }) {
  const t = useTheme();
  const m = ACT[a.status] ?? { label: a.status, tone: "neutral" as ToneName };
  const c = tone(t, m.tone);
  return (
    <View style={{ paddingVertical: 12, borderBottomWidth: last ? 0 : 1, borderBottomColor: t.border }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={[type.bodyStrong, { color: t.text, flex: 1 }]} numberOfLines={1}>{a.title}</Text>
        <View style={{ backgroundColor: c.bg, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
          <Text style={[fw(700), { color: c.fg, fontSize: 11 }]}>{m.label}</Text>
        </View>
      </View>
      <Text style={[type.caption, { color: t.textSecondary, marginTop: 2 }]} numberOfLines={3}>{a.summary.replace(/\*/g, "")}</Text>
      <Text style={[type.caption, { color: t.textMuted, marginTop: 2 }]}>
        {a.phone} · {a.source === "ai" ? "asked in words" : "from the menu"} · {new Date(a.created_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
      </Text>
      {resultText(a.result) ? <Text style={[type.caption, { color: a.status === "failed" ? t.danger : t.success, marginTop: 2 }]}>{resultText(a.result)}</Text> : null}
    </View>
  );
}

/** The action's result arrives as text or as an object such as {number, status}. */
function resultText(r: unknown): string | null {
  if (r == null) return null;
  if (typeof r === "string") return r;
  if (typeof r === "object") {
    const o = r as Record<string, any>;
    if (o.error || o.message) return String(o.error ?? o.message);
    const parts = [o.number, o.name, o.status, o.total != null ? `total ${o.total}` : null].filter((x) => x != null && x !== "");
    return parts.length ? parts.join(" · ") : null;
  }
  return String(r);
}
