import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHeaderHeight } from "@react-navigation/elements";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api } from "../api/client";
import type { AskChart } from "../api/types";
import { Card, Notice } from "../components/ui";
import { AnswerChart } from "../components/Charts";
import { fw, radius, space, type, useTheme } from "../theme";
import type { RootStackParamList } from "../navigation";
import { haptic } from "../utils/haptics";

type Props = NativeStackScreenProps<RootStackParamList, "Ask">;
type Msg = { id: number; role: "user" | "assistant" | "error"; text: string; charts?: AskChart[] };

const SUGGESTIONS = [
  "What should I reorder this week, and from whom?",
  "Which products will run out first?",
  "Where is cash tied up in overstock?",
  "How accurate are my forecasts?",
  "Draft purchase orders for everything that needs reordering",
];

/** Light markdown: **bold**, *bold*, and "- " bullets. */
function Answer({ text }: { text: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4 }}>
      {text.split(/\n/).map((line, i) => {
        if (!line.trim()) return <View key={i} style={{ height: 4 }} />;
        const bullet = /^\s*[-•*]\s+/.test(line);
        const body = line.replace(/^\s*[-•*]\s+/, "").replace(/^#+\s*/, "");
        const parts = body.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*)/g);
        return (
          <View key={i} style={{ flexDirection: "row" }}>
            {bullet ? <Text style={[type.body, { color: t.textSecondary, width: 14 }]}>•</Text> : null}
            <Text style={[type.body, { color: t.text, flex: 1 }, /^#+\s/.test(line) && fw(700)]}>
              {parts.map((p, j) => (/^\*\*.+\*\*$/.test(p) ? <Text key={j} style={fw(700)}>{p.slice(2, -2)}</Text> : /^\*[^*]+\*$/.test(p) ? <Text key={j} style={fw(700)}>{p.slice(1, -1)}</Text> : p))}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function AskScreen({ route }: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const qc = useQueryClient();
  const usage = useQuery({ queryKey: ["askUsage"], queryFn: api.askUsage });
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState(route.params?.prompt ?? "");
  const [busy, setBusy] = useState(false);
  const [conv, setConv] = useState<number | undefined>(undefined);
  const seq = useRef(1);
  const scroll = useRef<any>(null);
  const u = usage.data;
  const notConfigured = u && !u.configured;
  const limitReached = u?.remaining === 0;

  async function ask(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    haptic.tap();
    setText("");
    setMsgs((m) => [...m, { id: seq.current++, role: "user", text: question }]);
    setBusy(true);
    try {
      const r = await api.ask(question, conv);
      setConv(r.conversation_id);
      setMsgs((m) => [...m, { id: seq.current++, role: "assistant", text: r.answer, charts: r.charts }]);
      qc.invalidateQueries({ queryKey: ["askUsage"] });
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
    } catch (e: any) {
      setMsgs((m) => [...m, { id: seq.current++, role: "error", text: e?.message || "Something went wrong." }]);
    } finally {
      setBusy(false);
    }
  }

  // A question handed over from a product screen is asked straight away.
  const asked = useRef(false);
  useEffect(() => {
    if (route.params?.prompt && !asked.current && u?.configured) {
      asked.current = true;
      ask(route.params.prompt);
    }
  }, [u?.configured]);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <ScrollView ref={scroll} contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl, maxWidth: 760, width: "100%", alignSelf: "center" }} onContentSizeChange={() => { if (msgs.length) scroll.current?.scrollToEnd({ animated: true }); }}>
        {msgs.length === 0 ? (
          <View>
            <View style={{ alignItems: "center", marginVertical: space.lg }}>
              <View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: t.primarySoft, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="sparkles" size={28} color={t.primary} />
              </View>
              <Text style={[type.title, { color: t.text, marginTop: space.md }]}>Ask StockSense</Text>
              <Text style={[type.body, { color: t.textSecondary, textAlign: "center", marginTop: 4 }]}>
                Questions in your own words, answered from your live forecasts, suppliers and orders.
              </Text>
              {u ? (
                <Text style={[type.caption, { color: t.textMuted, marginTop: 6 }]}>
                  {u.monthly_limit == null ? "Unlimited questions on your plan" : `${u.remaining ?? 0} of ${u.monthly_limit} questions left this month`}
                </Text>
              ) : null}
            </View>
            {notConfigured ? <KeySetup /> : null}
            {limitReached ? <Notice icon="lock-closed-outline" toneName="warning" title="Monthly limit reached">{`Questions reset on ${u?.resets_on}. Pro includes unlimited questions.`}</Notice> : null}
            <Text style={[type.label, { color: t.textMuted, marginTop: space.md, marginBottom: space.sm }]}>Try asking</Text>
            {SUGGESTIONS.map((s) => (
              <Pressable key={s} disabled={!!notConfigured || busy} onPress={() => ask(s)} style={({ pressed }) => ({ opacity: notConfigured ? 0.5 : pressed ? 0.7 : 1 })}>
                <Card style={{ padding: space.md, marginBottom: space.sm, flexDirection: "row", alignItems: "center" }}>
                  <Ionicons name="chatbubble-ellipses-outline" size={17} color={t.primary} style={{ marginRight: 10 }} />
                  <Text style={[type.body, { color: t.text, flex: 1 }]}>{s}</Text>
                  <Ionicons name="arrow-forward" size={16} color={t.textMuted} />
                </Card>
              </Pressable>
            ))}
          </View>
        ) : null}

        {msgs.map((m) =>
          m.role === "user" ? (
            <View key={m.id} style={{ alignSelf: "flex-end", maxWidth: "85%", backgroundColor: t.primary, borderRadius: radius.lg, borderBottomRightRadius: 4, paddingHorizontal: 14, paddingVertical: 10, marginVertical: 6 }}>
              <Text style={[type.body, { color: t.primaryText }]}>{m.text}</Text>
            </View>
          ) : m.role === "error" ? (
            <View key={m.id} style={{ marginVertical: 6 }}>
              <Notice icon="alert-circle-outline" toneName="danger" title="Could not answer">{m.text}</Notice>
            </View>
          ) : (
            <View key={m.id} style={{ flexDirection: "row", marginVertical: 6 }}>
              <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: t.primarySoft, alignItems: "center", justifyContent: "center", marginRight: 8, marginTop: 2 }}>
                <Ionicons name="sparkles" size={14} color={t.primary} />
              </View>
              <Card style={{ flex: 1, padding: space.md, borderTopLeftRadius: 4 }}>
                <Answer text={m.text} />
                {(m.charts ?? []).map((c, i) => (
                  <View key={i} style={{ marginTop: space.md }}>
                    <Text style={[type.captionStrong, { color: t.text, marginBottom: 6 }]}>{c.title}</Text>
                    <AnswerChart chart={c} />
                  </View>
                ))}
              </Card>
            </View>
          )
        )}
        {busy ? (
          <View style={{ flexDirection: "row", alignItems: "center", marginVertical: 8 }}>
            <ActivityIndicator color={t.primary} />
            <Text style={[type.caption, { color: t.textMuted, marginLeft: 8 }]}>Looking at your forecasts…</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={{ flexDirection: "row", alignItems: "flex-end", padding: space.sm, paddingBottom: Math.max(insets.bottom, space.sm), gap: 8, borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.surface }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={notConfigured ? "Ask StockSense is not switched on" : "Ask about stock, orders, suppliers…"}
          placeholderTextColor={t.textMuted}
          editable={!notConfigured}
          multiline
          onSubmitEditing={() => ask(text)}
          blurOnSubmit
          style={[fw(400), { flex: 1, width: 0, maxHeight: 120, backgroundColor: t.surfaceAlt, color: t.text, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15 }]}
        />
        <Pressable
          onPress={() => ask(text)}
          disabled={!text.trim() || busy || !!notConfigured}
          style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.primary, alignItems: "center", justifyContent: "center", opacity: !text.trim() || busy || notConfigured ? 0.45 : 1 }}
        >
          <Ionicons name="arrow-up" size={20} color={t.primaryText} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

/**
 * How to switch Ask StockSense on. The key lives only on the server, never in
 * the app, so it is set in the server's .env file.
 */
export function KeySetup() {
  const t = useTheme();
  const steps: { title: string; body: string; code?: string }[] = [
    { title: "Get a key", body: "Sign in at console.anthropic.com, open API keys and create one. It starts with sk-ant-. Set a monthly spend limit there too." },
    { title: "Add it to the server", body: "On the laptop, open the .env file in the StockSense project folder and fill in this line:", code: "ANTHROPIC_API_KEY=sk-ant-..." },
    { title: "Restart the server", body: "In a terminal in the project folder, run:", code: "docker compose up -d --force-recreate server" },
    { title: "Done", body: "Come back here and ask a question. The same key also turns on AI answers on WhatsApp." },
  ];
  return (
    <Card style={{ borderColor: t.warning, marginBottom: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: space.md }}>
        <Ionicons name="key-outline" size={18} color={t.warning} style={{ marginRight: 8 }} />
        <Text style={[type.bodyStrong, { color: t.text, flex: 1 }]}>Switch on Ask StockSense</Text>
      </View>
      {steps.map((s, i) => (
        <View key={s.title} style={{ flexDirection: "row", marginBottom: i < steps.length - 1 ? space.md : 0 }}>
          <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: t.primarySoft, alignItems: "center", justifyContent: "center", marginRight: 10, marginTop: 1 }}>
            <Text style={[fw(700), { color: t.primary, fontSize: 12 }]}>{i + 1}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[type.captionStrong, { color: t.text }]}>{s.title}</Text>
            <Text style={[type.caption, { color: t.textSecondary, marginTop: 2 }]}>{s.body}</Text>
            {s.code ? (
              <Text selectable style={[type.mono, { color: t.text, backgroundColor: t.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 6, marginTop: 6, overflow: "hidden" }]}>{s.code}</Text>
            ) : null}
          </View>
        </View>
      ))}
      <Text style={[type.caption, { color: t.textMuted, marginTop: space.md }]}>The key stays on your server; the app never sees it. Everything else in StockSense works without it.</Text>
    </Card>
  );
}
