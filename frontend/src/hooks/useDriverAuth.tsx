import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { driverSupabase } from "@/integrations/supabase/driver-client";
import { registerDriverAccount, updateDriverProfile } from "@/services/loadClaims";

interface DriverProfileInput {
  full_name: string;
  phone: string;
  document_number?: string;
  vehicle_profile: string;
  documents_valid: boolean;
  antt_valid: boolean;
  tracking_enabled: boolean;
  insurance_valid: boolean;
  monitoring_capable: boolean;
  allowed_regions: string[];
  metadata?: Record<string, unknown>;
}

interface DriverAuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  register: (email: string, password: string, profile: DriverProfileInput) => Promise<void>;
  updateProfile: (profile: DriverProfileInput) => Promise<void>;
}

const DriverAuthContext = createContext<DriverAuthContextValue | undefined>(undefined);

function assertDriverRole(user: User | null) {
  if (!user) return; // no session — let the auth flow handle this
  // Only trust app_metadata — user_metadata is writable by the authenticated user.
  const role = user?.app_metadata?.role || null;

  if (role !== "driver") {
    throw new Error("Esta conta não é um motorista habilitado para o portal.");
  }
}

export function DriverAuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const syncSession = (nextSession: Session | null) => {
      if (!isMounted) {
        return;
      }

      const nextUser = nextSession?.user ?? null;
      setSession(nextSession);
      setUser(nextUser);
      setLoading(false);
    };

    driverSupabase.auth
      .getSession()
      .then(({ data: { session: currentSession } }) => {
        assertDriverRole(currentSession?.user ?? null);
        syncSession(currentSession);
      })
      .catch(() => {
        syncSession(null);
      });

    const {
      data: { subscription },
    } = driverSupabase.auth.onAuthStateChange((_event, nextSession) => {
      try {
        assertDriverRole(nextSession?.user ?? null);
        syncSession(nextSession);
      } catch {
        void driverSupabase.auth.signOut();
        syncSession(null);
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<DriverAuthContextValue>(() => {
    const signIn = async (email: string, password: string) => {
      const { data, error } = await driverSupabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        throw error;
      }

      assertDriverRole(data.user);
    };

    const signOut = async () => {
      await driverSupabase.auth.signOut();
    };

    const register = async (email: string, password: string, profile: DriverProfileInput) => {
      await registerDriverAccount({
        email,
        password,
        profile,
      });

      await signIn(email, password);
    };

    const updateProfile = async (profile: DriverProfileInput) => {
      const { data: { session: currentSession } } = await driverSupabase.auth.getSession();

      if (!currentSession?.access_token) {
        throw new Error("Sessão do motorista indisponível.");
      }

      await updateDriverProfile(currentSession.access_token, profile);
    };

    return {
      user,
      session,
      loading,
      signIn,
      signOut,
      register,
      updateProfile,
    };
  }, [loading, session, user]);

  return <DriverAuthContext.Provider value={value}>{children}</DriverAuthContext.Provider>;
}

export function useDriverAuth() {
  const context = useContext(DriverAuthContext);

  if (!context) {
    throw new Error("useDriverAuth must be used within a DriverAuthProvider.");
  }

  return context;
}
