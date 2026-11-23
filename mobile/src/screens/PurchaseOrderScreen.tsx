import React, { useEffect, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { Text } from "../components/AppText";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api } from "../api/client";
import { warningText } from "../api/types";
import { Button, Card, Notice, Pill, SectionTitle, Stat, StatusView, Stepper, confirm, notify } from "../components/ui";
import { space, tone, type, useTheme } from "../theme";
import { dateLabel, money, num } from "../utils/format";
import type { RootStackParamList } from "../navigation";
import { haptic } from "../utils/haptics";
import { poMeta } from "./OrdersScreen";

type Props = NativeStackScreenProps<RootStackParamList, "PurchaseOrder">;
type Action = "approve" | "send" | "cancel" | "receive";

const WORDS: Record<Action, { title: string; body: string; ok: string; done: string }> = {
  approve: { title: "Approve this order?", body: "It is locked for editing and ready to send to the supplier.", ok: "Approve", done: "Order approved" },
  send: { title: "Send to the supplier?", body: "StockSense emails the supplier the order with a CSV (when email is set up) and marks it sent.", ok: "Send", done: "Order sent" },
  receive: { title: "Mark everything received?", body: "Stock goes up by the ordered units, and the real lead time is recorded for the supplier.", ok: "Receive", done: "Order received" },
  cancel: { title: "Cancel this order?", body: "It stays in the list as cancelled. This cannot be undone.", ok: "Cancel order", done: "Order cancelled" },
};

