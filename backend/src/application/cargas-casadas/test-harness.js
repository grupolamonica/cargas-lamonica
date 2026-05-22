/**
 * Test harness para cargas_casadas — pg-mem.
 *
 * Schema espelha:
 *  - 20260406150000_add_load_claims_system.sql (cargas com reserved_ + booked_)
 *  - 20260409163000_add_driver_visibility_to_cargas.sql (driver_visibility PUBLIC/PREMIUM)
 *  - 20260522000001_create_cargas_casadas.sql (cargas_casadas + viagem_id em cargas)
 *
 * Restricoes: pg-mem nao implementa FOR UPDATE locks reais nem
 * concurrency true — testes focam em logica de negocio sequencial.
 */

import crypto from "node:crypto";

import { DataType, newDb } from "pg-mem";

let db;
let pool;

const schemaSql = `
  CREATE SCHEMA auth;

  CREATE TABLE auth.users (
    id uuid PRIMARY KEY,
    email text
  );

  CREATE TABLE public.security_audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type text NOT NULL,
    severity text NOT NULL DEFAULT 'info',
    actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    actor_role text,
    resource_type text,
    resource_id text,
    action text,
    outcome text NOT NULL,
    request_ip text,
    correlation_id text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.clientes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome text NOT NULL,
    descricao text,
    logo_url text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.cargas_casadas (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text NOT NULL DEFAULT 'rascunho',
    valor_total numeric,
    reserved_driver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    reserved_claim_id uuid,
    booked_driver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    version integer NOT NULL DEFAULT 1,
    published_at timestamptz,
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cargas_casadas_status_check CHECK (
      status IN ('rascunho','publicado','reservado','em_andamento','concluido','cancelado')
    )
  );

  CREATE TABLE public.cargas (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id uuid REFERENCES public.clientes(id) ON DELETE SET NULL,
    data date NOT NULL,
    horario time NOT NULL,
    origem text NOT NULL,
    destino text NOT NULL,
    perfil text NOT NULL DEFAULT 'CARRETA',
    valor numeric,
    bonus numeric,
    bonus_exigencias text,
    driver_visibility text NOT NULL DEFAULT 'PUBLIC',
    status text NOT NULL DEFAULT 'OPEN',
    is_template boolean NOT NULL DEFAULT false,
    distancia_km numeric,
    duracao_horas numeric,
    version integer NOT NULL DEFAULT 0,
    published_at timestamptz,
    reserved_driver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    reserved_claim_id uuid,
    reserved_at timestamptz,
    reserved_until timestamptz,
    booked_driver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    booked_at timestamptz,
    viagem_id uuid REFERENCES public.cargas_casadas(id) ON DELETE SET NULL,
    ordem_viagem integer,
    sheet_lh text,
    sheet_motorista text,
    sheet_status text,
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cargas_status_check CHECK (
      status IN ('DRAFT','OPEN','RESERVED','BOOKED','EXPIRED','CANCELLED','COMPLETED','FAILED')
    )
  );

  CREATE TABLE public.load_claims (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    load_id uuid NOT NULL REFERENCES public.cargas(id) ON DELETE CASCADE,
    driver_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    status text NOT NULL,
    queue_position integer,
    rejected_reason text,
    idempotency_key text,
    request_fingerprint text,
    request_payload_json jsonb,
    correlation_id text,
    server_sequence integer,
    promoted_at timestamptz,
    confirmed_at timestamptz,
    expired_at timestamptz,
    cancelled_at timestamptz,
    reservation_expires_at timestamptz,
    reserved_until timestamptz,
    booked_at timestamptz,
    metadata jsonb,
    claimed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.driver_profiles (
    user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name text,
    vehicle_profile text,
    active boolean NOT NULL DEFAULT true,
    operational_blocked boolean NOT NULL DEFAULT false,
    documents_valid boolean NOT NULL DEFAULT true,
    allowed_regions jsonb,
    antt_valid boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.idempotency_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope text NOT NULL,
    driver_id uuid NOT NULL,
    load_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    correlation_id text,
    response_status integer,
    response_body_json jsonb,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (scope, driver_id, load_id, idempotency_key)
  );

  CREATE TABLE public.load_claim_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    load_id uuid NOT NULL,
    claim_id uuid,
    driver_id uuid,
    event_type text NOT NULL,
    event_payload_json jsonb,
    actor_type text,
    actor_id text,
    correlation_id text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

function createDatabase() {
  db = newDb({ autoCreateForeignKeyIndices: true });

  db.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    impure: true,
    implementation: () => crypto.randomUUID(),
  });

  db.public.none(schemaSql);

  const adapter = db.adapters.createPg();
  pool = new adapter.Pool();
}

function requirePool() {
  if (!pool) createDatabase();
  return pool;
}

export async function resetTestDatabase() {
  if (pool) await pool.end();
  createDatabase();
}

export async function closeTestDatabase() {
  if (!pool) return;
  await pool.end();
  pool = null;
  db = null;
}

export async function withPgClient(callback) {
  const client = await requirePool().connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function withPgTransaction(callback) {
  return withPgClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function query(text, params = []) {
  return requirePool().query(text, params);
}

export async function seedUser({ id = crypto.randomUUID(), email = `${crypto.randomUUID()}@test.local` } = {}) {
  await query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, email]);
  return { id, email };
}

export async function seedCliente(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  await query(
    `INSERT INTO public.clientes (id, nome, descricao) VALUES ($1, $2, $3)`,
    [id, overrides.nome ?? "Cliente Teste", overrides.descricao ?? null],
  );
  return { id };
}

export async function seedCarga(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  await query(
    `INSERT INTO public.cargas (
       id, cliente_id, data, horario, origem, destino, perfil,
       valor, bonus, driver_visibility, status, is_template,
       reserved_driver_id, booked_driver_id, viagem_id, ordem_viagem, created_by, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      id,
      overrides.cliente_id ?? null,
      overrides.data ?? "2026-06-01",
      overrides.horario ?? "08:00:00",
      overrides.origem ?? "Sao Paulo / SP",
      overrides.destino ?? "Salvador / BA",
      overrides.perfil ?? "CARRETA",
      overrides.valor ?? 5000,
      overrides.bonus ?? 200,
      overrides.driver_visibility ?? "PREMIUM",
      overrides.status ?? "OPEN",
      overrides.is_template ?? false,
      overrides.reserved_driver_id ?? null,
      overrides.booked_driver_id ?? null,
      overrides.viagem_id ?? null,
      overrides.ordem_viagem ?? null,
      overrides.created_by ?? null,
      overrides.created_at ?? new Date().toISOString(),
    ],
  );
  return { id };
}

