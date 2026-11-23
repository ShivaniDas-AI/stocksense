import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "../components/AppText";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api } from "../api/client";
import { warningText } from "../api/types";
import { Button, Card, Notice, Pill, SectionTitle, Stat, StatusBadge, StatusView, Stepper, notify } from "../components/ui";
import { fw, radius, space, type, useTheme } from "../theme";
import { dateLabel, money, num, rate } from "../utils/format";
import type { RootStackParamList } from "../navigation";
import { haptic } from "../utils/haptics";

type Props = NativeStackScreenProps<RootStackParamList, "Reorder">;

const TAG: Record<string, string> = {
  current: "Current",
  preferred_for_category: "Preferred",
  makes_vendor: "Makes it",
  fastest: "Fastest",
  cheapest: "Cheapest",
};

export function ReorderScreen({ route, navigation }: Props) {
  const { id } = route.params;
  const t = useTheme();
  const qc = useQueryClient();
  const [supplierId, setSupplierId] = useState<number | undefined>(undefined);
  const [coverage, setCoverage] = useState<number | undefined>(undefined);
  const [qty, setQty] = useState<number | null>(null);

  const plan = useQuery({
    queryKey: ["reorder", id, supplierId, coverage],
    queryFn: () => api.reorderPlan(id, { supplier_id: supplierId, coverage_days: coverage }),
    placeholderData: (prev) => prev,
  });
  const store = useQuery({ queryKey: ["store"], queryFn: api.store });
  const currency = store.data?.currency || "USD";

  // Follow the suggestion until the user changes the quantity themselves.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (plan.data && !touched) setQty(plan.data.suggested_quantity);
  }, [plan.data?.suggested_quantity, touched]);

  const create = useMutation({
    mutationFn: () => api.createOrderFromReorder(id, { supplier_id: plan.data?.supplier_id ?? undefined, quantity: qty ?? undefined, coverage_days: coverage }),
    onSuccess: (po) => {
      haptic.success();
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      qc.invalidateQueries({ queryKey: ["forecastV1", id] });
      qc.invalidateQueries({ queryKey: ["dashboardV1"] });
      navigation.replace("PurchaseOrder", { id: po.id, title: po.number });
    },
    onError: (e: any) => { haptic.warning(); notify("Could not create the order", e?.message); },
  });

  if (plan.isPending) return <StatusView spinner title="Working out the order" />;
  if (plan.isError || !plan.data)
    return <StatusView icon="alert-circle-outline" toneName="danger" title="Could not load the reorder plan" body={(plan.error as Error)?.message} action={<Button title="Try again" variant="secondary" onPress={() => plan.refetch()} />} />;

  const p = plan.data;
  const qd = p.quantity;
  const selected = p.suppliers.find((s) => s.supplier_id === p.supplier_id) ?? p.suppliers.find((s) => s.selected);
  const cost = selected?.unit_cost != null && qty != null ? selected.unit_cost * qty : null;
  const belowMin = selected?.min_order_value != null && cost != null && cost < selected.min_order_value;
  const arrival = selected ? p.effect.find((e) => e.date >= selected.arrives_on) : undefined;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, maxWidth: 760, width: "100%", alignSelf: "center" }}>
      <Text style={[type.title, { color: t.text }]}>{p.title}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
        <StatusBadge status={p.status} />
        <Text style={[type.caption, { color: t.textSecondary }]}>{p.sku ? `SKU ${p.sku} · ` : ""}{rate(p.top.forecast_per_day)} a day</Text>
      </View>

      <Card style={{ marginTop: space.lg }}>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Stat label="On hand" value={num(p.top.on_hand)} sub={p.top.on_order ? `+${num(p.top.on_order)} on order` : undefined} />
          <Stat label="Runs out" value={dateLabel(p.top.runs_out_on)} warn={!!p.top.runs_out_on && !!selected && p.top.runs_out_on < selected.arrives_on} />
          <Stat label="Order lands" value={selected ? dateLabel(selected.arrives_on) : "-"} />
        </View>
      </Card>

      <SectionTitle>Supplier</SectionTitle>
      <Card style={{ padding: 0, overflow: "hidden" }}>
        {p.suppliers.length === 0 ? (
          <View style={{ padding: space.lg }}>
            <Text style={[type.body, { color: t.textSecondary }]}>No suppliers yet. Add one in the Orders tab, under Suppliers.</Text>
          </View>
        ) : null}
        {p.suppliers.map((s, i) => {
          const on = s.supplier_id === p.supplier_id;
          return (
            <Pressable
              key={s.supplier_id}
              onPress={() => { haptic.tap(); setSupplierId(s.supplier_id); setTouched(false); }}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", padding: space.md, borderBottomWidth: i < p.suppliers.length - 1 ? 1 : 0, borderBottomColor: t.border, backgroundColor: on ? t.primarySoft : "transparent", opacity: pressed ? 0.8 : 1 })}
            >
              <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={20} color={on ? t.primary : t.textMuted} style={{ marginRight: 12 }} />
              <View style={{ flex: 1, minWidth: 0, marginRight: space.sm }}>
                <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                  <Text style={[type.bodyStrong, { color: t.text }]}>{s.name}</Text>
                  {s.tags.map((tg) => (TAG[tg] ? <Pill key={tg} toneName="primary">{TAG[tg]}</Pill> : null))}
                </View>
                <Text style={[type.caption, { color: t.textSecondary, marginTop: 2 }]}>
                  {s.lead_time_days} days ({s.lead_time_basis}) · lands {dateLabel(s.arrives_on)}
                  {s.unit_cost != null ? ` · ${money(s.unit_cost, currency)} each` : ""}
                </Text>
              </View>
              <Text style={[fw(700), { color: t.text, fontSize: 15, flexShrink: 0 }]}>{num(s.quantity)}</Text>
            </Pressable>
          );
        })}
      </Card>

      <SectionTitle>Quantity</SectionTitle>
      <Card>
        <View style={{ flexDirection: "row", gap: space.md }}>
          <Stepper label="Units to order" value={qty ?? 0} onChange={(v) => { setTouched(true); setQty(v); }} min={1} unit={`suggested ${num(p.suggested_quantity)}`} />
          <Stepper label="Cover for" value={coverage ?? p.inputs.coverage_days} onChange={(v) => { setCoverage(Math.max(7, v)); setTouched(false); }} min={7} unit="days after it lands" />
        </View>
        <View style={{ marginTop: space.lg, borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.md }}>
          <Line label={`Sales during the ${qd.lead_time_days}-day lead time`} value={num(Math.round(qd.sold_during_lead_time))} />
          <Line label={`Sales during ${qd.coverage_days} days of cover`} value={`+ ${num(Math.round(qd.sold_during_coverage))}`} />
          <Line label={`Safety stock (${Math.round(qd.service_level * 100)}% service level)`} value={`+ ${num(Math.round(qd.safety_stock))}`} />
          <Line label="On hand and on order" value={`- ${num(qd.on_hand + qd.on_order)}`} />
          <Line label="Short by" value={num(Math.ceil(qd.short_by))} strong />
          {qd.raised_to_minimum ? <Line label={`Raised to the minimum order (${qd.min_order_qty})`} value={num(qd.raised_to_minimum)} /> : null}
          {qd.rounded_to_case_pack ? <Line label={`Rounded up to cases of ${qd.case_pack}`} value={num(qd.rounded_to_case_pack)} /> : null}
          <Line label="Suggested order" value={num(p.suggested_quantity)} strong />
        </View>
      </Card>

      {arrival ? (
        <Notice icon="analytics-outline" toneName="primary" title={`When it lands on ${dateLabel(arrival.date)}`}>
          {`Stock would be ${num(Math.round(arrival.without_order))} units without this order and ${num(Math.round(arrival.with_order))} with it, against a safety stock of ${num(Math.round(arrival.safety_stock))}.`}
        </Notice>
      ) : null}
      {belowMin ? (
        <Notice icon="warning-outline" toneName="warning" title="Below the supplier's minimum">
          {`${selected!.name} asks for at least ${money(selected!.min_order_value, currency)} an order. Add more units or other products to the draft.`}
        </Notice>
      ) : null}
      {(p.warnings ?? []).map((w, i) => (
        <Notice key={i} icon="warning-outline" toneName="warning">{warningText(w)}</Notice>
      ))}

      <View style={{ marginTop: space.md }}>
        <Button
          title={`Create draft order${cost != null ? ` · ${money(cost, currency)}` : ""}`}
          icon="document-text-outline"
          onPress={() => create.mutate()}
          loading={create.isPending}
          disabled={!p.supplier_id || !qty}
        />
        <Text style={[type.caption, { color: t.textMuted, textAlign: "center", marginTop: space.sm }]}>
          Drafts are not sent. You approve and send them from Orders.
        </Text>
      </View>
    </ScrollView>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 5, borderTopWidth: strong ? 1 : 0, borderTopColor: t.border, marginTop: strong ? 4 : 0 }}>
      <Text style={[strong ? fw(700) : fw(400), { color: strong ? t.text : t.textSecondary, fontSize: 13, flex: 1, marginRight: 8 }]}>{label}</Text>
      <Text style={[fw(700), { color: t.text, fontSize: 13 }]}>{value}</Text>
    </View>
  );
}
