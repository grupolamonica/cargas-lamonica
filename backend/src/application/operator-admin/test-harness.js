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
    logo_url_card text,
    logo_url_proximas text,
    forma_pagamento text,
    prazo_pagamento text,
    exige_rastreamento boolean NOT NULL DEFAULT false,
    exige_antt boolean NOT NULL DEFAULT false,
    exige_seguro boolean NOT NULL DEFAULT false,
    exige_carga_monitorada boolean NOT NULL DEFAULT false,
    reputacao_pagamento_rapido boolean NOT NULL DEFAULT false,
    reputacao_bom_pagador boolean NOT NULL DEFAULT false,
    reputacao_liberacao_rapida boolean NOT NULL DEFAULT false,
    reputacao_carga_organizada boolean NOT NULL DEFAULT false,
    reputacao_boa_comunicacao boolean NOT NULL DEFAULT false,
    rastreamento text,
    antt text,
    observacoes text,
    tipo_veiculo text,
    peso text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.cargas (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id uuid REFERENCES public.clientes(id) ON DELETE SET NULL,
    data date NOT NULL,
    horario time NOT NULL,
    origem text NOT NULL,
    destino text NOT NULL,
    distancia_km numeric,
    duracao_horas numeric,
    perfil text NOT NULL DEFAULT 'CARRETA',
    valor numeric,
    bonus numeric,
    bonus_exigencias text,
    eixos smallint,
    driver_visibility text NOT NULL DEFAULT 'PUBLIC',
    status text NOT NULL DEFAULT 'DRAFT',
    is_template boolean NOT NULL DEFAULT false,
    sheet_lh text,
    sheet_tipo text,
    sheet_data_carregamento text,
    sheet_data_descarga text,
    sheet_motorista text,
    sheet_cavalo text,
    sheet_carreta text,
    sheet_status text,
    sheet_source text,
    alloc_motorista text,
    alloc_cavalo text,
    alloc_carreta text,
    alloc_status text,
    alloc_tipo text,
    alloc_descricao text,
    alloc_vinculo text,
    alloc_source text,
    alloc_updated_at timestamptz,
    alloc_updated_by uuid,
    alloc_pinned boolean NOT NULL DEFAULT false,
    alloc_pinned_at timestamptz,
    alloc_pinned_by uuid,
    rodopar_status smallint NOT NULL DEFAULT 0,
    rodopar_updated_at timestamptz,
    rodopar_updated_by uuid,
    reserved_public_lead_id uuid,
    reserved_at timestamptz,
    reserved_until timestamptz,
    reserved_driver_id uuid,
    reserved_claim_id uuid,
    sheet_synced_at timestamptz,
    viagem_id uuid,
    ordem_viagem integer,
    is_recurring boolean NOT NULL DEFAULT false,
    recurrence_interval_days integer,
    recurrence_parent_id uuid,
    lh_manual text,
    codigo_viagem text,
    agenda_a_confirmar boolean NOT NULL DEFAULT false,
    version integer NOT NULL DEFAULT 0,
    booked_at timestamptz,
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE UNIQUE INDEX ux_cargas_codigo_viagem ON public.cargas (codigo_viagem);

  CREATE TABLE public.nestle_ofertas (
    codprogcoleta text PRIMARY KEY,
    codembarque text,
    grupos_id text
  );

  CREATE TABLE public.monitor_reservas (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    motorista text NOT NULL DEFAULT '',
    cavalo text NOT NULL DEFAULT '',
    carreta text NOT NULL DEFAULT '',
    origem text NOT NULL DEFAULT '',
    destino text NOT NULL DEFAULT '',
    route_key text NOT NULL DEFAULT '',
    origin_lh text,
    status text NOT NULL DEFAULT 'RESERVA',
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.monitor_rodopar_status (
    lh text PRIMARY KEY,
    status smallint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid
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
    rejected_reason text,
    claimed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.load_claim_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    load_id uuid,
    claim_id uuid,
    driver_id uuid,
    event_type text NOT NULL,
    event_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    actor_type text,
    actor_id text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.cargas_casadas (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text NOT NULL DEFAULT 'rascunho',
    valor_total numeric,
    reserved_driver_id uuid,
    reserved_claim_id uuid,
    booked_driver_id uuid,
    version integer NOT NULL DEFAULT 1,
    published_at timestamptz,
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.route_metrics_cache (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    origin_key text NOT NULL,
    destination_key text NOT NULL,
    origem text NOT NULL,
    destino text NOT NULL,
    distancia_km numeric,
    duracao_horas numeric,
    tempo_estimado_horas numeric,
    perfil_padrao text NOT NULL DEFAULT 'CARRETA',
    valor_padrao numeric,
    bonus_padrao numeric,
    bonus_exigencias text,
    eixos smallint NOT NULL DEFAULT 0,
    ativa boolean NOT NULL DEFAULT true,
    observacoes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT route_metrics_cache_origin_dest_perfil_eixos_unique UNIQUE (origin_key, destination_key, perfil_padrao, eixos)
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
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.load_public_lead_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    load_id uuid NOT NULL,
    lead_id uuid NOT NULL,
    event_type text NOT NULL,
    event_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    actor_type text NOT NULL,
    actor_id text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

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

  CREATE TABLE public.motoristas_historico (
    cpf              TEXT PRIMARY KEY,
    nome             TEXT NOT NULL,
    cnh              TEXT,
    cnh_validade     TEXT,
    cnh_categoria    TEXT,
    cnh_security     TEXT,
    rg               TEXT,
    telefone         TEXT,
    nascimento       TEXT,
    driver_kind      TEXT,
    estado           TEXT,
    cidade           TEXT,
    angellira_query_id   INTEGER,
    angellira_sent_date  TIMESTAMPTZ,
    angellira_limit_date TIMESTAMPTZ,
    raw_json         JSONB,
    aspx_found       BOOLEAN NOT NULL DEFAULT FALSE,
    aspx_display_name TEXT,
    aspx_matched_at  TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE public.sheet_monitor_snapshot (
    id           smallint    PRIMARY KEY DEFAULT 1,
    source       text,
    rows_json    jsonb   NOT NULL DEFAULT '[]'::jsonb,
    summary_json jsonb   NOT NULL DEFAULT '{}'::jsonb,
    synced_at    timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.pending_driver_registrations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    id_cadastro text,
    status text NOT NULL DEFAULT 'draft',
    versao_cadastro text,
    observacoes text,
    dados jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.driver_outreach_optout (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_key text NOT NULL,
    phone text,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid,
    CONSTRAINT driver_outreach_optout_key_uniq UNIQUE (driver_key)
  );

  CREATE TABLE public.driver_outreach_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_key text NOT NULL,
    trigger text NOT NULL,
    channel text NOT NULL DEFAULT 'wa_link',
    status text NOT NULL DEFAULT 'sent',
    phone text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    correlation_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid
  );

  CREATE TABLE public.pending_driver_outreach (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_key text NOT NULL,
    trigger text NOT NULL,
    phone text NOT NULL,
    message text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    retry_count int NOT NULL DEFAULT 0,
    next_attempt_at timestamptz,
    last_error text,
    correlation_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}',
    CONSTRAINT pending_driver_outreach_uniq UNIQUE (driver_key, trigger)
  );

  CREATE TABLE public.driver_outreach_settings (
    id smallint PRIMARY KEY DEFAULT 1,
    enabled boolean NOT NULL DEFAULT false,
    cold_enabled boolean NOT NULL DEFAULT false,
    daily_cap int NOT NULL DEFAULT 50,
    quiet_start_hour int NOT NULL DEFAULT 8,
    quiet_end_hour int NOT NULL DEFAULT 20,
    route_need_enabled boolean NOT NULL DEFAULT false,
    route_need_days_ahead int NOT NULL DEFAULT 3,
    route_need_wave_size int NOT NULL DEFAULT 5,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid
  );

  CREATE TABLE public.whatsapp_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    instance text NOT NULL,
    direction text NOT NULL,
    external_id text,
    phone text NOT NULL,
    driver_key text,
    text text NOT NULL DEFAULT '',
    message_type text NOT NULL DEFAULT 'text',
    status text NOT NULL DEFAULT 'received',
    timestamp timestamptz NOT NULL DEFAULT now(),
    raw jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.repom_flow_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cpf text,
    phone text,
    flow_id uuid,
    current_node text,
    variables jsonb NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'active',
    registration_id uuid,
    last_inbound_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.app_settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
  );

  CREATE TABLE public.repom_processed_messages (
    external_id text PRIMARY KEY,
    phone text,
    kind text NOT NULL DEFAULT 'media',
    file_sha256 text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.operator_notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    metadata jsonb NOT NULL DEFAULT '{}',
    seen boolean NOT NULL DEFAULT false,
    seen_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE public.driver_outreach_message_templates (
    key text PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT true,
    template text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid
  );

  CREATE TABLE public.driver_return_interests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_key text NOT NULL,
    phone text NOT NULL,
    nome text,
    origem text,
    destino text,
    rota text,
    source text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
    matched_at timestamptz,
    matched_load_id uuid
  );
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

  // pg-mem does not implement btrim natively (Postgres' trim). Register the
  // single-arg form used by the reserva use-cases (btrim(text) trims whitespace).
  db.public.registerFunction({
    name: "btrim",
    args: [DataType.text],
    returns: DataType.text,
    implementation: (value) => (value == null ? value : String(value).trim()),
  });

  // pg-mem does not implement jsonb_build_object natively.
  // Register for the arity used in fetchOperatorHistoricoDriverSummaries (14 key-value pairs = 28 text args).
  db.public.registerFunction({
    name: "jsonb_build_object",
    args: Array(28).fill(DataType.text),
    returns: DataType.jsonb,
    implementation: (...kv) => {
      const result = {};
      for (let i = 0; i < kv.length; i += 2) {
        if (kv[i] != null) result[kv[i]] = kv[i + 1] ?? null;
      }
      return result;
    },
  });

  db.public.none(schemaSql);

  const adapter = db.adapters.createPg();
  pool = new adapter.Pool();
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
  await query(
    `
      INSERT INTO auth.users (id, email)
      VALUES ($1, $2)
    `,
    [id, email],
  );

  return { id, email };
}

export async function seedCliente(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();

  await query(
    `
      INSERT INTO public.clientes (
        id,
        nome,
        descricao,
        logo_url,
        forma_pagamento,
        prazo_pagamento,
        exige_rastreamento,
        exige_antt,
        exige_seguro,
        exige_carga_monitorada,
        reputacao_pagamento_rapido,
        reputacao_bom_pagador,
        reputacao_liberacao_rapida,
        reputacao_carga_organizada,
        reputacao_boa_comunicacao,
        rastreamento,
        antt,
        observacoes,
        tipo_veiculo,
        peso
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
      )
    `,
    [
      id,
      overrides.nome ?? "Cliente Teste",
      overrides.descricao ?? "Descricao teste",
      overrides.logo_url ?? null,
      overrides.forma_pagamento ?? "Pix",
      overrides.prazo_pagamento ?? "48h",
      overrides.exige_rastreamento ?? false,
      overrides.exige_antt ?? false,
      overrides.exige_seguro ?? false,
      overrides.exige_carga_monitorada ?? false,
      overrides.reputacao_pagamento_rapido ?? false,
      overrides.reputacao_bom_pagador ?? false,
      overrides.reputacao_liberacao_rapida ?? false,
      overrides.reputacao_carga_organizada ?? false,
      overrides.reputacao_boa_comunicacao ?? false,
      overrides.rastreamento ?? null,
      overrides.antt ?? null,
      overrides.observacoes ?? null,
      overrides.tipo_veiculo ?? "CARRETA",
      overrides.peso ?? "28t",
    ],
  );

  return { id };
}

export async function seedCargo(overrides = {}) {
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
        distancia_km,
        duracao_horas,
        perfil,
        valor,
        bonus,
        bonus_exigencias,
        driver_visibility,
        status,
        is_template,
        sheet_lh,
        sheet_data_carregamento,
        sheet_data_descarga,
        created_by,
        created_at,
        is_recurring,
        recurrence_interval_days,
        viagem_id,
        ordem_viagem,
        codigo_viagem
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
      )
    `,
    [
      id,
      overrides.cliente_id ?? null,
      overrides.data ?? "2026-04-08",
      overrides.horario ?? "08:00:00",
      overrides.origem ?? "Salvador / BA",
      overrides.destino ?? "Simoes Filho / BA",
      overrides.distancia_km ?? 1500,
      overrides.duracao_horas ?? 24,
      overrides.perfil ?? "CARRETA",
      overrides.valor ?? 7200,
      overrides.bonus ?? 300,
      overrides.bonus_exigencias ?? null,
      overrides.driver_visibility ?? "PUBLIC",
      overrides.status ?? "OPEN",
      overrides.is_template ?? false,
      overrides.sheet_lh ?? null,
      overrides.sheet_data_carregamento ?? "2026-04-08 08:00",
      overrides.sheet_data_descarga ?? "2026-04-09 12:00",
      overrides.created_by ?? null,
      overrides.created_at ?? new Date().toISOString(),
      overrides.is_recurring ?? false,
      overrides.recurrence_interval_days ?? null,
      overrides.viagem_id ?? null,
      overrides.ordem_viagem ?? null,
      overrides.codigo_viagem ?? null,
    ],
  );

  return { id };
}

export async function seedPacote(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();

  await query(
    `
      INSERT INTO public.cargas_casadas (
        id, status, valor_total, version, published_at, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
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

export async function seedDriverProfile(overrides = {}) {
  const user = await seedUser({
    id: overrides.user_id,
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
      overrides.document_number ?? "12345678901",
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

  return {
    user_id: user.id,
    email: user.email,
  };
}

export async function seedLoadClaim(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();

  await query(
    `
      INSERT INTO public.load_claims (
        id,
        load_id,
        driver_id,
        status,
        queue_position,
        claimed_at,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      id,
      overrides.load_id,
      overrides.driver_id,
      overrides.status ?? "WAITLISTED",
      overrides.queue_position ?? 1,
      overrides.claimed_at ?? new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      overrides.created_at ?? new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    ],
  );

  return { id };
}

export async function seedRoute(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();

  await query(
    `
      INSERT INTO public.route_metrics_cache (
        id,
        origin_key,
        destination_key,
        origem,
        destino,
        distancia_km,
        duracao_horas,
        tempo_estimado_horas,
        perfil_padrao,
        eixos,
        valor_padrao,
        bonus_padrao,
        ativa,
        observacoes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `,
    [
      id,
      overrides.origin_key ?? "salvador",
      overrides.destination_key ?? "simoes filho",
      overrides.origem ?? "Salvador / BA",
      overrides.destino ?? "Simoes Filho / BA",
      overrides.distancia_km ?? 1500,
      overrides.duracao_horas ?? 24,
      overrides.tempo_estimado_horas ?? 24,
      overrides.perfil_padrao ?? "CARRETA",
      overrides.eixos ?? 0,
      overrides.valor_padrao ?? 7200,
      overrides.bonus_padrao ?? 300,
      overrides.ativa ?? true,
      overrides.observacoes ?? null,
    ],
  );

  return { id };
}

export async function seedPublicLead(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();

  await query(
    `
      INSERT INTO public.load_public_leads (
        id,
        load_id,
        cpf,
        phone,
        horse_plate,
        trailer_plate,
        trailer_plate_2,
        vehicle_type,
      status,
      approved_at,
      approved_by,
      pii_redacted_at,
      validation_status,
      validation_checked_at,
      validation_summary_json,
      created_at,
      updated_at
    )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17)
    `,
    [
      id,
      overrides.load_id,
      overrides.cpf ?? "12345678901",
      overrides.phone ?? "71999999999",
      overrides.horse_plate ?? "ABC1D23",
      overrides.trailer_plate ?? "DEF4G56",
      overrides.trailer_plate_2 ?? "",
      overrides.vehicle_type ?? "CARRETA",
      overrides.status ?? "APPROVED",
      overrides.approved_at ?? new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      overrides.approved_by ?? null,
      overrides.pii_redacted_at ?? null,
      overrides.validation_status ?? "PENDING",
      overrides.validation_checked_at ?? null,
      JSON.stringify(overrides.validation_summary_json ?? {}),
      overrides.created_at ?? new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
      overrides.updated_at ?? new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(),
    ],
  );

  return { id };
}

export async function seedVehicle(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();

  await query(
    `
      INSERT INTO public.vehicles (
        id, plate, vehicle_type, plate_role,
        angellira_status, angellira_valid_until, angellira_status_text,
        angellira_display_name, angellira_last_seen_at, angellira_checked_at,
        angellira_details,
        linked_driver_id, linked_driver_cpf, source,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    `,
    [
      id,
      overrides.plate ?? "ABC1D23",
      overrides.vehicle_type ?? "CARRETA",
      overrides.plate_role ?? "HORSE",
      overrides.angellira_status ?? "FOUND",
      overrides.angellira_valid_until ?? "2026-10-12",
      overrides.angellira_status_text ?? "Conforme",
      overrides.angellira_display_name ?? null,
      overrides.angellira_last_seen_at ?? new Date().toISOString(),
      overrides.angellira_checked_at ?? new Date().toISOString(),
      overrides.angellira_details ? JSON.stringify(overrides.angellira_details) : null,
      overrides.linked_driver_id ?? null,
      overrides.linked_driver_cpf ?? null,
      overrides.source ?? "PUBLIC_LEAD",
      overrides.created_at ?? new Date().toISOString(),
      overrides.updated_at ?? new Date().toISOString(),
    ],
  );

  return { id };
}

export async function seedSheetSnapshot(rows = []) {
  await query(
    `INSERT INTO public.sheet_monitor_snapshot (id, rows_json) VALUES (1, $1::jsonb)`,
    [JSON.stringify(rows)],
  );
}

export async function seedPendingRegistration(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();

  await query(
    `
      INSERT INTO public.pending_driver_registrations (id, status, dados, created_at)
      VALUES ($1, $2, $3::jsonb, $4)
    `,
    [
      id,
      overrides.status ?? "draft",
      JSON.stringify(overrides.dados ?? {}),
      overrides.created_at ?? new Date().toISOString(),
    ],
  );

  return { id };
}

export async function seedMotoristaHistorico(overrides = {}) {
  await query(
    `INSERT INTO public.motoristas_historico (cpf, nome, telefone) VALUES ($1, $2, $3)`,
    [overrides.cpf, overrides.nome ?? "Motorista Teste", overrides.telefone ?? null],
  );

  return { cpf: overrides.cpf };
}

export async function seedDriverOutreachOptout(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();

  await query(
    `INSERT INTO public.driver_outreach_optout (id, driver_key, phone, reason) VALUES ($1, $2, $3, $4)`,
    [id, overrides.driver_key, overrides.phone ?? null, overrides.reason ?? null],
  );

  return { id };
}

export async function seedPendingOutreach(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();

  await query(
    `
      INSERT INTO public.pending_driver_outreach
        (id, driver_key, trigger, phone, message, status, retry_count, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      id,
      overrides.driver_key ?? "12345678901",
      overrides.trigger ?? "lost_registration",
      overrides.phone ?? "5571988887777",
      overrides.message ?? "Olá! Mensagem de teste.",
      overrides.status ?? "pending",
      overrides.retry_count ?? 0,
      overrides.created_at ?? new Date().toISOString(),
    ],
  );

  return { id };
}

export async function seedOutreachLog(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();

  await query(
    `
      INSERT INTO public.driver_outreach_log (id, driver_key, trigger, channel, status, phone, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      id,
      overrides.driver_key ?? "00000000000",
      overrides.trigger ?? "churn",
      overrides.channel ?? "evolution",
      overrides.status ?? "sent",
      overrides.phone ?? "5571900000000",
      overrides.created_at ?? new Date().toISOString(),
    ],
  );

  return { id };
}