export async function seedPacote(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  await query(
    `INSERT INTO public.cargas_casadas (id, status, valor_total, version, published_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      overrides.status ?? "rascunho",
      overrides.valor_total ?? null,
      overrides.version ?? 1,
      overrides.published_at ?? null,
      overrides.created_by ?? null,
    ],
  );
  return { id };
}

export async function seedLoadClaim(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  await query(
    `INSERT INTO public.load_claims (id, load_id, driver_id, status, queue_position, claimed_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      overrides.load_id,
      overrides.driver_id,
      overrides.status ?? "WAITLISTED",
      overrides.queue_position ?? 1,
      overrides.claimed_at ?? new Date().toISOString(),
    ],
  );
  return { id };
}

export async function seedDriverProfile(overrides = {}) {
  const userId = overrides.user_id ?? crypto.randomUUID();
  // Garante auth.users existe para o FK.
  const { rows: existing } = await query(`SELECT id FROM auth.users WHERE id=$1`, [userId]);
  if (existing.length === 0) {
    await query(
      `INSERT INTO auth.users (id, email) VALUES ($1, $2)`,
      [userId, overrides.email ?? `${crypto.randomUUID()}@test.local`],
    );
  }
  await query(
    `INSERT INTO public.driver_profiles (
       user_id, full_name, vehicle_profile, active, operational_blocked,
       documents_valid, allowed_regions, antt_valid
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      userId,
      overrides.full_name ?? "Driver Teste",
      overrides.vehicle_profile ?? null,
      overrides.active ?? true,
      overrides.operational_blocked ?? false,
      overrides.documents_valid ?? true,
      overrides.allowed_regions ?? null,
      overrides.antt_valid ?? true,
    ],
  );
  return { userId, id: userId };
}
