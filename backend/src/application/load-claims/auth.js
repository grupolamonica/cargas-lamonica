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

// ── Cache curto + single-flight da verificação de token (getUser) ──
// getUser() roda no GoTrue a CADA request autenticado (= SELECT users/identities/
// sessions/mfa_amr_claims). Os polls do operador (sino 30s, chat 20s/8s, outreach
// 15s, fila 60s, programação 90s) disparam vários verifies/min por aba abertos.
// Um cache curto por token colapsa todos os polls dentro da janela num único
// getUser(). FAIL-SAFE: verificação com erro NUNCA é cacheada (cai no fluxo normal
// → 401/403). TTL curto (default 30s) mantém a defasagem de revogação trivial.
const _tokenVerifyCache = new Map(); // accessToken -> { at, user }
const _tokenVerifyInFlight = new Map(); // accessToken -> Promise<user|null>
const TOKEN_VERIFY_CACHE_MAX = 500;

function getTokenVerifyTtlMs() {
  const raw = Number.parseInt(process.env.AUTH_TOKEN_VERIFY_TTL_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 0) return raw; // override explícito vence (habilita teste)
  if (process.env.VITEST || process.env.NODE_ENV === "test") return 0; // default OFF em teste
  return 30_000; // default produção
}

// Exposto para os testes limparem o estado de módulo entre casos.
export function __resetAuthTokenVerifyCache() {
  _tokenVerifyCache.clear();
  _tokenVerifyInFlight.clear();
}

async function verifyUserCached(accessToken) {
  const ttl = getTokenVerifyTtlMs();

  if (ttl > 0) {
    const cached = _tokenVerifyCache.get(accessToken);
    if (cached && Date.now() - cached.at < ttl) {
      return cached.user;
    }
    const inFlight = _tokenVerifyInFlight.get(accessToken);
    if (inFlight) return inFlight;
  }

  const promise = (async () => {
    const adminClient = getAdminClient();
    const {
      data: { user },
      error,
    } = await adminClient.auth.getUser(accessToken);

    if (error || !user) {
      return null; // fail-safe: não cacheia falha
    }

    if (ttl > 0) {
      if (_tokenVerifyCache.size >= TOKEN_VERIFY_CACHE_MAX) _tokenVerifyCache.clear();
      _tokenVerifyCache.set(accessToken, { at: Date.now(), user });
    }
    return user;
  })();

  if (ttl > 0) {
    _tokenVerifyInFlight.set(accessToken, promise);
    try {
      return await promise;
    } finally {
      _tokenVerifyInFlight.delete(accessToken);
    }
  }

  return promise;
}

export async function requireDriverSession(authorizationHeader) {
  const accessToken = getBearerToken(authorizationHeader);
  const user = await verifyUserCached(accessToken);

  if (!user) {
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
  const user = await verifyUserCached(accessToken);

  if (!user) {
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
    app_metadata: {
      role: "driver",
      source: "driver-portal",
    },
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
