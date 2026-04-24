import crypto from "node:crypto";

import { DataType, newDb } from "pg-mem";

import { CLAIM_STATUS, LOAD_STATUS } from "./constants.js";

let db;
let pool;
let transactionQueue = Promise.resolve();

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
    tipo_veiculo text,
    exige_antt boolean NOT NULL DEFAULT false,
    exige_rastreamento boolean NOT NULL DEFAULT false,
    exige_seguro boolean NOT NULL DEFAULT false,
    exige_carga_monitorada boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE SEQUENCE public.load_claim_server_sequence_seq AS bigint;

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
    status text NOT NULL DEFAULT 'DRAFT',
    is_template boolean NOT NULL DEFAULT false,
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    distancia_km numeric,
    duracao_horas numeric,
    sheet_lh text,
    sheet_tipo text,
    sheet_synced_at timestamptz,
    sheet_data_carregamento text,
    sheet_data_descarga text,
    version integer NOT NULL DEFAULT 0,
    published_at timestamptz,
    reserved_driver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    reserved_claim_id uuid,
    reserved_public_lead_id uuid,
    reserved_at timestamptz,
    reserved_until timestamptz,
    booked_driver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    booked_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cargas_status_check CHECK (
      status IN ('DRAFT', 'OPEN', 'RESERVED', 'BOOKED', 'EXPIRED', 'CANCELLED', 'COMPLETED', 'FAILED')
    )
  );

  CREATE TABLE public.driver_profiles (
    user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name text NOT NULL,
    phone text,
    document_number text,
    vehicle_profile text NOT NULL DEFAULT 'CARRETA',
    active boolean NOT NULL DEFAULT true,
    documents_valid boolean NOT NULL DEFAULT true,
    antt_valid boolean NOT NULL DEFAULT true,
    tracking_enabled boolean NOT NULL DEFAULT false,
    insurance_valid boolean NOT NULL DEFAULT false,
    monitoring_capable boolean NOT NULL DEFAULT false,
    operational_blocked boolean NOT NULL DEFAULT false,
    allowed_regions text[] NOT NULL DEFAULT '{}'::text[],
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    angellira_status text DEFAULT NULL,
    angellira_valid_until date DEFAULT NULL,
    angellira_status_text text DEFAULT NULL,
    angellira_checked_at timestamptz DEFAULT NULL,
    angellira_details jsonb DEFAULT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.load_claims (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    load_id uuid NOT NULL REFERENCES public.cargas(id) ON DELETE CASCADE,
    driver_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    status text NOT NULL,
    queue_position integer,
    server_sequence bigint NOT NULL DEFAULT nextval('public.load_claim_server_sequence_seq'),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    request_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    claimed_at timestamptz NOT NULL DEFAULT now(),
    promoted_at timestamptz,
    confirmed_at timestamptz,
    expired_at timestamptz,
    rejected_reason text,
    correlation_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT load_claims_status_check CHECK (
      status IN (
        'PENDING',
        'WON_RESERVATION',
        'WAITLISTED',
        'PROMOTED',
        'CONFIRMED',
        'EXPIRED',
        'REJECTED',
        'CANCELLED',
        'FAILED'
      )
    ),
    CONSTRAINT load_claims_queue_position_check CHECK (queue_position IS NULL OR queue_position > 0)
  );

  ALTER TABLE public.cargas
    ADD CONSTRAINT cargas_reserved_claim_id_fkey
    FOREIGN KEY (reserved_claim_id)
    REFERENCES public.load_claims(id)
    ON DELETE SET NULL;

  CREATE TABLE public.load_claim_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    load_id uuid NOT NULL REFERENCES public.cargas(id) ON DELETE CASCADE,
    claim_id uuid REFERENCES public.load_claims(id) ON DELETE SET NULL,
    driver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    event_type text NOT NULL,
    event_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    actor_type text NOT NULL,
    actor_id text,
    correlation_id text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.load_public_leads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    load_id uuid NOT NULL REFERENCES public.cargas(id) ON DELETE CASCADE,
    cpf text NOT NULL,
    phone text NOT NULL,
    horse_plate text NOT NULL,
    trailer_plate text NOT NULL,
    trailer_plate_2 text NOT NULL DEFAULT '',
    vehicle_type text NOT NULL,
    status text NOT NULL DEFAULT 'PRE_REGISTERED',
    pre_registered_at timestamptz NOT NULL DEFAULT now(),
    queued_at timestamptz,
    whatsapp_clicked_at timestamptz,
    approved_at timestamptz,
    approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    pii_redacted_at timestamptz,
    validation_status text NOT NULL DEFAULT 'PENDING',
    validation_checked_at timestamptz,
    validation_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT load_public_leads_status_check CHECK (
      status IN ('PRE_REGISTERED', 'QUEUED', 'APPROVED', 'CANCELLED')
    )
  );

  ALTER TABLE public.cargas
    ADD CONSTRAINT cargas_reserved_public_lead_id_fkey
    FOREIGN KEY (reserved_public_lead_id)
    REFERENCES public.load_public_leads(id)
    ON DELETE SET NULL;

  CREATE TABLE public.load_public_lead_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    load_id uuid NOT NULL REFERENCES public.cargas(id) ON DELETE CASCADE,
    lead_id uuid NOT NULL REFERENCES public.load_public_leads(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    event_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    actor_type text NOT NULL,
    actor_id text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.idempotency_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key text NOT NULL,
    scope text NOT NULL,
    driver_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    load_id uuid NOT NULL REFERENCES public.cargas(id) ON DELETE CASCADE,
    request_hash text NOT NULL,
    response_status integer,
    response_body_json jsonb,
    correlation_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );

  CREATE INDEX idx_cargas_status_reserved_until
    ON public.cargas (status, reserved_until);

  CREATE INDEX idx_load_claims_load_status_order
    ON public.load_claims (load_id, status, server_sequence, claimed_at, id);

  CREATE UNIQUE INDEX ux_load_claims_active_driver_load
    ON public.load_claims (load_id, driver_id)
    WHERE status IN ('WON_RESERVATION', 'WAITLISTED', 'PROMOTED', 'CONFIRMED');

  CREATE UNIQUE INDEX ux_load_claims_active_reservation_per_load
    ON public.load_claims (load_id)
    WHERE status IN ('WON_RESERVATION', 'PROMOTED');

  CREATE UNIQUE INDEX ux_load_claims_waitlist_position
    ON public.load_claims (load_id, queue_position)
    WHERE status = 'WAITLISTED' AND queue_position IS NOT NULL;

  CREATE INDEX idx_load_public_leads_load_status_queue
    ON public.load_public_leads (load_id, status, queued_at, created_at, id);

  CREATE UNIQUE INDEX ux_load_public_leads_active_identity
    ON public.load_public_leads (load_id, cpf, phone, horse_plate, trailer_plate, trailer_plate_2)
    WHERE status IN ('PRE_REGISTERED', 'QUEUED', 'APPROVED');

  CREATE UNIQUE INDEX ux_idempotency_records_scope_key
    ON public.idempotency_records (scope, driver_id, load_id, idempotency_key);

  CREATE TABLE public.vehicles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plate text NOT NULL,
    vehicle_type text,
    plate_role text NOT NULL DEFAULT 'HORSE',
    angellira_status text,
    angellira_valid_until date,
    angellira_status_text text,
    angellira_display_name text,
    angellira_last_seen_at timestamptz,
    angellira_checked_at timestamptz,
    angellira_details jsonb DEFAULT NULL,
    linked_driver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    linked_driver_cpf text,
    source text NOT NULL DEFAULT 'PUBLIC_LEAD',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE UNIQUE INDEX ux_vehicles_plate ON public.vehicles (plate);
