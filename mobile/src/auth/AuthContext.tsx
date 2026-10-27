import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { configureApi } from "../api/client";
import { DEFAULT_API_URL } from "../config";
import { storage } from "./storage";

/**
 * Holds the server URL and the bearer token, persisted in the phone's secure
 * storage (or browser storage on web) so the app opens straight to the
 * dashboard next time.
 */
interface AuthState {
  ready: boolean;
  token: string | null;
  apiUrl: string;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
  setApiUrl: (url: string) => Promise<void>;
}

const KEY_TOKEN = "ss_token";
const KEY_URL = "ss_api_url";

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [apiUrl, setApiUrlState] = useState(DEFAULT_API_URL);

  useEffect(() => {
    (async () => {
      const [t, u] = await Promise.all([storage.get(KEY_TOKEN), storage.get(KEY_URL)]);
      const url = u || DEFAULT_API_URL;
      configureApi({ baseUrl: url, token: t });
      setToken(t);
      setApiUrlState(url);
      setReady(true);
    })();
  }, []);

  const signIn = useCallback(async (t: string) => {
    await storage.set(KEY_TOKEN, t);
    configureApi({ token: t });
    setToken(t);
  }, []);

  const signOut = useCallback(async () => {
    await storage.remove(KEY_TOKEN);
    configureApi({ token: null });
    setToken(null);
  }, []);

  const setApiUrl = useCallback(async (url: string) => {
    const clean = url.trim().replace(/\/+$/, "");
    await storage.set(KEY_URL, clean);
    configureApi({ baseUrl: clean });
    setApiUrlState(clean);
  }, []);

  const value = useMemo(
    () => ({ ready, token, apiUrl, signIn, signOut, setApiUrl }),
    [ready, token, apiUrl, signIn, signOut, setApiUrl]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
