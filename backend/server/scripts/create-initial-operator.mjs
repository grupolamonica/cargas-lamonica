import crypto from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import "../config/load-env.js";
import { normalizeOperatorAccessLevel } from "../services/load-claims/operator-access.js";

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

function createPassword() {
  return `Lamonica@${crypto.randomBytes(9).toString("base64url")}`;
}

async function main() {
  const supabaseUrl = getRequiredEnv("SUPABASE_URL");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const email = process.env.INITIAL_OPERATOR_EMAIL?.trim() || "operador@lamonica.local";
  const password = process.env.INITIAL_OPERATOR_PASSWORD?.trim() || createPassword();
  const accessLevel = normalizeOperatorAccessLevel(process.env.INITIAL_OPERATOR_ACCESS_LEVEL?.trim() || "advanced");

  if (!accessLevel) {
    throw new Error("INITIAL_OPERATOR_ACCESS_LEVEL must be advanced or intermediate.");
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: listData, error: listError } = await adminClient.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (listError) {
    throw listError;
  }

  const existingUser = listData.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());

  if (existingUser) {
    const { data: updatedData, error: updateError } = await adminClient.auth.admin.updateUserById(
      existingUser.id,
      {
        password,
        email_confirm: true,
        app_metadata: {
          role: "operator",
          access_level: accessLevel,
          source: "codex-bootstrap",
        },
        user_metadata: {
          role: "operator",
          access_level: accessLevel,
          source: "codex-bootstrap",
        },
      },
    );

    if (updateError) {
      throw updateError;
    }

    console.log(
      JSON.stringify(
        {
          action: "updated",
          email,
          accessLevel,
          password,
          userId: updatedData.user.id,
        },
        null,
        2,
      ),
    );

    return;
  }

  const { data: createdData, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: {
      role: "operator",
      access_level: accessLevel,
      source: "codex-bootstrap",
    },
    user_metadata: {
      role: "operator",
      access_level: accessLevel,
      source: "codex-bootstrap",
    },
  });

  if (createError) {
    throw createError;
  }

  console.log(
    JSON.stringify(
      {
        action: "created",
        email,
        accessLevel,
        password,
        userId: createdData.user.id,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("[create-initial-operator] Failed", error);
  process.exitCode = 1;
});
