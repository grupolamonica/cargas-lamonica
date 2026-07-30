/**
 * Mantém `cargas.status` (o gate de candidatura pública do motorista) em sincronia
 * com a alocação EFETIVA do Monitor — `COALESCE(alloc_motorista, sheet_motorista)`.
 *
 * PROBLEMA que resolve: alocar um motorista pela tela de Monitor grava só as
 * colunas `alloc_*` e NUNCA mexia em `cargas.status`. A carga continuava
 * `status='OPEN'`, então seguia candidatável por outros motoristas — candidatura
 * direta (public-leads), página do portal aberta em cache e o matcher de outreach
 * checam apenas `status='OPEN'`, não a presença de motorista. Resultado: carga já
 * com dono continuava "em aberto" pra fila. Este helper fecha a carga ao alocar e
 * reabre ao limpar, deixando o gate de candidatura sempre coerente com a decisão
 * do operador no Monitor.
 *
 * Regras (idempotentes; só transiciona OPEN <-> RESERVED — nunca toca
 * BOOKED/EXPIRED/CANCELLED/DRAFT/COMPLETED/FAILED):
 *   - motorista efetivo PRESENTE + status='OPEN'                 -> 'RESERVED' (fecha)
 *   - motorista efetivo AUSENTE  + status='RESERVED' de Monitor  -> 'OPEN'     (reabre)
 *
 * "RESERVED de Monitor" = `reserved_public_lead_id` E `reserved_claim_id` E
 * `reserved_driver_id` TODOS nulos. Reservas de lead público (approve/direct),
 * de claim do motorista (load-claims/service.js) e de pacote (cargas-casadas)
 * SEMPRE preenchem um desses marcadores, então este helper NUNCA reabre uma
 * reserva "real" — só a reserva sintética que ele próprio criou ao fechar via
 * Monitor. Assim o ciclo de reserva pública (confirmação/expiração 2h) continua
 * intacto (aquele fluxo casa por `load_public_leads.status='APPROVED'`, que a
 * reserva de Monitor não possui).
 *
 * Compatibilidade com o sync da planilha: o sync preserva `RESERVED` (só avança
 * OPEN->BOOKED / OPEN->EXPIRED), então uma carga fechada aqui não é revertida
 * pela próxima sincronização.
 *
 * DEVE rodar DENTRO da mesma transação do write de `alloc_*` (recebe o `client`).
 *
 * @param {import("pg").PoolClient} client  cliente já dentro de uma transação
 * @param {string} cargoId  id da carga (UUID; determinístico p/ linhas da planilha)
 * @returns {Promise<"RESERVED"|"OPEN"|null>}  novo status se mudou, senão null
 */
export async function reconcileMonitorLoadStatus(client, cargoId) {
  if (!cargoId) return null;

  const { rows } = await client.query(
    `SELECT status,
            reserved_public_lead_id,
            reserved_claim_id,
            reserved_driver_id,
            COALESCE(alloc_motorista, sheet_motorista, '') AS eff_motorista
       FROM public.cargas
      WHERE id = $1
      FOR UPDATE`,
    [cargoId],
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  const hasDriver = String(row.eff_motorista ?? "").trim() !== "";
  const isMonitorReservation =
    row.reserved_public_lead_id == null &&
    row.reserved_claim_id == null &&
    row.reserved_driver_id == null;

  // Fecha: OPEN + motorista -> RESERVED (reserva sintética do operador, sem
  // lead/claim). WHERE re-afirma status='OPEN' p/ ser idempotente sob corrida.
  if (hasDriver && row.status === "OPEN") {
    await client.query(
      `UPDATE public.cargas
          SET status = 'RESERVED',
              reserved_at = now(),
              reserved_until = null,
              reserved_driver_id = null,
              reserved_claim_id = null,
              reserved_public_lead_id = null,
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND status = 'OPEN'`,
      [cargoId],
    );
    return "RESERVED";
  }

  // Reabre: RESERVED de Monitor (sem marcadores de reserva real) + sem motorista
  // -> OPEN. Nunca reabre reserva de lead/claim/pacote (têm marcador preenchido).
  if (!hasDriver && row.status === "RESERVED" && isMonitorReservation) {
    await client.query(
      `UPDATE public.cargas
          SET status = 'OPEN',
              reserved_at = null,
              reserved_until = null,
              version = version + 1,
              updated_at = now()
        WHERE id = $1
          AND status = 'RESERVED'
          AND reserved_public_lead_id IS NULL
          AND reserved_claim_id IS NULL
          AND reserved_driver_id IS NULL`,
      [cargoId],
    );
    return "OPEN";
  }

  return null;
}
