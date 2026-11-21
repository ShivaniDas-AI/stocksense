import { Platform, useColorScheme } from "react-native";

/**
 * Design tokens. A restrained, professional palette: neutral surfaces, one
 * brand blue for actions, and semantic colours reserved for meaning
 * (danger / warning / success / info). Light is the default; dark follows
 * the phone's setting. Type is Inter, loaded in App.tsx.
 */
export interface Theme {
  dark: boolean;
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  primary: string;
  primaryText: string;
  primarySoft: string;
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
  accent: string;
  accentSoft: string;
  chartHistory: string;
  chartForecast: string;
  chartGrid: string;
  skeleton: string;
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
  skeleton: "#E6EAF0",
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
  skeleton: "#1E2A40",
};

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

export type RiskLevel = "critical" | "low_stock" | "healthy" | "overstocked" | "no_demand" | "untracked";
export type ToneName = "danger" | "warning" | "success" | "info" | "neutral" | "accent" | "primary";

export const riskMeta: Record<RiskLevel, { label: string; tone: ToneName; hint: string }> = {
  critical: { label: "Critical", tone: "danger", hint: "Runs out before a reorder can arrive" },
  low_stock: { label: "Low stock", tone: "warning", hint: "At or below the reorder point" },
  healthy: { label: "Healthy", tone: "success", hint: "Enough cover for the lead time" },
  overstocked: { label: "Overstocked", tone: "info", hint: "More than 120 days of cover" },
  no_demand: { label: "No demand", tone: "neutral", hint: "No forecast demand" },
  untracked: { label: "Untracked", tone: "accent", hint: "Stock not tracked in your store" },
};

export const RISK_ORDER: RiskLevel[] = ["critical", "low_stock", "healthy", "overstocked", "no_demand", "untracked"];

/** Forecast statuses from /api/v1 (the user guide's wording). */
export type Status = "reorder_now" | "watch" | "healthy" | "overstocked" | "no_sales" | "untracked";
export const STATUS_ORDER: Status[] = ["reorder_now", "watch", "healthy", "overstocked", "no_sales", "untracked"];
export const statusMeta: Record<Status, { label: string; tone: ToneName; hint: string }> = {
  reorder_now: { label: "Reorder now", tone: "danger", hint: "Order now or it runs out before a delivery can arrive" },
  watch: { label: "Watch", tone: "warning", hint: "Runs out within the lead time plus four weeks" },
  healthy: { label: "Healthy", tone: "success", hint: "Enough stock for the lead time and beyond" },
  overstocked: { label: "Overstocked", tone: "info", hint: "More stock than the overstock window needs" },
  no_sales: { label: "No sales", tone: "neutral", hint: "Never sold, so there is no demand to forecast" },
  untracked: { label: "Untracked", tone: "accent", hint: "Stock is not tracked in your store" },
};
export const statusOf = (s: string | null | undefined) => statusMeta[(s as Status)] ?? statusMeta.no_sales;

export function tone(t: Theme, name: ToneName) {
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

/** Inter weights. Each weight is its own family on Android, so set both. */
const FAMILY: Record<400 | 500 | 600 | 700 | 800, string> = {
  400: "Inter_400Regular",
  500: "Inter_500Medium",
  600: "Inter_600SemiBold",
  700: "Inter_700Bold",
  800: "Inter_800ExtraBold",
};
export const fw = (weight: 400 | 500 | 600 | 700 | 800) =>
  Platform.OS === "android"
    ? { fontFamily: FAMILY[weight] }
    : { fontFamily: FAMILY[weight], fontWeight: String(weight) as "400" | "500" | "600" | "700" | "800" };

export const type = {
  display: { ...fw(800), fontSize: 30, letterSpacing: -0.6, lineHeight: 36 },
  title: { ...fw(700), fontSize: 22, letterSpacing: -0.3, lineHeight: 28 },
  heading: { ...fw(600), fontSize: 16, lineHeight: 22 },
  body: { ...fw(400), fontSize: 15, lineHeight: 22 },
  bodyStrong: { ...fw(600), fontSize: 15, lineHeight: 21 },
  caption: { ...fw(400), fontSize: 13, lineHeight: 18 },
  captionStrong: { ...fw(600), fontSize: 13, lineHeight: 18 },
  label: { ...fw(600), fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase" as const, lineHeight: 14 },
  kpi: { ...fw(800), fontSize: 24, letterSpacing: -0.5, lineHeight: 30 },
  mono: { fontFamily: "monospace", fontSize: 12 },
};

export const shadow = {
  shadowColor: "#0F172A",
  shadowOpacity: 0.06,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 3 },
  elevation: 2,
};
