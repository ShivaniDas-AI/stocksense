import { PlatformAdapter } from "./types";
import { bigcommerce } from "./bigcommerce";
import { shopify } from "./shopify";
import { woocommerce } from "./woocommerce";

const adapters: Record<string, PlatformAdapter> = {
  bigcommerce,
  shopify,
  woocommerce,
};

export function getAdapter(platform: string): PlatformAdapter {
  const a = adapters[platform];
  if (!a) throw new Error(`Unknown platform: ${platform}`);
  return a;
}
