/**
 * Plans from the user guide (chapter 13). Billing itself runs through the
 * platform (Shopify Billing); this module only holds what each plan allows
 * and answers "may this store use feature X".
 */
import { queryOne } from "./db";

export type PlanId = "launch" | "scale" | "pro";

export type Feature =
  | "draft_purchase_orders"
  | "lead_time_alerts"
  | "velocity_alerts"
  | "messaging_alerts" // Slack, SMS, WhatsApp
  | "ask"
  | "transfers"
  | "supplier_scorecards"
  | "api"
  | "webhooks"
  | "locations";

export interface PlanInfo {
  id: PlanId;
  name: string;
  price_monthly: number;
  price_yearly: number;
  sku_limit: number | null;
  location_limit: number | null;
  ask_monthly_limit: number | null; // null = unlimited, 0 = not included
  rebuild: "weekly" | "nightly" | "hourly";
  features: Feature[];
}

export const PLANS: Record<PlanId, PlanInfo> = {
  launch: {
    id: "launch", name: "Launch", price_monthly: 15, price_yearly: 127.8,
    sku_limit: 500, location_limit: 1, ask_monthly_limit: 0, rebuild: "weekly",
    features: [],
  },
  scale: {
    id: "scale", name: "Scale", price_monthly: 45, price_yearly: 383.76,
    sku_limit: 10000, location_limit: null, ask_monthly_limit: 100, rebuild: "nightly",
    features: ["draft_purchase_orders", "lead_time_alerts", "velocity_alerts", "messaging_alerts", "ask", "locations"],
  },
  pro: {
    id: "pro", name: "Pro", price_monthly: 120, price_yearly: 1023.48,
    sku_limit: null, location_limit: null, ask_monthly_limit: null, rebuild: "hourly",
    features: [
      "draft_purchase_orders", "lead_time_alerts", "velocity_alerts", "messaging_alerts", "ask",
      "locations", "transfers", "supplier_scorecards", "api", "webhooks",
    ],
  },
};

const FEATURE_PLAN: Record<Feature, string> = {
  draft_purchase_orders: "Scale or Pro",
  lead_time_alerts: "Scale or Pro",
  velocity_alerts: "Scale or Pro",
  messaging_alerts: "Scale or Pro",
  ask: "Scale or Pro",
  locations: "Scale or Pro",
  transfers: "Pro",
  supplier_scorecards: "Pro",
  api: "Pro",
  webhooks: "Pro",
};

export class PlanError extends Error {
  status = 402;
  code = "plan_required";
  constructor(public feature: Feature) {
    super(`This needs the ${FEATURE_PLAN[feature]} plan. Change plan from Plan in the StockSense menu.`);
  }
}

export async function storePlan(storeId: number): Promise<PlanInfo> {
  const s = await queryOne("SELECT plan FROM stores WHERE id=$1", [storeId]);
  return PLANS[(s?.plan as PlanId) || "pro"] ?? PLANS.pro;
}

export async function hasFeature(storeId: number, f: Feature): Promise<boolean> {
  return (await storePlan(storeId)).features.includes(f);
}

export async function requireFeature(storeId: number, f: Feature) {
  if (!(await hasFeature(storeId, f))) throw new PlanError(f);
}
