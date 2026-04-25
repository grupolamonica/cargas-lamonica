import { createClient } from "@supabase/supabase-js";

import "../../infrastructure/config/load-env.js";

import { ForbiddenError, UnauthorizedError, ValidationError } from "../../domain/load-claims/errors.js";
import { getOperatorAccessLevel, getUserRole, normalizeOperatorAccessLevel } from "./operator-access.js";

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

let _adminClient = null;

export function getAdminClient() {
  if (!_adminClient) {
    _adminClient = createClient(getRequiredEnv("SUPABASE_URL"), getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return _adminClient;
}

export function getBearerToken(authorizationHeader) {
  const headerValue = authorizationHeader?.trim() || "";

  if (!headerValue) {
    throw new UnauthorizedError("Authorization header is required.");
  }

  const matchedToken = headerValue.match(/^Bearer\s+(.+)$/i);

  if (!matchedToken?.[1]) {
    throw new UnauthorizedError("Authorization header must be a Bearer token.");
  }

  return matchedToken[1];
}

export async function requireDriverSession(authorizationHeader) {
  const accessToken = getBearerToken(authorizationHeader);
  const adminClient = getAdminClient();
  const {
    data: { user },
    error,
  } = await adminClient.auth.getUser(accessToken);

  if (error || !user) {
    throw new UnauthorizedError("Could not validate the current driver session.");
  }

  const role = getUserRole(user);

  if ((role || "").toLowerCase().trim() !== "driver") {
    throw new ForbiddenError("Only authenticated drivers can accept a load.");
  }

  return {
    accessToken,
    user,
  };
}

export async function requireOperatorSession(authorizationHeader) {
  const accessToken = getBearerToken(authorizationHeader);
  const adminClient = getAdminClient();
  const {
    data: { user },
    error,
  } = await adminClient.auth.getUser(accessToken);

  if (error || !user) {
    throw new UnauthorizedError("Could not validate the current operator session.");
  }

  const role = getUserRole(user);

  if ((role || "").toLowerCase().trim() !== "operator") {
    throw new ForbiddenError("Only authenticated operators can perform this operation.");
  }

  const accessLevel = getOperatorAccessLevel(user);

  return {
    accessToken,
    user,
    accessLevel,
  };
}

export async function registerDriverUser({
  email,
  password,
  profile,
}) {
  if (!email?.trim() || !password) {
    throw new ValidationError("Email and password are required to register a driver.");
  }

  const adminClient = getAdminClient();
  const normalizedEmail = email.trim().toLowerCase();

  const { data, error } = await adminClient.auth.admin.createUser({
    email: normalizedEmail,
    password: password,
    email_confirm: true,
    user_metadata: {
      role: "driver",
      source: "driver-portal",
      full_name: profile.full_name,
    },
  });

  if (error) {
    // Supabase returns 422 when email is already registered
    if (error.status === 422 || error.message?.toLowerCase().includes("already been registered") || error.message?.toLowerCase().includes("already registered")) {
      throw new ValidationError("This email is already registered.");
    }
    throw error;
  }

  return data.user;
}

export async function registerOperatorUser({ email, password, accessLevel = "advanced" }) {
  if (!email?.trim() || !password) {
    throw new ValidationError("Email and password are required to register an operator.");
  }

  const normalizedAccessLevel = normalizeOperatorAccessLevel(accessLevel);

  if (!normalizedAccessLevel) {
    throw new ValidationError("Operator access level must be advanced or intermediate.");
  }

  const adminClient = getAdminClient();
  const normalizedEmail = email.trim().toLowerCase();

  const { data, error } = await adminClient.auth.admin.createUser({
    email: normalizedEmail,
    password: password,
    email_confirm: false,
    app_metadata: {
      role: "operator",
      access_level: normalizedAccessLevel,
      source: "admin-signup",
    },
    user_metadata: {
      role: "operator",
      access_level: normalizedAccessLevel,
      source: "admin-signup",
    },
  });

  if (error) {
    // Supabase returns 422 when email is already registered
    if (error.status === 422 || error.message?.toLowerCase().includes("already been registered") || error.message?.toLowerCase().includes("already registered")) {
      throw new ValidationError("This email is already registered.");
    }
    throw error;
  }

  return data.user;
}
