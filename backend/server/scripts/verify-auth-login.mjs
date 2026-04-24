import { createClient } from "@supabase/supabase-js";

import "../config/load-env.js";

process.on("unhandledRejection", (reason) => {
  console.error("[script] Unhandled promise rejection:", reason);
  process.exit(1);
});

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function main() {
  const supabaseUrl = getRequiredEnv("VITE_SUPABASE_URL");
  const anonKey = getRequiredEnv("VITE_SUPABASE_PUBLISHABLE_KEY");
  const email = process.argv[2]?.trim() || getRequiredEnv("INITIAL_OPERATOR_EMAIL");
  const password = process.argv[3]?.trim() || getRequiredEnv("INITIAL_OPERATOR_PASSWORD");

  const publicClient = createClient(supabaseUrl, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const { data, error } = await publicClient.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    throw error;
  }

  await publicClient.auth.signOut();

  console.log(
    JSON.stringify(
      {
        email,
        userId: data.user.id,
        sessionCreated: Boolean(data.session?.access_token),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("[verify-auth-login] Failed", error);
  process.exitCode = 1;
});
