import React from "react";
import { ActivityIndicator, Modal, Pressable, TextInputProps, View, ViewProps, ViewStyle } from "react-native";
import { Text, TextInput } from "./AppText";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { Alert, Platform } from "react-native";
import { fw, radius, riskMeta, RiskLevel, shadow, space, statusOf, tone, ToneName, type, useTheme } from "../theme";
import { haptic } from "../utils/haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export type IconName = React.ComponentProps<typeof Ionicons>["name"];

/* ---------- layout ---------- */

export function Card({ style, ...rest }: ViewProps) {
  const t = useTheme();
  return (
    <View
      style={[
        { backgroundColor: t.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: t.border, padding: space.lg },
        !t.dark && shadow,
        style,
      ]}
      {...rest}
    />
  );
}

export function ScreenHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginBottom: space.lg }}>
      <View style={{ flex: 1, marginRight: space.md }}>
        <Text style={[type.title, { color: t.text }]}>{title}</Text>
        {subtitle ? <Text style={[type.caption, { color: t.textSecondary, marginTop: 2 }]} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export function SectionTitle({ children, action }: { children: string; action?: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.xl, marginBottom: space.sm }}>
      <Text style={[type.label, { color: t.textMuted }]}>{children}</Text>
      {action}
    </View>
  );
}

/** Store avatar: a tinted square with the store's initial. */
export function Avatar({ name, size = 44, toneName = "primary" }: { name: string; size?: number; toneName?: ToneName }) {
  const t = useTheme();
  const c = tone(t, toneName);
  const initial = (name.replace(/^\[.*?\]\s*/, "").trim()[0] || "?").toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.28, backgroundColor: c.bg, alignItems: "center", justifyContent: "center" }}>
      <Text style={[fw(700), { color: c.fg, fontSize: size * 0.42 }]}>{initial}</Text>
    </View>
  );
}

/** Product thumbnail with a neutral fallback. */
export function Thumb({ uri, size = 48 }: { uri?: string | null; size?: number }) {
  const t = useTheme();
  return (
    <View style={{ width: size, height: size, borderRadius: radius.sm, backgroundColor: t.surfaceAlt, overflow: "hidden", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: t.border }}>
      {uri ? (
        <Image source={{ uri }} style={{ width: size, height: size }} contentFit="cover" transition={150} />
      ) : (
        <Ionicons name="cube-outline" size={size * 0.42} color={t.textMuted} />
      )}
    </View>
  );
}

/* ---------- KPI tiles ---------- */

export function KpiTile({
  label,
  value,
  sub,
  icon,
  toneName = "neutral",
  delta,
  style,
  onPress,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: IconName;
  toneName?: ToneName;
  delta?: { value: number; label?: string } | null;
  style?: ViewStyle;
  onPress?: () => void;
}) {
  const t = useTheme();
  const c = tone(t, toneName);
  const up = (delta?.value ?? 0) >= 0;
  const body = (
    <Card style={[{ flex: 1, minWidth: "46%", padding: space.md }, style]}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={[type.label, { color: t.textMuted, flex: 1, marginRight: 6 }]} numberOfLines={2}>{label}</Text>
        <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: c.bg, alignItems: "center", justifyContent: "center" }}>
          <Ionicons name={icon} size={15} color={c.fg} />
        </View>
      </View>
      <Text style={[type.kpi, { color: t.text, marginTop: 6 }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", marginTop: 2, minHeight: 18 }}>
        {delta ? (
          <View style={{ flexDirection: "row", alignItems: "center", marginRight: 6 }}>
            <Ionicons name={up ? "arrow-up" : "arrow-down"} size={11} color={up ? t.success : t.danger} />
            <Text style={[fw(700), { color: up ? t.success : t.danger, fontSize: 12 }]}>{Math.abs(delta.value)}%</Text>
          </View>
        ) : null}
        {sub ? <Text style={[type.caption, { color: t.textSecondary, flex: 1 }]} numberOfLines={2}>{sub}</Text> : null}
      </View>
    </Card>
  );
  if (!onPress) return body;
  return <Pressable onPress={() => { haptic.tap(); onPress(); }} style={({ pressed }) => ({ flex: 1, minWidth: "46%", opacity: pressed ? 0.8 : 1 })}>{body}</Pressable>;
}

/* ---------- badges, chips, pills ---------- */

