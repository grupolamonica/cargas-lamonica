import { createClient } from "@supabase/supabase-js";

import type { Database } from "./types";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./env";

export const driverSupabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    storageKey: "lamonica-driver-auth",
    persistSession: true,
    autoRefreshToken: true,
  },
});
