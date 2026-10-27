/** Same palette as the web dashboard so the two feel like one product. */
export const colors = {
  bg: "#070b12",
  panel: "#0c1420",
  panel2: "#101b2a",
  line: "#1a2940",
  text: "#e8eef7",
  dim: "#8295ad",
  green: "#2ee88a",
  greenDim: "#153826",
  red: "#ff5a5a",
  amber: "#ffb020",
  blue: "#4aa3ff",
  purple: "#b48aff",
  onGreen: "#07140c",
};

export type RiskLevel =
  | "critical"
  | "low_stock"
  | "healthy"
  | "overstocked"
  | "no_demand"
  | "untracked";

export const riskStyle: Record<RiskLevel, { bg: string; fg: string; label: string }> = {
  critical: { bg: "#3a1420", fg: colors.red, label: "critical" },
  low_stock: { bg: "#39290f", fg: colors.amber, label: "low stock" },
  healthy: { bg: colors.greenDim, fg: colors.green, label: "healthy" },
  overstocked: { bg: "#1c2340", fg: colors.blue, label: "overstocked" },
  no_demand: { bg: "#1a1f2a", fg: colors.dim, label: "no demand" },
  untracked: { bg: "#2a1f3d", fg: colors.purple, label: "untracked" },
};

export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