export function RiskBadge({ level, size = "sm" }: { level: RiskLevel; size?: "sm" | "md" }) {
  const t = useTheme();
  const m = riskMeta[level] ?? riskMeta.no_demand;
  const c = tone(t, m.tone);
  return (
    <View style={{ backgroundColor: c.bg, borderRadius: radius.pill, paddingHorizontal: size === "md" ? 12 : 9, paddingVertical: size === "md" ? 5 : 3, alignSelf: "flex-start", flexDirection: "row", alignItems: "center" }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.fg, marginRight: 6 }} />
      <Text style={[fw(700), { color: c.fg, fontSize: size === "md" ? 13 : 11 }]}>{m.label}</Text>
    </View>
  );
}

export function Chip({ label, active, onPress, count }: { label: string; active: boolean; onPress: () => void; count?: number }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => { haptic.tap(); onPress(); }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        borderRadius: radius.pill,
        paddingHorizontal: 14,
        paddingVertical: 8,
        marginRight: 8,
        backgroundColor: active ? t.primary : t.surface,
        borderWidth: 1,
        borderColor: active ? t.primary : t.border,
      }}
    >
      <Text style={[active ? fw(700) : fw(500), { color: active ? t.primaryText : t.textSecondary, fontSize: 13 }]}>{label}</Text>
      {count !== undefined ? (
        <Text style={[fw(500), { color: active ? t.primaryText : t.textMuted, fontSize: 12, marginLeft: 6, opacity: 0.9 }]}>{count}</Text>
      ) : null}
    </Pressable>
  );
}

export function Pill({ icon, children, toneName = "neutral" }: { icon?: IconName; children: string; toneName?: ToneName }) {
  const t = useTheme();
  const c = tone(t, toneName);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: c.bg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 }}>
      {icon ? <Ionicons name={icon} size={12} color={c.fg} style={{ marginRight: 4 }} /> : null}
      <Text style={[fw(600), { color: c.fg, fontSize: 12 }]}>{children}</Text>
    </View>
  );
}

/* ---------- buttons + inputs ---------- */

