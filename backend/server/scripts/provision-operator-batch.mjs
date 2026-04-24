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

function parseBatchDefinition() {
  const rawBatch = getRequiredEnv("OPERATOR_BATCH_JSON");

  let parsedBatch;

  try {
    parsedBatch = JSON.parse(rawBatch);
  } catch (error) {
    throw new Error(`OPERATOR_BATCH_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsedBatch) || parsedBatch.length === 0) {
    throw new Error("OPERATOR_BATCH_JSON must be a non-empty array.");
  }

  return parsedBatch.map((entry, index) => {
    const email = typeof entry?.email === "string" ? entry.email.trim().toLowerCase() : "";
    const accessLevel = normalizeOperatorAccessLevel(entry?.accessLevel);

    if (!email) {
      throw new Error(`Operator batch entry #${index + 1} is missing a valid email.`);
    }

    if (!accessLevel) {
      throw new Error(`Operator batch entry #${index + 1} must define accessLevel as advanced or intermediate.`);
    }

    return {
      email,
      accessLevel,
    };
  });
}

async function upsertOperatorUser(adminClient, { email, password, accessLevel }) {
  const { data: listData, error: listError } = await adminClient.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (listError) {
    throw listError;
  }

  const existingUser = listData.users.find((user) => user.email?.toLowerCase() === email);
  const metadataPayload = {
    role: "operator",
    access_level: accessLevel,
    source: "internal-batch-provisioning",
    temporary_password: true,
  };

  if (existingUser) {
    const { data, error } = await adminClient.auth.admin.updateUserById(existingUser.id, {
      password,
      email_confirm: true,
      app_metadata: metadataPayload,
      user_metadata: metadataPayload,
    });

    if (error) {
      throw error;
    }

    return {
      action: "updated",
      email,
      accessLevel,
      userId: data.user.id,
    };
  }

  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: metadataPayload,
    user_metadata: metadataPayload,
  });

  if (error) {
    throw error;
  }

  return {
    action: "created",
    email,
    accessLevel,
    userId: data.user.id,
  };
}

async function main() {
  const supabaseUrl = getRequiredEnv("SUPABASE_URL");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const defaultPassword = getRequiredEnv("OPERATOR_BATCH_DEFAULT_PASSWORD");
  const batch = parseBatchDefinition();

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const results = [];

  for (const operator of batch) {
    results.push(
      await upsertOperatorUser(adminClient, {
        ...operator,
        password: defaultPassword,
      }),
    );
  }

  console.log(
    JSON.stringify(
      {
        total: results.length,
        passwordAppliedToAllUsers: true,
        results,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("[provision-operator-batch] Failed", error);
  process.exitCode = 1;
});
