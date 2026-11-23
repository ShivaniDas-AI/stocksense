import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { Text, TextInput } from "../components/AppText";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHeaderHeight } from "@react-navigation/elements";
import { api, imageSource } from "../api/client";
import type { BotMessage } from "../api/types";
import { Button, Card, Input } from "../components/ui";
import { fw, radius, space, type, useTheme } from "../theme";
import { haptic } from "../utils/haptics";
import { WA_GREEN } from "./WhatsAppScreen";

type Bubble = { id: number; from: "me" | "bot"; msg: BotMessage; at: number };
type ListMsg = Extract<BotMessage, { type: "list" }>;

/** WhatsApp *bold* and _italic_ to styled text. */
function Rich({ text, color }: { text: string; color: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_)/g);
  return (
    <Text style={[type.body, { color, fontSize: 15, lineHeight: 21 }]}>
      {parts.map((p, i) =>
        /^\*[^*]+\*$/.test(p) ? <Text key={i} style={fw(700)}>{p.slice(1, -1)}</Text> : /^_[^_]+_$/.test(p) ? <Text key={i} style={{ fontStyle: "italic" }}>{p.slice(1, -1)}</Text> : p
      )}
    </Text>
  );
}

export function WhatsAppChatScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["whatsapp"], queryFn: api.whatsapp });
  const numbers = status.data?.connected_numbers ?? [];
  const [phone, setPhone] = useState<string | null>(null);
  const [newPhone, setNewPhone] = useState("");
  const [linking, setLinking] = useState(false);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<ListMsg | null>(null);
  const seq = useRef(1);
  const scroll = useRef<any>(null);

  // Chat as the first linked phone unless one was picked.
  useEffect(() => {
    if (!phone && numbers.length) setPhone(numbers[0].phone);
  }, [numbers.length]);

  const push = (from: Bubble["from"], msg: BotMessage) => setBubbles((b) => [...b, { id: seq.current++, from, msg, at: Date.now() }]);

  async function send(input: { text?: string; reply_id?: string; label?: string }, as = phone) {
    if (!as || busy) return;
    push("me", { type: "text", text: input.label ?? input.text ?? "" });
    setBusy(true);
    try {
      const r = await api.whatsappSimulate(as, { text: input.text, reply_id: input.reply_id });
      for (const m of r.replies) push("bot", m);
      qc.invalidateQueries({ queryKey: ["whatsappActivity"] });
    } catch (e: any) {
      push("bot", { type: "text", text: `⚠️ ${e?.message || "Something went wrong."}` });
    } finally {
      setBusy(false);
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
    }
  }

  // Say hi when a chat opens.
  const greeted = useRef<string | null>(null);
  useEffect(() => {
    if (phone && greeted.current !== phone) {
      greeted.current = phone;
      setBubbles([]);
      send({ text: "hi" }, phone);
    }
  }, [phone]);

  async function linkNumber() {
    setLinkErr(null);
    const p = newPhone.replace(/[^\d+]/g, "");
    if (p.replace(/\D/g, "").length < 8) return setLinkErr("Enter the full number with the country code, for example +91 98765 43210.");
    setLinking(true);
    try {
      const code = await api.whatsappLinkCode();
      const r = await api.whatsappSimulate(p, { text: `link ${code.code}` });
      await qc.invalidateQueries({ queryKey: ["whatsapp"] });
      greeted.current = p; // the link reply is the greeting
      setBubbles([{ id: seq.current++, from: "me", msg: { type: "text", text: `link ${code.code}` }, at: Date.now() }, ...r.replies.map((m) => ({ id: seq.current++, from: "bot" as const, msg: m, at: Date.now() }))]);
      setPhone(p);
      haptic.success();
    } catch (e: any) {
      setLinkErr(e?.message || "Could not link that number.");
    } finally {
      setLinking(false);
    }
  }

  const chatBg = t.dark ? "#0B141A" : "#EFEAE2";

  if (status.isPending) return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.bg }}><ActivityIndicator color={t.primary} /></View>;

  /* ---------- no linked phone yet ---------- */
  if (!phone) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: space.lg, maxWidth: 560, width: "100%", alignSelf: "center" }}>
        <View style={{ alignItems: "center", marginVertical: space.xl }}>
          <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: WA_GREEN, alignItems: "center", justifyContent: "center" }}>
            <Ionicons name="logo-whatsapp" size={36} color="#fff" />
          </View>
          <Text style={[type.title, { color: t.text, marginTop: space.md, textAlign: "center" }]}>Link your WhatsApp number</Text>
          <Text style={[type.body, { color: t.textSecondary, textAlign: "center", marginTop: 6 }]}>
            The chat runs as that phone, exactly as it would on WhatsApp. The number also appears under Linked phones, so it works on WhatsApp once Meta is connected.
          </Text>
        </View>
        <Card>
          <Input label="Your WhatsApp number" value={newPhone} onChangeText={setNewPhone} keyboardType="phone-pad" placeholder="+91 98765 43210" error={linkErr} hint="With the country code" />
          <Button title="Link and open the chat" icon="link-outline" onPress={linkNumber} loading={linking} style={{ backgroundColor: "#128C7E" }} />
        </Card>
      </ScrollView>
    );
  }

  /* ---------- chat ---------- */
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: chatBg }} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: t.surface, borderBottomWidth: 1, borderBottomColor: t.border, paddingHorizontal: space.lg, paddingVertical: 10 }}>
        <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: WA_GREEN, alignItems: "center", justifyContent: "center", marginRight: 10 }}>
          <Ionicons name="cube" size={17} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[type.bodyStrong, { color: t.text }]}>StockSense</Text>
          <Text style={[type.caption, { color: t.textMuted }]} numberOfLines={1}>{busy ? "typing…" : `chatting as ${phone}${status.data?.enabled ? "" : " · preview"}`}</Text>
        </View>
        {numbers.length > 1 ? (
          <Pressable
            hitSlop={8}
            onPress={() => {
              const i = numbers.findIndex((n) => n.phone === phone);
              setPhone(numbers[(i + 1) % numbers.length].phone);
            }}
          >
            <Ionicons name="swap-horizontal" size={20} color={t.primary} />
          </Pressable>
        ) : null}
      </View>

      <ScrollView ref={scroll} contentContainerStyle={{ padding: space.md, paddingBottom: space.lg, maxWidth: 680, width: "100%", alignSelf: "center" }} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        {!status.data?.enabled ? (
          <View style={{ alignSelf: "center", backgroundColor: t.dark ? "#1F2C34" : "#FFF5C4", borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 6, marginBottom: space.md, maxWidth: 420 }}>
            <Text style={[type.caption, { color: t.dark ? "#E9EDEF" : "#54656F", textAlign: "center" }]}>
              Preview: replies come from your StockSense server exactly as WhatsApp would show them. Approvals here are real.
            </Text>
          </View>
        ) : null}
        {bubbles.map((b, i) => (
          <BubbleView
            key={b.id}
            b={b}
            latest={i === bubbles.length - 1 || bubbles.slice(i + 1).every((x) => x.from === "bot")}
            onButton={(id, title) => send({ reply_id: id, label: title })}
            onList={(m) => setSheet(m)}
          />
        ))}
        {busy ? (
          <View style={{ alignSelf: "flex-start", backgroundColor: t.dark ? "#202C33" : "#fff", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, marginTop: 4 }}>
            <ActivityIndicator size="small" color={t.textMuted} />
          </View>
        ) : null}
      </ScrollView>

      <View style={{ flexDirection: "row", alignItems: "center", padding: 8, paddingBottom: Math.max(insets.bottom, 8), gap: 8, backgroundColor: chatBg, maxWidth: 680, width: "100%", alignSelf: "center" }}>
        <Pressable onPress={() => send({ text: "menu" })} hitSlop={6} style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: t.surface, alignItems: "center", justifyContent: "center" }}>
          <Ionicons name="menu" size={20} color={t.textSecondary} />
        </Pressable>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Message, or a product name"
          placeholderTextColor={t.textMuted}
          onSubmitEditing={() => { if (text.trim()) { send({ text: text.trim() }); setText(""); } }}
          returnKeyType="send"
          style={[fw(400), { flex: 1, width: 0, backgroundColor: t.surface, color: t.text, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15 }]}
        />
        <Pressable
          disabled={!text.trim() || busy}
          onPress={() => { send({ text: text.trim() }); setText(""); }}
          style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#128C7E", alignItems: "center", justifyContent: "center", opacity: !text.trim() || busy ? 0.5 : 1 }}
        >
          <Ionicons name="send" size={18} color="#fff" />
        </Pressable>
      </View>

      <ListSheet m={sheet} onClose={() => setSheet(null)} onPick={(id, title) => { setSheet(null); send({ reply_id: id, label: title }); }} />
    </KeyboardAvoidingView>
  );
}