export function Button({
  title,
  onPress,
  loading,
  variant = "primary",
  disabled,
  icon,
  style,
  small,
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  icon?: IconName;
  style?: ViewStyle;
  small?: boolean;
}) {
  const t = useTheme();
  const bg = variant === "primary" ? t.primary : t.surface;
  const fg = variant === "primary" ? t.primaryText : variant === "danger" ? t.danger : t.text;
  return (
    <Pressable
      onPress={() => { haptic.tap(); onPress(); }}
      disabled={disabled || loading}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderWidth: variant === "primary" ? 0 : 1,
          borderColor: variant === "danger" ? t.dangerSoft : t.border,
          borderRadius: radius.md,
          minHeight: small ? 38 : 48,
          paddingHorizontal: small ? 14 : 18,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          opacity: pressed || disabled ? 0.7 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={small ? 15 : 17} color={fg} style={{ marginRight: 8 }} /> : null}
          <Text style={[fw(700), { color: fg, fontSize: small ? 13 : 15 }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function Input(props: TextInputProps & { label?: string; hint?: string; error?: string | null; right?: React.ReactNode }) {
  const t = useTheme();
  const { label, hint, error, right, style, ...rest } = props;
  return (
    <View style={{ marginBottom: space.md }}>
      {label ? <Text style={[type.label, { color: t.textMuted, marginBottom: 6 }]}>{label}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <TextInput
          placeholderTextColor={t.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            {
              flex: 1,
              backgroundColor: t.surfaceAlt,
              borderWidth: 1,
              borderColor: error ? t.danger : t.border,
              borderRadius: radius.md,
              color: t.text,
              paddingHorizontal: 14,
              paddingVertical: 12,
              fontSize: 15,
              fontFamily: "Inter_400Regular",
            },
            style,
          ]}
          {...rest}
        />
        {right}
      </View>
      {error ? <Text style={[type.caption, { color: t.danger, marginTop: 4 }]}>{error}</Text> : hint ? <Text style={[type.caption, { color: t.textMuted, marginTop: 4 }]}>{hint}</Text> : null}
    </View>
  );
}

/** Numeric field with − / + steppers, for lead time and safety stock. */
export function Stepper({ label, value, onChange, min = 0, unit }: { label: string; value: number; onChange: (v: number) => void; min?: number; unit?: string }) {
  const t = useTheme();
  const btn = (icon: IconName, onPress: () => void, disabled?: boolean) => (
    <Pressable onPress={() => { haptic.tap(); onPress(); }} disabled={disabled} style={{ width: 42, height: 46, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.35 : 1 }}>
      <Ionicons name={icon} size={18} color={t.primary} />
    </Pressable>
  );
  return (
    <View style={{ flex: 1 }}>
      <Text style={[type.label, { color: t.textMuted, marginBottom: 6 }]}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: t.surfaceAlt, borderWidth: 1, borderColor: t.border, borderRadius: radius.md }}>
        {btn("remove", () => onChange(Math.max(min, value - 1)), value <= min)}
        <TextInput
          value={String(value)}
          onChangeText={(s) => onChange(Math.max(min, parseInt(s, 10) || 0))}
          keyboardType="number-pad"
          // width 0 + flex 1: on the web an <input> otherwise keeps its default width and pushes the + button out.
          style={[fw(700), { flex: 1, width: 0, minWidth: 0, textAlign: "center", color: t.text, fontSize: 17, paddingVertical: 10 }]}
        />
        {btn("add", () => onChange(value + 1))}
      </View>
      {unit ? <Text style={[type.caption, { color: t.textMuted, marginTop: 4, textAlign: "center" }]}>{unit}</Text> : null}
    </View>
  );
}

/* ---------- list rows ---------- */

export function Row({ icon, title, subtitle, right, onPress, toneName = "neutral", last }: { icon?: IconName; title: string; subtitle?: string; right?: React.ReactNode; onPress?: () => void; toneName?: ToneName; last?: boolean }) {
  const t = useTheme();
  const c = tone(t, toneName);
  return (
    <Pressable onPress={onPress ? () => { haptic.tap(); onPress(); } : undefined} disabled={!onPress} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", paddingVertical: 12, borderBottomWidth: last ? 0 : 1, borderBottomColor: t.border, opacity: pressed ? 0.7 : 1 })}>
      {icon ? (
        <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: c.bg, alignItems: "center", justifyContent: "center", marginRight: 12 }}>
          <Ionicons name={icon} size={17} color={c.fg} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={[type.caption, { color: t.textSecondary }]} numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      {right}
      {onPress && !right ? <Ionicons name="chevron-forward" size={18} color={t.textMuted} /> : null}
    </Pressable>
  );
}

/* ---------- states ---------- */

export function StatusView({
  title,
  body,
  spinner,
  icon,
  toneName = "neutral",
  action,
}: {
  title: string;
  body?: string;
  spinner?: boolean;
  icon?: IconName;
  toneName?: ToneName;
  action?: React.ReactNode;
}) {
  const t = useTheme();
  const c = tone(t, toneName);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxl }}>
      {spinner ? (
        <ActivityIndicator size="large" color={t.primary} style={{ marginBottom: space.lg }} />
      ) : icon ? (
        <View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: c.bg, alignItems: "center", justifyContent: "center", marginBottom: space.lg }}>
          <Ionicons name={icon} size={26} color={c.fg} />
        </View>
      ) : null}
      <Text style={[type.heading, { color: t.text, textAlign: "center" }]}>{title}</Text>
      {body ? <Text style={[type.body, { color: t.textSecondary, textAlign: "center", marginTop: 6 }]}>{body}</Text> : null}
      {action ? <View style={{ marginTop: space.xl, alignSelf: "stretch" }}>{action}</View> : null}
    </View>
  );
}

