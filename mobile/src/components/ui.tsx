import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewProps,
  ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radius, riskMeta, RiskLevel, shadow, space, tone, type, useTheme } from "../theme";

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
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.lg, marginBottom: space.sm }}>
      <Text style={[type.label, { color: t.textMuted }]}>{children}</Text>
      {action}
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
}: {
  label: string;
  value: string;
  sub?: string;
  icon: IconName;
  toneName?: "danger" | "warning" | "success" | "info" | "neutral" | "accent" | "primary";
  delta?: { value: number; label?: string } | null;
  style?: ViewStyle;
}) {
  const t = useTheme();
  const c = tone(t, toneName);
  const up = (delta?.value ?? 0) >= 0;
  return (
    <Card style={[{ flex: 1, minWidth: "46%", padding: space.md }, style]}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={[type.label, { color: t.textMuted, flex: 1 }]} numberOfLines={1}>{label}</Text>
        <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: c.bg, alignItems: "center", justifyContent: "center" }}>
          <Ionicons name={icon} size={15} color={c.fg} />
        </View>
      </View>
      <Text style={[type.kpi, { color: t.text, marginTop: 6 }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", marginTop: 2, minHeight: 16 }}>
        {delta ? (
          <View style={{ flexDirection: "row", alignItems: "center", marginRight: 6 }}>
            <Ionicons name={up ? "arrow-up" : "arrow-down"} size={11} color={up ? t.success : t.danger} />
            <Text style={{ color: up ? t.success : t.danger, fontSize: 12, fontWeight: "700" }}>{Math.abs(delta.value)}%</Text>
          </View>
        ) : null}
        {sub ? <Text style={[type.caption, { color: t.textSecondary, flex: 1 }]} numberOfLines={1}>{sub}</Text> : null}
      </View>
    </Card>
  );
}

/* ---------- badges, chips, pills ---------- */

export function RiskBadge({ level, size = "sm" }: { level: RiskLevel; size?: "sm" | "md" }) {
  const t = useTheme();
  const m = riskMeta[level] ?? riskMeta.no_demand;
  const c = tone(t, m.tone);
  return (
    <View style={{ backgroundColor: c.bg, borderRadius: radius.pill, paddingHorizontal: size === "md" ? 12 : 9, paddingVertical: size === "md" ? 5 : 3, alignSelf: "flex-start", flexDirection: "row", alignItems: "center" }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.fg, marginRight: 6 }} />
      <Text style={{ color: c.fg, fontSize: size === "md" ? 13 : 11, fontWeight: "700" }}>{m.label}</Text>
    </View>
  );
}

export function Chip({ label, active, onPress, count }: { label: string; active: boolean; onPress: () => void; count?: number }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
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
      <Text style={{ color: active ? t.primaryText : t.textSecondary, fontSize: 13, fontWeight: active ? "700" : "500" }}>{label}</Text>
      {count !== undefined ? (
        <Text style={{ color: active ? t.primaryText : t.textMuted, fontSize: 12, marginLeft: 6, opacity: 0.9 }}>{count}</Text>
      ) : null}
    </Pressable>
  );
}

export function Pill({ icon, children, toneName = "neutral" }: { icon?: IconName; children: string; toneName?: "danger" | "warning" | "success" | "info" | "neutral" | "accent" | "primary" }) {
  const t = useTheme();
  const c = tone(t, toneName);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: c.bg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 }}>
      {icon ? <Ionicons name={icon} size={12} color={c.fg} style={{ marginRight: 4 }} /> : null}
      <Text style={{ color: c.fg, fontSize: 12, fontWeight: "600" }}>{children}</Text>
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
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  icon?: IconName;
  style?: ViewStyle;
}) {
  const t = useTheme();
  const bg = variant === "primary" ? t.primary : t.surface;
  const fg = variant === "primary" ? t.primaryText : variant === "danger" ? t.danger : t.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderWidth: variant === "primary" ? 0 : 1,
          borderColor: variant === "danger" ? t.dangerSoft : t.border,
          borderRadius: radius.md,
          minHeight: 48,
          paddingHorizontal: 18,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          opacity: pressed || disabled ? 0.75 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={17} color={fg} style={{ marginRight: 8 }} /> : null}
          <Text style={{ color: fg, fontSize: 15, fontWeight: "700" }}>{title}</Text>
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
    <Pressable onPress={onPress} disabled={disabled} style={{ width: 40, height: 44, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.4 : 1 }}>
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
          style={{ flex: 1, textAlign: "center", color: t.text, fontSize: 16, fontWeight: "700", paddingVertical: 10 }}
        />
        {btn("add", () => onChange(value + 1))}
      </View>
      {unit ? <Text style={[type.caption, { color: t.textMuted, marginTop: 4, textAlign: "center" }]}>{unit}</Text> : null}
    </View>
  );
}

/* ---------- list rows ---------- */

export function Row({ icon, title, subtitle, right, onPress, toneName = "neutral", last }: { icon?: IconName; title: string; subtitle?: string; right?: React.ReactNode; onPress?: () => void; toneName?: "danger" | "warning" | "success" | "info" | "neutral" | "accent" | "primary"; last?: boolean }) {
  const t = useTheme();
  const c = tone(t, toneName);
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", paddingVertical: 12, borderBottomWidth: last ? 0 : 1, borderBottomColor: t.border, opacity: pressed ? 0.7 : 1 })}>
      {icon ? (
        <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: c.bg, alignItems: "center", justifyContent: "center", marginRight: 12 }}>
          <Ionicons name={icon} size={17} color={c.fg} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={[type.caption, { color: t.textSecondary }]} numberOfLines={1}>{subtitle}</Text> : null}
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
  toneName?: "danger" | "warning" | "success" | "info" | "neutral" | "accent" | "primary";
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

export function Notice({ icon = "information-circle", toneName = "accent", title, children }: { icon?: IconName; toneName?: "danger" | "warning" | "success" | "info" | "neutral" | "accent" | "primary"; title?: string; children: React.ReactNode }) {
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

export const styles = StyleSheet.create({});