export function PurchaseOrderScreen({ route, navigation }: Props) {
  const { id } = route.params;
  const t = useTheme();
  const qc = useQueryClient();
  const po = useQuery({ queryKey: ["purchaseOrder", id], queryFn: () => api.purchaseOrder(id) });
  const [qty, setQty] = useState<Record<number, number>>({});
  useEffect(() => {
    if (po.data) setQty(Object.fromEntries(po.data.lines.map((l) => [l.variant_id, l.quantity])));
    if (po.data) navigation.setOptions({ title: po.data.number });
  }, [po.data]);

  const after = () => {
    qc.invalidateQueries({ queryKey: ["purchaseOrder", id] });
    qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
    qc.invalidateQueries({ queryKey: ["forecasts"] });
    qc.invalidateQueries({ queryKey: ["dashboardV1"] });
  };
  const act = useMutation({
    mutationFn: (a: Action) => api.purchaseOrderAction(id, a),
    onSuccess: (r: any, a) => {
      haptic.success();
      after();
      const email = a === "send" ? r?.email : null;
      notify(WORDS[a].done, email ? (email.status === "queued" ? "The supplier is being emailed the order." : email.reason ?? undefined) : undefined);
    },
    onError: (e: any) => { haptic.warning(); notify("That did not work", e?.message); },
  });
  const save = useMutation({
    mutationFn: () => api.updatePurchaseOrder(id, { lines: Object.entries(qty).map(([v, q]) => ({ variant_id: Number(v), quantity: q })) }),
    onSuccess: () => { haptic.success(); after(); },
    onError: (e: any) => notify("Could not save", e?.message),
  });

  if (po.isPending) return <StatusView spinner title="Loading order" />;
  if (po.isError || !po.data) return <StatusView icon="alert-circle-outline" toneName="danger" title="Could not load the order" body={(po.error as Error)?.message} />;

  const o = po.data;
  const m = poMeta(o.status);
  const c = tone(t, m.tone);
  const draft = o.status === "draft";
  const dirty = draft && o.lines.some((l) => (qty[l.variant_id] ?? l.quantity) !== l.quantity);
  const total = o.lines.reduce((a, l) => a + (l.unit_cost ?? 0) * (qty[l.variant_id] ?? l.quantity), 0);
  const run = (a: Action) => confirm(WORDS[a].title, WORDS[a].body, WORDS[a].ok, () => act.mutate(a), a === "cancel");

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, maxWidth: 760, width: "100%", alignSelf: "center" }}
      refreshControl={<RefreshControl refreshing={po.isRefetching} onRefresh={() => { po.refetch(); }} tintColor={t.primary} colors={[t.primary]} />}
    >
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: c.bg, alignItems: "center", justifyContent: "center", marginRight: space.md }}>
            <Ionicons name={m.icon} size={22} color={c.fg} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[type.title, { color: t.text }]}>{o.number}</Text>
            <Text style={[type.caption, { color: t.textSecondary }]}>{o.supplier?.name ?? "No supplier"}{o.supplier?.email ? ` · ${o.supplier.email}` : ""}</Text>
          </View>
          <Pill toneName={m.tone}>{m.label}</Pill>
        </View>
        <View style={{ flexDirection: "row", marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: t.border }}>
          <Stat label="Units" value={num(Object.values(qty).reduce((a, b) => a + b, 0) || o.units)} />
          <Stat label="Total" value={money(draft ? total : o.total, o.currency)} />
          <Stat label="Expected" value={dateLabel(o.expected_at)} />
          <Stat label="Deliver to" value={o.location?.name ?? "-"} />
        </View>
      </Card>

      {o.automatic && draft ? (
        <View style={{ marginTop: space.md }}>
          <Notice icon="sparkles-outline" toneName="accent" title="Drafted automatically">
            StockSense keeps this draft in step with the forecast for products that need reordering. Approve it when the quantities look right.
          </Notice>
        </View>
      ) : null}
      {o.warnings.map((w, i) => <Notice key={i} icon="warning-outline" toneName="warning">{warningText(w)}</Notice>)}

      <SectionTitle>{`Products (${o.lines.length})`}</SectionTitle>
      <Card style={{ paddingVertical: 4 }}>
        {o.lines.map((l, i) => (
          <View key={l.variant_id} style={{ paddingVertical: space.md, borderBottomWidth: i < o.lines.length - 1 ? 1 : 0, borderBottomColor: t.border }}>
            <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
              <View style={{ flex: 1, marginRight: space.md }}>
                <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={2}>{l.title}</Text>
                <Text style={[type.caption, { color: t.textMuted }]}>
                  {l.sku ?? "No SKU"}{l.unit_cost != null ? ` · ${money(l.unit_cost, o.currency)} each` : ""}
                  {l.received_quantity ? ` · ${num(l.received_quantity)} received` : ""}
                </Text>
              </View>
              {!draft ? (
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={[type.bodyStrong, { color: t.text }]}>{num(l.quantity)}</Text>
                  <Text style={[type.caption, { color: t.textMuted }]}>{l.line_total != null ? money(l.line_total, o.currency) : ""}</Text>
                </View>
              ) : null}
            </View>
            {draft ? (
              <View style={{ marginTop: space.sm }}>
                <Stepper label="Quantity" value={qty[l.variant_id] ?? l.quantity} onChange={(v) => setQty((q) => ({ ...q, [l.variant_id]: v }))} min={0} unit={(qty[l.variant_id] ?? l.quantity) === 0 ? "removed when you save" : undefined} />
              </View>
            ) : null}
          </View>
        ))}
      </Card>

      <View style={{ gap: space.sm, marginTop: space.lg }}>
        {dirty ? <Button title="Save quantities" icon="save-outline" onPress={() => save.mutate()} loading={save.isPending} /> : null}
        {draft && !dirty ? <Button title="Approve order" icon="checkmark-circle-outline" onPress={() => run("approve")} loading={act.isPending && act.variables === "approve"} /> : null}
        {o.status === "approved" ? <Button title="Send to supplier" icon="paper-plane-outline" onPress={() => run("send")} loading={act.isPending && act.variables === "send"} /> : null}
        {o.status === "sent" || o.status === "partial" || o.status === "approved" ? (
          <Button title="Mark as received" icon="cube-outline" variant={o.status === "approved" ? "secondary" : "primary"} onPress={() => run("receive")} loading={act.isPending && act.variables === "receive"} />
        ) : null}
        {draft || o.status === "approved" || o.status === "sent" ? <Button title="Cancel order" variant="danger" icon="close-circle-outline" onPress={() => run("cancel")} loading={act.isPending && act.variables === "cancel"} /> : null}
      </View>

      <SectionTitle>History</SectionTitle>
      <Card style={{ paddingVertical: space.sm }}>
        <Step label="Created" at={o.created_at} />
        <Step label="Approved" at={o.approved_at} />
        <Step label={o.emailed_at ? "Sent and emailed" : "Sent"} at={o.sent_at} />
        <Step label="Received" at={o.received_at} />
        {o.cancelled_at ? <Step label="Cancelled" at={o.cancelled_at} /> : null}
      </Card>
    </ScrollView>
  );
}

function Step({ label, at }: { label: string; at: string | null }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 7 }}>
      <Ionicons name={at ? "checkmark-circle" : "ellipse-outline"} size={16} color={at ? t.success : t.textMuted} style={{ marginRight: 10 }} />
      <Text style={[type.body, { color: at ? t.text : t.textMuted, flex: 1 }]}>{label}</Text>
      <Text style={[type.caption, { color: t.textSecondary }]}>{at ? new Date(at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-"}</Text>
    </View>
  );
}