function BubbleView({ b, latest, onButton, onList }: { b: Bubble; latest: boolean; onButton: (id: string, title: string) => void; onList: (m: ListMsg) => void }) {
  const t = useTheme();
  const mine = b.from === "me";
  const bg = mine ? (t.dark ? "#005C4B" : "#D9FDD3") : t.dark ? "#202C33" : "#FFFFFF";
  const fg = t.dark ? "#E9EDEF" : "#111B21";
  const m = b.msg;
  const time = new Date(b.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const body = "text" in m ? m.text : m.type === "image" ? m.caption ?? "" : "";
  const action = (title: string, icon: React.ComponentProps<typeof Ionicons>["name"], onPress: () => void, key: string) => (
    <Pressable key={key} onPress={() => { haptic.tap(); onPress(); }} disabled={!latest} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: t.dark ? "#2A3942" : "#E9EDEF", opacity: !latest ? 0.45 : pressed ? 0.6 : 1 })}>
      <Ionicons name={icon} size={15} color={t.dark ? "#53BDEB" : "#027EB5"} style={{ marginRight: 6 }} />
      <Text style={[fw(600), { color: t.dark ? "#53BDEB" : "#027EB5", fontSize: 14 }]}>{title}</Text>
    </Pressable>
  );
  return (
    <View style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "86%", marginVertical: 3 }}>
      <View style={{ backgroundColor: bg, borderRadius: 10, borderTopRightRadius: mine ? 2 : 10, borderTopLeftRadius: mine ? 10 : 2, overflow: "hidden", shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 1, shadowOffset: { width: 0, height: 1 }, elevation: 1, minWidth: 90 }}>
        {m.type === "image" ? <ChartImage url={m.url} /> : null}
        <View style={{ paddingHorizontal: 10, paddingTop: 7, paddingBottom: 5 }}>
          {"header" in m && m.header ? <Text style={[fw(700), { color: fg, fontSize: 15, marginBottom: 2 }]}>{m.header}</Text> : null}
          {body ? <Rich text={body} color={fg} /> : null}
          {"footer" in m && m.footer ? <Text style={[type.caption, { color: t.dark ? "#8696A0" : "#667781", marginTop: 4 }]}>{m.footer}</Text> : null}
          <Text style={{ color: t.dark ? "#8696A0" : "#667781", fontSize: 10, alignSelf: "flex-end", marginTop: 2 }}>
            {time}{mine ? "  ✓✓" : ""}
          </Text>
        </View>
        {m.type === "buttons" ? m.buttons.map((x) => action(x.title, "arrow-undo-outline", () => onButton(x.id, x.title), x.id)) : null}
        {m.type === "list" ? action(m.button, "list", () => onList(m), "list") : null}
      </View>
    </View>
  );
}

