import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

/**
 * Small key/value store for the session token and server URL.
 * Phones use the OS secure store (Keystore / Keychain). The browser has no
 * such thing, so the web build falls back to localStorage, which is fine for
 * local testing on your own PC.
 */
const isWeb = Platform.OS === "web";

export const storage = {
  async get(key: string): Promise<string | null> {
    if (isWeb) {
      try {
        return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
      } catch {
        return null;
      }
    }
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (isWeb) {
      try {
        localStorage.setItem(key, value);
      } catch {}
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async remove(key: string): Promise<void> {
    if (isWeb) {
      try {
        localStorage.removeItem(key);
      } catch {}
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};
