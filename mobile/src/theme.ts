import { useColorScheme } from "react-native";

/**
 * Design tokens. A restrained, professional palette: neutral surfaces, one
 * brand blue for actions, and semantic colours reserved for meaning
 * (danger / warning / success / info). Light is the default; dark follows
 * the phone's setting.
 */
export interface Theme {
  dark: boolean;
  bg: string; // screen background
  surface: string; // cards
  surfaceAlt: string; // inputs, table headers, subtle fills
  border: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  primary: string;
  primaryText: string; // text on primary
  primarySoft: string; // tinted background for primary
  danger: string;
  dangerSoft: string;
  warning: string;
  warningSoft: string;
  success: string;
  successSoft: string;
  info: string;
  infoSoft: string;
  neutral: string;
  neutralSoft: string;
  accent: string; // untracked / special
  accentSoft: string;
  chartHistory: string;
  chartForecast: string;
  chartGrid: string;
}

export const light: Theme = {
  dark: false,
  bg: "#F4F6F9",
  surface: "#FFFFFF",
  surfaceAlt: "#F1F4F8",
  border: "#E3E8EF",
  text: "#0F172A",
  textSecondary: "#475569",
  textMuted: "#94A3B8",
  primary: "#1D4ED8",
  primaryText: "#FFFFFF",
  primarySoft: "#E6EEFC",
  danger: "#DC2626",
  dangerSoft: "#FEE2E2",
  warning: "#B45309",
  warningSoft: "#FEF3C7",
  success: "#047857",
  successSoft: "#D1FAE5",
  info: "#1D4ED8",
  infoSoft: "#DBEAFE",
  neutral: "#64748B",
  neutralSoft: "#EEF2F6",
  accent: "#6D28D9",
  accentSoft: "#EDE9FE",
  chartHistory: "#64748B",
  chartForecast: "#1D4ED8",
  chartGrid: "#E3E8EF",
};

export const dark: Theme = {
  dark: true,
  bg: "#0B1220",
  surface: "#121B2D",
  surfaceAlt: "#19243A",
  border: "#263349",
  text: "#E6EDF7",
  textSecondary: "#A6B3C8",
  textMuted: "#6E7D96",
  primary: "#60A5FA",
  primaryText: "#0B1220",
  primarySoft: "#1B2A47",
  danger: "#F87171",
  dangerSoft: "#3B1B1F",
  warning: "#FBBF24",
  warningSoft: "#3A2B10",
  success: "#34D399",
  successSoft: "#12352A",
  info: "#60A5FA",
  infoSoft: "#1B2A47",
  neutral: "#94A3B8",
  neutralSoft: "#1C2638",
  accent: "#A78BFA",
  accentSoft: "#2A2144",
  chartHistory: "#94A3B8",
  chartForecast: "#60A5FA",
  chartGrid: "#263349",
};

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

export type RiskLevel = "critical" | "low_stock" | "healthy" | "overstocked" | "no_demand" | "untracked";

export const riskMeta: Record<RiskLevel, { label: string; tone: "danger" | "warning" | "success" | "info" | "neutral" | "accent"; hint: string }> = {
  critical: { label: "Critical", tone: "danger", hint: "Runs out before a reorder can arrive" },
  low_stock: { label: "Low stock", tone: "warning", hint: "At or below the reorder point" },
  healthy: { label: "Healthy", tone: "success", hint: "Enough cover for the lead time" },
  overstocked: { label: "Overstocked", tone: "info", hint: "More than 120 days of cover" },
  no_demand: { label: "No demand", tone: "neutral", hint: "No forecast demand" },
  untracked: { label: "Untracked", tone: "accent", hint: "Stock not tracked in your store" },
};

export function tone(t: Theme, name: "danger" | "warning" | "success" | "info" | "neutral" | "accent" | "primary") {
  switch (name) {
    case "danger": return { fg: t.danger, bg: t.dangerSoft };
    case "warning": return { fg: t.warning, bg: t.warningSoft };
    case "success": return { fg: t.success, bg: t.successSoft };
    case "info": return { fg: t.info, bg: t.infoSoft };
    case "accent": return { fg: t.accent, bg: t.accentSoft };
    case "primary": return { fg: t.primary, bg: t.primarySoft };
    default: return { fg: t.neutral, bg: t.neutralSoft };
  }
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };

export const type = {
  display: { fontSize: 28, fontWeight: "800" as const, letterSpacing: -0.5 },
  title: { fontSize: 22, fontWeight: "700" as const, letterSpacing: -0.3 },
  heading: { fontSize: 16, fontWeight: "700" as const },
  body: { fontSize: 15, fontWeight: "400" as const, lineHeight: 21 },
  bodyStrong: { fontSize: 15, fontWeight: "600" as const },
  caption: { fontSize: 13, fontWeight: "400" as const, lineHeight: 18 },
  label: { fontSize: 11, fontWeight: "600" as const, letterSpacing: 0.6, textTransform: "uppercase" as const },
  kpi: { fontSize: 24, fontWeight: "800" as const, letterSpacing: -0.5 },
};

/** Soft shadow for cards (iOS) + elevation (Android). */
export const shadow = {
  shadowColor: "#0F172A",
  shadowOpacity: 0.06,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 2 },
  elevation: 2,
};