`;

function createDatabase() {
  db = newDb({
    autoCreateForeignKeyIndices: true,
  });

  db.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    impure: true,
    implementation: () => crypto.randomUUID(),
  });

  db.public.none(schemaSql);

  const adapter = db.adapters.createPg();
  pool = new adapter.Pool();
  transactionQueue = Promise.resolve();
}

function requirePool() {
  if (!pool) {
    createDatabase();
  }

  return pool;
}

export async function resetTestDatabase() {
  if (pool) {
    await pool.end();
  }

  createDatabase();
}

export async function closeTestDatabase() {
  if (!pool) {
    return;
  }

  await pool.end();
  pool = null;
  db = null;
}

export async function withPgTransaction(callback) {
  const currentPool = requirePool();
  const turn = transactionQueue;
  let releaseTurn;

  transactionQueue = new Promise((resolve) => {
    releaseTurn = resolve;
  });

  await turn;

  const client = await currentPool.connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    releaseTurn();
  }
}

export async function query(text, params = []) {
  const currentPool = requirePool();
  return currentPool.query(text, params);
}

export async function seedUser({ id = crypto.randomUUID(), email = `${crypto.randomUUID()}@driver.test` } = {}) {
  await query(
    `
      INSERT INTO auth.users (id, email)
      VALUES ($1, $2)
    `,
    [id, email],
  );

  return { id, email };
}

export async function seedDriverProfile(overrides = {}) {
  const user = await seedUser({
    id: overrides.userId,
    email: overrides.email,
  });

  await query(
    `
      INSERT INTO public.driver_profiles (
        user_id,
        full_name,
        phone,
        document_number,
        vehicle_profile,
        active,
        documents_valid,
        antt_valid,
        tracking_enabled,
        insurance_valid,
        monitoring_capable,
        operational_blocked,
        allowed_regions,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text[], $14::jsonb)
    `,
    [
      user.id,
      overrides.full_name ?? "Motorista Teste",
      overrides.phone ?? "71999999999",
      overrides.document_number ?? "1234567890",
      overrides.vehicle_profile ?? "CARRETA",
      overrides.active ?? true,
      overrides.documents_valid ?? true,
      overrides.antt_valid ?? true,
      overrides.tracking_enabled ?? true,
      overrides.insurance_valid ?? true,
      overrides.monitoring_capable ?? true,
      overrides.operational_blocked ?? false,
      overrides.allowed_regions ?? ["BA", "SP"],
      JSON.stringify(overrides.metadata ?? {}),
    ],
  );

  return { userId: user.id, email: user.email };
}

export async function seedOperator(overrides = {}) {
  return seedUser({
    id: overrides.userId,
    email: overrides.email ?? `${crypto.randomUUID()}@operator.test`,
  });
}

export async function seedClient(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();

  await query(
    `
      INSERT INTO public.clientes (
        id,
        nome,
        descricao,
        tipo_veiculo,
        exige_antt,
        exige_rastreamento,
        exige_seguro,
        exige_carga_monitorada
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      id,
      overrides.nome ?? "Cliente Teste",
      overrides.descricao ?? "Cliente criado para os testes de claims.",
      overrides.tipo_veiculo ?? "CARRETA",
      overrides.exige_antt ?? false,
      overrides.exige_rastreamento ?? false,
      overrides.exige_seguro ?? false,
      overrides.exige_carga_monitorada ?? false,
    ],
  );

  return { id };
}

