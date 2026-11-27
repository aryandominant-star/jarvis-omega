import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Api, hasToken, setToken, setUnauthorizedHandler, type Me } from "./api";

interface AuthState {
  me: Me | null;
  loading: boolean;
  signIn: (u: string, p: string, remember: boolean) => Promise<void>;
  signUp: (u: string, p: string, remember: boolean, invite?: string) => Promise<void>;
  signOut: (everywhere?: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  setMe: (m: Me) => void;
}

const Ctx = createContext<AuthState>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(hasToken());

  const refresh = useCallback(async () => {
    if (!hasToken()) { setMe(null); setLoading(false); return; }
    try { setMe(await Api.me()); } catch { /* 401 handled globally */ } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    refresh();
  }, [refresh]);

  const signIn = async (u: string, p: string, remember: boolean) => {
    const r = await Api.login(u, p);
    setToken(r.token, remember);
    setMe(await Api.me());
  };
  const signUp = async (u: string, p: string, remember: boolean, invite?: string) => {
    const r = await Api.register(u, p, invite);
    setToken(r.token, remember);
    setMe(await Api.me());
  };
  const signOut = async (everywhere = false) => {
    try { await (everywhere ? Api.logoutAll() : Api.logout()); } catch { /* ignore */ }
    setToken(null);
    setMe(null);
  };

  return <Ctx.Provider value={{ me, loading, signIn, signUp, signOut, refresh, setMe }}>{children}</Ctx.Provider>;
}