export function Notice({ icon = "information-circle", toneName = "accent", title, children }: { icon?: IconName; toneName?: ToneName; title?: string; children: React.ReactNode }) {
  const t = useTheme();
  const c = tone(t, toneName);
  return (
    <View style={{ flexDirection: "row", backgroundColor: c.bg, borderRadius: radius.md, padding: space.md, marginBottom: space.md }}>
      <Ionicons name={icon} size={18} color={c.fg} style={{ marginRight: 10, marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        {title ? <Text style={[type.bodyStrong, { color: t.text, marginBottom: 2 }]}>{title}</Text> : null}
        <Text style={[type.caption, { color: t.textSecondary }]}>{children}</Text>
      </View>
    </View>
  );
}

/* ---------- bottom sheet for small option lists ---------- */

export function OptionSheet<T extends string>({
  visible,
  title,
  options,
  value,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  options: { key: T; label: string; icon?: IconName }[];
  value: T;
  onSelect: (key: T) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(2,6,23,0.45)", justifyContent: "flex-end" }}>
        <Pressable onPress={() => {}} style={{ backgroundColor: t.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: space.lg, paddingBottom: space.xl + insets.bottom, maxWidth: 680, width: "100%", alignSelf: "center" }}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.border, alignSelf: "center", marginBottom: space.md }} />
          <Text style={[type.heading, { color: t.text, marginBottom: space.sm }]}>{title}</Text>
          {options.map((o, i) => {
            const on = o.key === value;
            return (
              <Pressable key={o.key} onPress={() => { haptic.tap(); onSelect(o.key); onClose(); }} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 13, borderBottomWidth: i < options.length - 1 ? 1 : 0, borderBottomColor: t.border }}>
                {o.icon ? <Ionicons name={o.icon} size={18} color={on ? t.primary : t.textMuted} style={{ marginRight: 12 }} /> : null}
                <Text style={[on ? fw(600) : fw(400), { color: on ? t.primary : t.text, fontSize: 15, flex: 1 }]}>{o.label}</Text>
                {on ? <Ionicons name="checkmark" size={18} color={t.primary} /> : null}
              </Pressable>
            );
          })}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/* ---------- v1 status badge, segmented control, stat ---------- */

/** Badge for a /api/v1 forecast status (reorder_now, watch, healthy ...). */
export function StatusBadge({ status, size = "sm" }: { status: string; size?: "sm" | "md" }) {
  const t = useTheme();
  const m = statusOf(status);
  const c = tone(t, m.tone);
  return (
    <View style={{ backgroundColor: c.bg, borderRadius: radius.pill, paddingHorizontal: size === "md" ? 12 : 9, paddingVertical: size === "md" ? 5 : 3, alignSelf: "flex-start", flexDirection: "row", alignItems: "center" }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.fg, marginRight: 6 }} />
      <Text style={[fw(700), { color: c.fg, fontSize: size === "md" ? 13 : 11 }]}>{m.label}</Text>
    </View>
  );
}

/** Two to four equal options in one rounded track. */
export function Segmented<T extends string>({ options, value, onChange }: { options: { key: T; label: string; count?: number }[]; value: T; onChange: (k: T) => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", backgroundColor: t.surfaceAlt, borderRadius: radius.md, padding: 3, borderWidth: 1, borderColor: t.border }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => { haptic.tap(); onChange(o.key); }}
            style={[{ flex: 1, paddingVertical: 8, borderRadius: radius.sm + 1, alignItems: "center", flexDirection: "row", justifyContent: "center" }, on && { backgroundColor: t.surface }, on && !t.dark && shadow]}
          >
            <Text style={[on ? fw(700) : fw(500), { color: on ? t.text : t.textSecondary, fontSize: 13 }]} numberOfLines={1}>{o.label}</Text>
            {o.count !== undefined ? <Text style={[fw(600), { color: on ? t.primary : t.textMuted, fontSize: 12, marginLeft: 5 }]}>{o.count}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Label over a value, for compact metric rows inside cards. */
export function Stat({ label, value, sub, warn, flex = 1 }: { label: string; value: string; sub?: string; warn?: boolean; flex?: number }) {
  const t = useTheme();
  return (
    <View style={{ flex }}>
      <Text style={[fw(600), { color: t.textMuted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }]} numberOfLines={2}>{label}</Text>
      <Text style={[fw(700), { color: warn ? t.danger : t.text, fontSize: 15, marginTop: 3 }]} numberOfLines={1}>{value}</Text>
      {sub ? <Text style={[type.caption, { color: t.textMuted, fontSize: 11 }]} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

/** Confirm dialog that also works in a browser (Alert.alert has no buttons on web). */
export function confirm(title: string, message: string, ok: string, onOk: () => void, destructive = false) {
  if (Platform.OS === "web") {
    // eslint-disable-next-line no-alert
    if (typeof window !== "undefined" && window.confirm(`${title}\n\n${message}`)) onOk();
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: ok, style: destructive ? "destructive" : "default", onPress: onOk },
  ]);
}

/** One-line message after an action; Alert on phones, window.alert in a browser. */
export function notify(title: string, message?: string) {
  if (Platform.OS === "web") {
    // eslint-disable-next-line no-alert
    if (typeof window !== "undefined") window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message);
}