export async function seedLoad(overrides = {}) {
  const client = overrides.skipClient ? null : await seedClient({
    id: overrides.cliente_id,
    nome: overrides.cliente_nome,
    descricao: overrides.cliente_descricao,
    tipo_veiculo: overrides.cliente_tipo_veiculo ?? overrides.perfil ?? "CARRETA",
    exige_antt: overrides.cliente_exige_antt ?? false,
    exige_rastreamento: overrides.cliente_exige_rastreamento ?? false,
    exige_seguro: overrides.cliente_exige_seguro ?? false,
    exige_carga_monitorada: overrides.cliente_exige_carga_monitorada ?? false,
  });

  const id = overrides.id ?? crypto.randomUUID();

  await query(
    `
      INSERT INTO public.cargas (
        id,
        cliente_id,
        data,
        horario,
        origem,
        destino,
        perfil,
        valor,
        bonus,
        status,
        is_template,
        version,
        published_at,
        reserved_driver_id,
        reserved_claim_id,
        reserved_at,
        reserved_until,
        booked_driver_id,
        booked_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19
      )
    `,
    [
      id,
      client?.id ?? overrides.cliente_id ?? null,
      overrides.data ?? "2026-04-06",
      overrides.horario ?? "08:00:00",
      overrides.origem ?? "Salvador / BA",
      overrides.destino ?? "Campinas / SP",
      overrides.perfil ?? "CARRETA",
      overrides.valor ?? 7200,
      overrides.bonus ?? 300,
      overrides.status ?? LOAD_STATUS.OPEN,
      overrides.is_template ?? false,
      overrides.version ?? 0,
      overrides.published_at ?? new Date().toISOString(),
      overrides.reserved_driver_id ?? null,
      overrides.reserved_claim_id ?? null,
      overrides.reserved_at ?? null,
      overrides.reserved_until ?? null,
      overrides.booked_driver_id ?? null,
      overrides.booked_at ?? null,
    ],
  );

  return { id, clienteId: client?.id ?? overrides.cliente_id ?? null };
}

