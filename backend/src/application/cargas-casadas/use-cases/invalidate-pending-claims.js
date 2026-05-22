/**
 * invalidate-pending-claims — Helper transacional para D-06 (version bump).
 *
 * Quando um pacote em status 'publicado' sofre mutacao (add/remove/reorder carga
 * ou update valor_total), as candidaturas pendentes ficam invalidas porque o
 * "produto" mudou. Esta funcao:
 *   1. Localiza as cargas vinculadas ao pacote (FOR UPDATE).
 *   2. Marca claims ativos (WON_RESERVATION, WAITLISTED, PROMOTED) como REJECTED.
 *   3. Audita cada rejeicao em load_claim_events.
 *   4. Libera reservas em cargas (status -> OPEN, reserved_* = NULL, version+1).
 *   5. Reseta reserved_* no pacote e (se reservado) volta para 'publicado'.
 *
 * IMPORTANTE: aceita um `client` em transacao em curso — caller controla COMMIT.
 *
 * Diferenca para `rejectActiveClaimsForPacote` (em _shared.js):
 *  - Este e usado em D-06 (version bump em mutacao). Reson 'PACOTE_VERSION_BUMPED'.
 *  - O outro e usado em D-05 (cancel cascade). Reson 'PACOTE_CANCELLED'.
 *  - Este libera reservas e devolve pacote para 'publicado'. O outro nao —
 *    pacote vai para 'cancelado' (status terminal).
 */

export async function invalidatePendingClaimsForPacote(client, pacoteId, reason = "PACOTE_VERSION_BUMPED") {
  // 1. Lock todas as cargas do pacote (ordem importa: pacote ja deve estar locked pelo caller).
  const { rows: cargas } = await client.query(
    `SELECT id, status, reserved_claim_id, reserved_driver_id
       FROM public.cargas
      WHERE viagem_id = $1
      ORDER BY ordem_viagem ASC NULLS LAST, id ASC
      FOR UPDATE`,
    [pacoteId],
  );

  if (cargas.length === 0) {
    return { invalidatedClaimIds: [], freedCargaIds: [] };
  }
  const cargaIds = cargas.map((c) => c.id);

  // 2. Reject active claims (WON_RESERVATION/WAITLISTED/PROMOTED).
  //    CONFIRMED nao e tocado (motorista ja confirmou; cancel exige outro fluxo D-05).
  const { rows: rejectedClaims } = await client.query(
    `UPDATE public.load_claims
        SET status = 'REJECTED',
            rejected_reason = $1,
            queue_position = NULL,
            updated_at = now()
      WHERE load_id = ANY($2::uuid[])
        AND status IN ('WON_RESERVATION', 'WAITLISTED', 'PROMOTED')
      RETURNING id, load_id, driver_id`,
    [reason, cargaIds],
  );

  // 3. Audit cada rejection.
  for (const claim of rejectedClaims) {
    await client.query(
      `INSERT INTO public.load_claim_events (
         load_id, claim_id, driver_id, event_type, event_payload_json,
         actor_type, actor_id
       )
       VALUES ($1, $2, $3, 'CLAIM_REJECTED', $4::jsonb, 'system', 'pacote-version-bump')`,
      [claim.load_id, claim.id, claim.driver_id, JSON.stringify({ reason, pacoteId })],
    );
  }

  // 4. Libera reservas em cargas (sai de RESERVED -> OPEN, reseta reserved_*).
  //    Tambem aplica em cargas que ja estavam OPEN com reserved_driver_id (estado transitorio).
  await client.query(
    `UPDATE public.cargas
        SET status = CASE WHEN status = 'RESERVED' THEN 'OPEN' ELSE status END,
            reserved_driver_id = NULL,
            reserved_claim_id = NULL,
            reserved_at = NULL,
            reserved_until = NULL,
            version = version + 1,
            updated_at = now()
      WHERE id = ANY($1::uuid[])
        AND (status = 'RESERVED' OR reserved_driver_id IS NOT NULL)`,
    [cargaIds],
  );

  // 5. Reset pacote — se estava 'reservado' por causa de um claim que foi invalidado,
  //    volta para 'publicado' (motoristas podem candidatar de novo apos ver a nova versao).
  await client.query(
    `UPDATE public.cargas_casadas
        SET reserved_driver_id = NULL,
            reserved_claim_id = NULL,
            status = CASE WHEN status = 'reservado' THEN 'publicado' ELSE status END,
            updated_at = now()
      WHERE id = $1`,
    [pacoteId],
  );

  return {
    invalidatedClaimIds: rejectedClaims.map((c) => c.id),
    freedCargaIds: cargaIds,
  };
}
