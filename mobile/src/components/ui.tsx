import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, TextInputProps, View, ViewProps } from "react-native";
import { colors, radius, riskStyle, RiskLevel, space } from "../theme";

/* ---------- layout ---------- */

export function Card({ style, ...rest }: ViewProps) {
  return <View style={[styles.card, style]} {...rest} />;
}

export function Stat({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <Card style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, color ? { color } : null]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub ? <Text style={styles.statSub}>{sub}</Text> : null}
    </Card>
  );
}

/* ---------- badges + chips ---------- */

export function RiskBadge({ level }: { level: RiskLevel }) {
  const s = riskStyle[level] ?? riskStyle.no_demand;
  return (
    <View style={[styles.badge, { backgroundColor: s.bg }]}>
      <Text style={[styles.badgeText, { color: s.fg }]}>{s.label}</Text>
    </View>
  );
}

export function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipOn]}>
      <Text style={[styles.chipText, active && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

/* ---------- buttons + inputs ---------- */

export function Button({
  title,
  onPress,
  loading,
  variant = "primary",
  disabled,
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
}) {
  const isPrimary = variant === "primary";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.btn,
        isPrimary && styles.btnPrimary,
        variant === "ghost" && styles.btnGhost,
        variant === "danger" && styles.btnDanger,
        (pressed || disabled) && { opacity: 0.7 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={isPrimary ? colors.onGreen : colors.text} />
      ) : (
        <Text style={[styles.btnText, isPrimary && { color: colors.onGreen }, variant === "danger" && { color: colors.red }]}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Input(props: TextInputProps & { label?: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={{ marginBottom: space.sm }}>
      {label ? <Text style={styles.inputLabel}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.dim}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, style]}
        {...rest}
      />
    </View>
  );
}

/* ---------- full-screen states ---------- */

export function StatusView({
  title,
  body,
  spinner,
  error,
  action,
}: {
  title: string;
  body?: string;
  spinner?: boolean;
  error?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <View style={styles.status}>
      {spinner ? <ActivityIndicator size="large" color={colors.green} style={{ marginBottom: space.md }} /> : null}
      <Text style={[styles.statusTitle, error && { color: colors.red }]}>{title}</Text>
      {body ? <Text style={styles.statusBody}>{body}</Text> : null}
      {action ? <View style={{ marginTop: space.lg, alignSelf: "stretch" }}>{action}</View> : null}
    </View>
  );
}

export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.notice}>
      <Text style={styles.noticeText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: space.md,
  },
  stat: { flex: 1, minWidth: "45%" },
  statLabel: { color: colors.dim, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 },
  statValue: { color: colors.text, fontSize: 24, fontWeight: "800", marginTop: 2 },
  statSub: { color: colors.dim, fontSize: 11, marginTop: 2 },
  badge: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 2, borderRadius: radius.pill },
  badgeText: { fontSize: 11, fontWeight: "700" },
  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginRight: 6,
  },
  chipOn: { backgroundColor: colors.green, borderColor: colors.green },
  chipText: { color: colors.dim, fontSize: 13 },
  chipTextOn: { color: colors.onGreen, fontWeight: "700" },
  btn: {
    borderRadius: radius.sm,
    paddingVertical: 11,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  btnPrimary: { backgroundColor: colors.green },
  btnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.line },
  btnDanger: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#3a1420" },
  btnText: { color: colors.text, fontWeight: "700", fontSize: 14 },
  inputLabel: { color: colors.dim, fontSize: 11, marginBottom: 4 },
  input: {
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  status: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  statusTitle: { color: colors.text, fontWeight: "700", fontSize: 16, textAlign: "center" },
  statusBody: { color: colors.dim, textAlign: "center", marginTop: 6, lineHeight: 20 },
  notice: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line,
    borderLeftWidth: 3,
    borderLeftColor: colors.purple,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.md,
  },
  noticeText: { color: colors.dim, fontSize: 13, lineHeight: 19 },
});
