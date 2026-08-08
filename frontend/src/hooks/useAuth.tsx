import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { reportSignedIn, reportSigningOut } from "@/lib/authSessionBeacon";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function getSessionUser(session: Session | null) {
  return session?.user ?? null;
}

async function resolveCurrentUser(session: Session | null) {
  if (!session) {
    return null;
  }

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    return user ?? getSessionUser(session);
  } catch {
    return getSessionUser(session);
  }
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const syncSession = async (session: Session | null) => {
      const nextUser = await resolveCurrentUser(session);

      if (!isMounted) {
        return;
      }

      setUser(nextUser);
      setLoading(false);
    };

    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        return syncSession(session);
      })
      .catch((err: unknown) => {
        if (import.meta.env.DEV) console.error("[useAuth] Falha ao recuperar sessao inicial:", err);

        if (!isMounted) {
          return;
        }

        setUser(null);
        setLoading(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      // Beacon de auditoria (DC-283 / ALTO-16) — deduplicado por token, então
      // reidratação de storage e refresh não viram "login" novo.
      reportSignedIn(session?.access_token);
      void syncSession(session);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    // ANTES do signOut: depois não há mais token pra provar quem estava saindo.
    const { data } = await supabase.auth.getSession();
    reportSigningOut(data.session?.access_token);
    await supabase.auth.signOut();
  };

  return <AuthContext.Provider value={{ user, loading, signOut }}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider.");
  }

  return context;
};