function ChartImage({ url }: { url: string }) {
  const t = useTheme();
  const [failed, setFailed] = useState(false);
  if (failed) return <View style={{ padding: 12 }}><Text style={[type.caption, { color: t.textMuted }]}>Chart image could not load.</Text></View>;
  return <Image source={imageSource(url)} style={{ width: 300, maxWidth: "100%", aspectRatio: 16 / 9, backgroundColor: "#fff" }} contentFit="contain" onError={() => setFailed(true)} />;
}

function ListSheet({ m, onClose, onPick }: { m: ListMsg | null; onClose: () => void; onPick: (id: string, title: string) => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={!!m} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(2,6,23,0.45)", justifyContent: "flex-end" }}>
        <Pressable onPress={() => {}} style={{ backgroundColor: t.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: space.lg + insets.bottom, maxHeight: "80%", maxWidth: 680, width: "100%", alignSelf: "center" }}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.border, alignSelf: "center", marginVertical: space.md }} />
          <Text style={[type.heading, { color: t.text, textAlign: "center", marginBottom: space.sm }]}>{m?.button}</Text>
          <ScrollView>
            {m?.sections.map((s, si) => (
              <View key={si}>
                {s.title ? <Text style={[type.label, { color: "#128C7E", paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: 4 }]}>{s.title}</Text> : null}
                {s.rows.map((r) => (
                  <Pressable key={r.id} onPress={() => { haptic.tap(); onPick(r.id, r.title); }} style={({ pressed }) => ({ paddingHorizontal: space.lg, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: pressed ? t.surfaceAlt : "transparent", flexDirection: "row", alignItems: "center" })}>
                    <View style={{ flex: 1 }}>
                      <Text style={[type.bodyStrong, { color: t.text }]}>{r.title}</Text>
                      {r.description ? <Text style={[type.caption, { color: t.textSecondary }]}>{r.description}</Text> : null}
                    </View>
                    <Ionicons name="radio-button-off" size={18} color={t.textMuted} />
                  </Pressable>
                ))}
              </View>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

