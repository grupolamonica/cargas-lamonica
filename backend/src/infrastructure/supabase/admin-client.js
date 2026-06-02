import { createClient } from "@supabase/supabase-js";

/**
 * Creates a Supabase client configured with the service-role key.
 *
 * The previous home of this factory was application/google-sheets/google-sheet-loads.js
 * — a misleading location, since it is consumed by every layer that needs to
 * bypass RLS (operator-admin handlers, public-loads handlers, ASPX directory
 * lookups, the bootstrap sheet sync, and the main entrypoint). Centralising it
 * here also fixes the clean-arch violation flagged in AUDIT.md M-02:
 * infrastructure/aspx/aspx-directory.js used to import from application/, which
 * inverts the dependency direction.
 *
 * Throws synchronously if SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY are missing
 * so the failure mode is loud at startup, not silent at first query.
 */
export function createSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SECRET_KEY?.trim();

  if (!supabaseUrl) {
    throw new Error("Missing required environment variable: SUPABASE_URL");
  }

  if (!serviceRoleKey) {
    throw new Error("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