export async function expireReservation(loadId, reservedUntil = new Date(Date.now() - 60_000).toISOString()) {
  await query(
    `
      UPDATE public.cargas
      SET reserved_until = $2
      WHERE id = $1
    `,
    [loadId, reservedUntil],
  );
}

export async function updateDriverProfile(userId, updates) {
  const assignments = [];
  const values = [userId];

  Object.entries(updates).forEach(([key, value], index) => {
    assignments.push(`${key} = $${index + 2}`);
    values.push(value);
  });

  await query(
    `
      UPDATE public.driver_profiles
      SET ${assignments.join(", ")}
      WHERE user_id = $1
    `,
    values,
  );
}

export async function getLoad(loadId) {
  const { rows } = await query(
    `
      SELECT *
      FROM public.cargas
      WHERE id = $1
    `,
    [loadId],
  );

  return rows[0] ?? null;
}

export async function getClaim(claimId) {
  const { rows } = await query(
    `
      SELECT *
      FROM public.load_claims
      WHERE id = $1
    `,
    [claimId],
  );

  return rows[0] ?? null;
}

export async function getPublicLead(leadId) {
  const { rows } = await query(
    `
      SELECT *
      FROM public.load_public_leads
      WHERE id = $1
    `,
    [leadId],
  );

  return rows[0] ?? null;
}

export async function getClaimsByLoad(loadId) {
  const { rows } = await query(
    `
      SELECT *
      FROM public.load_claims
      WHERE load_id = $1
      ORDER BY server_sequence ASC, id ASC
    `,
    [loadId],
  );

  return rows;
}

export async function getPublicLeadsByLoad(loadId) {
  const { rows } = await query(
    `
      SELECT *
      FROM public.load_public_leads
      WHERE load_id = $1
      ORDER BY COALESCE(queued_at, created_at) ASC, created_at ASC, id ASC
    `,
    [loadId],
  );

  return rows;
}

export async function getEventsByLoad(loadId) {
  const { rows } = await query(
    `
      SELECT *
      FROM public.load_claim_events
      WHERE load_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [loadId],
  );

  return rows;
}

export async function getPublicLeadEventsByLoad(loadId) {
  const { rows } = await query(
    `
      SELECT *
      FROM public.load_public_lead_events
      WHERE load_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [loadId],
  );

  return rows;
}

export async function getSecurityAuditEvents(eventType = null) {
  const { rows } = eventType
    ? await query(
        `
          SELECT *
          FROM public.security_audit_logs
          WHERE event_type = $1
          ORDER BY created_at ASC, id ASC
        `,
        [eventType],
      )
    : await query(
        `
          SELECT *
          FROM public.security_audit_logs
          ORDER BY created_at ASC, id ASC
        `,
      );

  return rows;
}

export async function getIdempotencyRecords(loadId) {
  const { rows } = await query(
    `
      SELECT *
      FROM public.idempotency_records
      WHERE load_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [loadId],
  );

  return rows;
}

export function buildIdempotencyKey(prefix = "claim") {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function buildDriverBatch(count) {
  return Array.from({ length: count }, (_, index) => ({
    email: `driver-${count}-${index}@test.local`,
    full_name: `Motorista ${count}-${index}`,
  }));
}

export const statusSets = {
  reserving: new Set([CLAIM_STATUS.WON_RESERVATION, CLAIM_STATUS.PROMOTED]),
  waitlisted: new Set([CLAIM_STATUS.WAITLISTED]),
};
