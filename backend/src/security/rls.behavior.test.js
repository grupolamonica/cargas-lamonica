import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import "../infrastructure/config/load-env.js";
import { buildPostgresSslConfig } from "../infrastructure/pg/postgres-ssl.js";

const shouldRun =
  process.env.RUN_SUPABASE_RLS_TESTS === "true" &&
  Boolean(process.env.SUPABASE_DB_URL?.trim());

const describeIf = shouldRun ? describe : describe.skip;

function buildClaims(payload = {}) {
  return {
    aud: "authenticated",
    role: "authenticated",
    sub: payload.sub || crypto.randomUUID(),
    email: payload.email || `rls-${crypto.randomUUID()}@test.local`,
    app_metadata: payload.app_metadata || {},
    user_metadata: payload.user_metadata || {},
  };
}

async function applyRoleContext(client, role, claims) {
  await client.query(`SET LOCAL ROLE ${role}`);
  await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [claims.sub || ""]);
}

describeIf("Supabase RLS behavior", () => {
  let pool;

  beforeAll(() => {
    pool = new Pool({
      connectionString: process.env.SUPABASE_DB_URL?.trim(),
      max: 1,
      ssl: buildPostgresSslConfig(),
    });
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  }, 30_000);

  it("nega leitura administrativa para autenticado sem role", async () => {
    const client = await pool.connect();
    const clientId = crypto.randomUUID();
    const loadId = crypto.randomUUID();
    const routeId = crypto.randomUUID();
    const leadId = crypto.randomUUID();
    const auditId = crypto.randomUUID();

    try {
      await client.query("BEGIN");

      await client.query(
        `
          INSERT INTO public.clientes (id, nome)
          VALUES ($1, $2)
        `,
        [clientId, `RLS Cliente ${clientId}`],
      );

      await client.query(
        `
          INSERT INTO public.cargas (
            id,
            cliente_id,
            data,
            horario,
            origem,
            destino,
            perfil,
            status,
            is_template
          )
          VALUES ($1, $2, '2026-04-08', '08:00:00', 'Salvador / BA', 'Campinas / SP', 'CARRETA', 'DRAFT', false)
        `,
        [loadId, clientId],
      );

      await client.query(
        `
          INSERT INTO public.route_metrics_cache (
            id,
            origin_key,
            destination_key,
            origem,
            destino,
            distancia_km,
            duracao_horas
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [routeId, "salvador / ba", "campinas / sp", "Salvador / BA", "Campinas / SP", 1500, 24],
      );

      await client.query(
        `
          INSERT INTO public.load_public_leads (
            id,
            load_id,
            cpf,
            phone,
            horse_plate,
            trailer_plate,
            vehicle_type,
            status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'QUEUED')
        `,
        [leadId, loadId, "12345678901", "71999999999", "ABC1D23", "DEF4G56", "CARRETA"],
      );

      await client.query(
        `
          INSERT INTO public.security_audit_logs (
            id,
            event_type,
            severity,
            actor_role,
            resource_type,
            resource_id,
            action,
            outcome,
            correlation_id,
            metadata
          )
          VALUES ($1, 'operator.request.denied', 'warn', 'unknown', 'operator-api', $2, 'read', 'denied', 'corr-rls-read', '{}'::jsonb)
        `,
        [auditId, loadId],
      );

      await applyRoleContext(client, "authenticated", buildClaims());

      const cargasResult = await client.query(`SELECT id FROM public.cargas WHERE id = $1`, [loadId]);
      const clientesResult = await client.query(`SELECT id FROM public.clientes WHERE id = $1`, [clientId]);
      const routesResult = await client.query(`SELECT id FROM public.route_metrics_cache WHERE id = $1`, [routeId]);
      const publicLeadsResult = await client.query(`SELECT id FROM public.load_public_leads WHERE id = $1`, [leadId]);
      const securityAuditResult = await client.query(`SELECT id FROM public.security_audit_logs WHERE id = $1`, [auditId]);

      expect(cargasResult.rows).toHaveLength(0);
      expect(clientesResult.rows).toHaveLength(0);
      expect(routesResult.rows).toHaveLength(0);
      expect(publicLeadsResult.rows).toHaveLength(0);
      expect(securityAuditResult.rows).toHaveLength(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }, 30_000);

  it("permite leitura administrativa para operador valido", async () => {
    const client = await pool.connect();
    const clientId = crypto.randomUUID();
    const loadId = crypto.randomUUID();
    const leadId = crypto.randomUUID();
    const auditId = crypto.randomUUID();

    try {
      await client.query("BEGIN");

      await client.query(
        `
          INSERT INTO public.clientes (id, nome)
          VALUES ($1, $2)
        `,
        [clientId, `Operador Cliente ${clientId}`],
      );

      await client.query(
        `
          INSERT INTO public.cargas (
            id,
            cliente_id,
            data,
            horario,
            origem,
            destino,
            perfil,
            status,
            is_template
          )
          VALUES ($1, $2, '2026-04-08', '08:00:00', 'Salvador / BA', 'Campinas / SP', 'CARRETA', 'OPEN', false)
        `,
        [loadId, clientId],
      );

      await client.query(
        `
          INSERT INTO public.load_public_leads (
            id,
            load_id,
            cpf,
            phone,
            horse_plate,
            trailer_plate,
            vehicle_type,
            status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'QUEUED')
        `,
        [leadId, loadId, "12345678901", "71999999999", "ABC1D23", "DEF4G56", "CARRETA"],
      );

      await client.query(
        `
          INSERT INTO public.security_audit_logs (
            id,
            event_type,
            severity,
            actor_role,
            resource_type,
            resource_id,
            action,
            outcome,
            correlation_id,
            metadata
          )
          VALUES ($1, 'operator.request.denied', 'warn', 'unknown', 'operator-api', $2, 'read', 'denied', 'corr-rls-operator', '{}'::jsonb)
        `,
        [auditId, loadId],
      );

      await applyRoleContext(
        client,
        "authenticated",
        buildClaims({
          app_metadata: {
            role: "operator",
          },
        }),
      );

      const cargasResult = await client.query(`SELECT id FROM public.cargas WHERE id = $1`, [loadId]);
      const clientesResult = await client.query(`SELECT id FROM public.clientes WHERE id = $1`, [clientId]);
      const publicLeadsResult = await client.query(`SELECT id FROM public.load_public_leads WHERE id = $1`, [leadId]);
      const securityAuditResult = await client.query(`SELECT id FROM public.security_audit_logs WHERE id = $1`, [auditId]);

      expect(cargasResult.rows).toHaveLength(1);
      expect(clientesResult.rows).toHaveLength(1);
      expect(publicLeadsResult.rows).toHaveLength(1);
      expect(securityAuditResult.rows).toHaveLength(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }, 30_000);

  it("mantem visibilidade publica apenas para carga aberta no portal", async () => {
    const client = await pool.connect();
    const openLoadId = crypto.randomUUID();
    const draftLoadId = crypto.randomUUID();

    try {
      await client.query("BEGIN");

      await client.query(
        `
          INSERT INTO public.cargas (
            id,
            data,
            horario,
            origem,
            destino,
            perfil,
            status,
            is_template
          )
          VALUES
            ($1, '2026-04-08', '08:00:00', 'Salvador / BA', 'Campinas / SP', 'CARRETA', 'OPEN', false),
            ($2, '2026-04-08', '09:00:00', 'Recife / PE', 'Curitiba / PR', 'CARRETA', 'DRAFT', false)
        `,
        [openLoadId, draftLoadId],
      );

      await applyRoleContext(
        client,
        "anon",
        {
          role: "anon",
          aud: "anon",
          sub: crypto.randomUUID(),
          app_metadata: {},
          user_metadata: {},
        },
      );

      const visibleLoads = await client.query(
        `SELECT id FROM public.cargas WHERE id = ANY($1::uuid[]) ORDER BY id ASC`,
        [[openLoadId, draftLoadId]],
      );

      expect(visibleLoads.rows.map((row) => row.id)).toEqual([openLoadId]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }, 30_000);

  it("mantem anon sem acesso a leads publicos e logs de auditoria", async () => {
    const client = await pool.connect();
    const loadId = crypto.randomUUID();
    const leadId = crypto.randomUUID();
    const auditId = crypto.randomUUID();

    try {
      await client.query("BEGIN");

      await client.query(
        `
          INSERT INTO public.cargas (
            id,
            data,
            horario,
            origem,
            destino,
            perfil,
            status,
            is_template
          )
          VALUES ($1, '2026-04-08', '08:00:00', 'Salvador / BA', 'Campinas / SP', 'CARRETA', 'OPEN', false)
        `,
        [loadId],
      );

      await client.query(
        `
          INSERT INTO public.load_public_leads (
            id,
            load_id,
            cpf,
            phone,
            horse_plate,
            trailer_plate,
            vehicle_type,
            status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'QUEUED')
        `,
        [leadId, loadId, "12345678901", "71999999999", "ABC1D23", "DEF4G56", "CARRETA"],
      );

      await client.query(
        `
          INSERT INTO public.security_audit_logs (
            id,
            event_type,
            severity,
            actor_role,
            resource_type,
            resource_id,
            action,
            outcome,
            correlation_id,
            metadata
          )
          VALUES ($1, 'public-leads.request.rate_limited', 'warn', 'anon', 'load', $2, 'pre-registration', 'denied', 'corr-rls-anon', '{}'::jsonb)
        `,
        [auditId, loadId],
      );

      await applyRoleContext(client, "anon", {
        role: "anon",
        aud: "anon",
        sub: crypto.randomUUID(),
        app_metadata: {},
        user_metadata: {},
      });

      const leadsResult = await client.query(`SELECT id FROM public.load_public_leads WHERE id = $1`, [leadId]);
      const auditResult = await client.query(`SELECT id FROM public.security_audit_logs WHERE id = $1`, [auditId]);

      expect(leadsResult.rows).toHaveLength(0);
      expect(auditResult.rows).toHaveLength(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }, 30_000);

  it("nega mutacao administrativa para autenticado sem role", async () => {
    const client = await pool.connect();
    const clientId = crypto.randomUUID();
    const loadId = crypto.randomUUID();

    try {
      await client.query("BEGIN");
      await applyRoleContext(client, "authenticated", buildClaims());

      await expect(
        client.query(
          `
            INSERT INTO public.clientes (id, nome)
            VALUES ($1, $2)
          `,
          [clientId, `Cliente Bloqueado ${clientId}`],
        ),
      ).rejects.toMatchObject({
        code: "42501",
      });

      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await applyRoleContext(client, "authenticated", buildClaims());

      await expect(
        client.query(
          `
            INSERT INTO public.cargas (
              id,
              data,
              horario,
              origem,
              destino,
              perfil,
              status,
              is_template
            )
            VALUES ($1, '2026-04-08', '08:00:00', 'Salvador / BA', 'Campinas / SP', 'CARRETA', 'OPEN', false)
          `,
          [loadId],
        ),
      ).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }, 30_000);
});
