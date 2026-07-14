// backend/src/application/operator-admin/use-cases/rastreador-credentials.js
//
// Cofre de credenciais do rastreador (DC-236). Por CAVALO (placa = PK). A senha
// fica CIFRADA em repouso via pgcrypto (pgp_sym_encrypt); a chave vem do env
// RASTREADOR_VAULT_KEY (só no backend) e é passada como PARÂMETRO ($n) — nunca
// concatenada no SQL (senão vaza em pg_stat_statements/logs).
//
// Usa o pool `pg` (withPgClient/withPgTransaction) e NÃO o client JS do Supabase:
// só o SQL parametrizado invoca pgp_sym_encrypt/decrypt. Retorno {statusCode,payload}.

import { withPgClient, withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";

/** A chave SÓ existe no backend. Throw alto no ponto de cifra/decifra se faltar. */
function getVaultKey() {
  const key = process.env.RASTREADOR_VAULT_KEY?.trim();
  if (!key) {
    throw new Error("Missing required environment variable: RASTREADOR_VAULT_KEY");
  }
  return key;
}

/** Senha vazia/omitida -> null (no upsert, null preserva a cifra atual via COALESCE). Puro/testável. */
export function normalizeSenhaParam(senha) {
  return senha != null && String(senha) !== "" ? String(senha) : null;
}

/** Linha do banco -> item mascarado (NUNCA expõe a senha/cifra). Puro/testável. */
export function maskCredentialRow(row) {
  const hasPassword = row.has_password === true;
  return {
    horsePlate: row.horse_plate,
    provider: row.provider ?? "",
    username: row.username ?? "",
    hasPassword,
    passwordMask: hasPassword ? "••••••••" : null,
    notes: row.notes ?? null,
    updatedAt: row.updated_at ?? null,
    updatedBy: row.updated_by ?? null,
  };
}

/** GET — lista MASCARADA. Nunca seleciona password_cipher (só o boolean has_password). */
export async function listRastreadorCredentials({ correlationId } = {}) {
  const rows = await withPgClient((client) =>
    client
      .query(
        `SELECT horse_plate, provider, username,
                (password_cipher IS NOT NULL) AS has_password,
                notes, updated_at, updated_by
           FROM public.rastreador_credentials
          ORDER BY horse_plate ASC`,
      )
      .then((r) => r.rows),
  );
  return {
    statusCode: 200,
    payload: { ok: true, items: rows.map(maskCredentialRow), meta: { count: rows.length, correlationId: correlationId ?? null } },
  };
}

/**
 * PUT — upsert por placa. Cifra a senha com pgp_sym_encrypt($senha,$key). Se a senha
 * vier vazia/omitida num cavalo já existente, PRESERVA a cifra atual (COALESCE).
 * Auditoria da escrita dentro da transação (metadata sem a senha).
 */
export async function upsertRastreadorCredential({
  horsePlate,
  provider = "",
  username = "",
  senha,
  notes = null,
  operatorId = null,
  requestIp = null,
  correlationId = null,
} = {}) {
  const key = getVaultKey();
  const senhaParam = normalizeSenhaParam(senha);

  return withPgTransaction(async (client) => {
    await client.query(
      `
        INSERT INTO public.rastreador_credentials
          (horse_plate, provider, username, password_cipher, notes, updated_by, updated_at)
        VALUES
          ($1, $2, $3,
           CASE WHEN $4::text IS NULL THEN NULL ELSE pgp_sym_encrypt($4::text, $5::text) END,
           $6, $7, now())
        ON CONFLICT (horse_plate) DO UPDATE SET
          provider        = EXCLUDED.provider,
          username        = EXCLUDED.username,
          notes           = EXCLUDED.notes,
          updated_by      = EXCLUDED.updated_by,
          updated_at      = now(),
          -- só troca a senha quando veio uma nova; senão mantém a cifra existente
          password_cipher = COALESCE(EXCLUDED.password_cipher, public.rastreador_credentials.password_cipher)
      `,
      [horsePlate, provider, username, senhaParam, key, notes, operatorId],
    );

    await insertSecurityAuditEvent(client, {
      eventType: "operator.rastreador.credencial_upserted",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "rastreador_credential",
      resourceId: horsePlate,
      action: "upsert",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { provider, valorAlterado: senhaParam !== null },
    });

    return { statusCode: 200, payload: { ok: true, horsePlate, meta: { correlationId } } };
  });
}

/**
 * POST /revelar — decifra a senha de UMA placa com pgp_sym_decrypt(cipher,$key) e
 * registra no audit log (autônomo, severity 'warn'). NUNCA loga a senha.
 */
export async function revealRastreadorCredential({
  horsePlate,
  operatorId = null,
  requestIp = null,
  correlationId = null,
} = {}) {
  const key = getVaultKey();

  // FAIL-CLOSED: decifrar e auditar na MESMA transação. Se a gravação da auditoria
  // falhar, a transação inteira aborta e a senha NÃO é devolvida — não há revelação
  // sem trilha. Por isso insertSecurityAuditEvent (in-transaction), e não
  // recordSecurityAuditEvent (autônomo, que engole erros).
  return withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT horse_plate, provider, username,
              CASE WHEN password_cipher IS NULL THEN NULL
                   ELSE pgp_sym_decrypt(password_cipher, $2::text) END AS senha
         FROM public.rastreador_credentials
        WHERE horse_plate = $1`,
      [horsePlate, key],
    );

    const row = rows[0];
    if (!row) {
      throw new NotFoundError("Credencial de rastreador não encontrada para esse cavalo.");
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.rastreador.credencial_revelada",
      severity: "warn",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "rastreador_credential",
      resourceId: horsePlate,
      action: "reveal",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { provider: row.provider, field: "rastreador.senha" },
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        credential: {
          horsePlate: row.horse_plate,
          provider: row.provider ?? "",
          username: row.username ?? "",
          senha: row.senha ?? null,
        },
        meta: { correlationId },
      },
    };
  });
}
