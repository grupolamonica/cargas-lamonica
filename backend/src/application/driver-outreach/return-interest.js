/**
 * driver-outreach — fila de INTERESSE do motorista.
 *
 * Motorista responde interessado a um envio, mas naquele momento não há carga
 * OPEN casando. Em vez de esquecer, gravamos o interesse aqui. Quando uma nova
 * carga OPEN chegar no sistema, o job `matchAndNotifyReturnInterest` roda:
 *   1) busca interesses ativos casando com a rota (origem/destino);
 *   2) marca `matched_at`/`matched_load_id`;
 *   3) enfileira um envio automático em `pending_driver_outreach` avisando o
 *      motorista da nova carga.
 *
 * TTL padrão: 7 dias.
 */

import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { getOutreachConfig, computeDripGapMs } from "./config.js";
import { BONUS_DISCLAIMER } from "../../domain/driver-outreach/cargo-format.js";

const onlyDigits = (v) => String(v || "").replace(/\D/g, "");

function firstName(nome) {
  const f = String(nome || "").trim().split(/\s+/)[0] || "";
  return f ? f.charAt(0).toUpperCase() + f.slice(1).toLowerCase() : "amigo";
}
function fmtBRL(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function fmtDateBR(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/**
 * Registra o interesse do motorista numa rota (origem/destino).
 * Idempotente: não duplica interesse ativo da mesma dupla driver_key+rota.
 */
export async function registerReturnInterest({
  driverKey,
  phone,
  nome,
  origem,
  destino,
  source,
} = {}) {
  const dk = String(driverKey || "").trim();
  const p = onlyDigits(phone);
  if (!dk || !p) return { skipped: "no_identifier" };
  const rota = origem && destino ? `${origem} → ${destino}` : null;

  return withPgClient(async (client) => {
    // Se já existe interesse ativo (não matched, não expirado) para esse
    // motorista+rota, apenas renova expires_at.
    try {
      const { rows: existing } = await client.query(
        `SELECT id FROM public.driver_return_interests
          WHERE driver_key = $1
            AND coalesce(origem,'') = coalesce($2::text,'')
            AND coalesce(destino,'') = coalesce($3::text,'')
            AND matched_at IS NULL
            AND expires_at > now()
          LIMIT 1`,
        [dk, origem || null, destino || null],
      );
      if (existing[0]) {
        await client.query(
          `UPDATE public.driver_return_interests
              SET expires_at = now() + interval '7 days',
                  phone = $2, nome = $3
            WHERE id = $1`,
          [existing[0].id, p, nome || null],
        );
        return { id: existing[0].id, renewed: true };
      }
      const { rows } = await client.query(
        `INSERT INTO public.driver_return_interests
           (driver_key, phone, nome, origem, destino, rota, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [dk, p, nome || null, origem || null, destino || null, rota, source || "manual"],
      );
      return { id: rows[0]?.id, created: true };
    } catch (err) {
      if (err?.code === "42P01") return { skipped: "no_table" };
      throw err;
    }
  });
}

/**
 * Dado uma nova carga OPEN, busca interesses casando com a rota, marca como
 * matched e enfileira envios automáticos em pending_driver_outreach.
 * Idempotente: só olha interesses com matched_at IS NULL.
 */
export async function matchAndNotifyReturnInterest({ loadId } = {}) {
  if (!loadId) return { matched: 0 };
  return withPgClient(async (client) => {
    // Carrega a carga.
    const { rows: cargoRows } = await client.query(
      `SELECT id, origem, destino, data, horario, valor, bonus, perfil
         FROM public.cargas
        WHERE id = $1 AND status = 'OPEN'`,
      [loadId],
    );
    const cargo = cargoRows[0];
    if (!cargo) return { matched: 0, reason: "load_not_open" };

    // Busca interesses ativos casando com origem+destino.
    let interests;
    try {
      const { rows } = await client.query(
        `SELECT id, driver_key, phone, nome
           FROM public.driver_return_interests
          WHERE origem = $1 AND destino = $2
            AND matched_at IS NULL
            AND expires_at > now()`,
        [cargo.origem, cargo.destino],
      );
      interests = rows;
    } catch (err) {
      if (err?.code === "42P01") return { matched: 0, reason: "no_table" };
      throw err;
    }
    if (!interests.length) return { matched: 0 };

    // Drip: escalona os avisos atrás de qualquer backlog pendente, com jitter.
    const cfg = await getOutreachConfig(client);
    const { rows: maxRows } = await client
      .query(
        `SELECT GREATEST(now(), COALESCE(max(next_attempt_at), now())) AS base
           FROM public.pending_driver_outreach WHERE status = 'pending'`,
      )
      .catch(() => ({ rows: [{ base: new Date() }] }));
    let cursorMs = new Date(maxRows[0]?.base || Date.now()).getTime();

    const rotaLabel = `${cargo.origem} → ${cargo.destino}`;
    const dataFrag = cargo.data
      ? ` · ${fmtDateBR(
          cargo.data instanceof Date ? cargo.data.toISOString().slice(0, 10) : String(cargo.data).slice(0, 10),
        )}${cargo.horario ? " às " + String(cargo.horario).slice(0, 5) : ""}`
      : "";
    const valorFrag = cargo.valor
      ? ` — ${fmtBRL(cargo.valor)}${cargo.bonus ? ` (+ ${fmtBRL(cargo.bonus)} bônus)` : ""}`
      : "";

    let matched = 0;
    for (const inter of interests) {
      const text =
        `Oi, ${firstName(inter.nome)}! 🚚 Lembra da rota que você queria?\n` +
        `Apareceu essa aqui: ${rotaLabel}${dataFrag}${valorFrag}.\n` +
        (cargo.bonus ? `${BONUS_DISCLAIMER}\n` : "") +
        `Bora? Responde *SIM* aqui.`;
      const trigger = `return-match:${loadId}`.slice(0, 64);
      const metadata = {
        source: "return_interest_match",
        interest_id: inter.id,
        loadId,
        rota: rotaLabel,
        origem: cargo.origem,
        destino: cargo.destino,
      };
      cursorMs += computeDripGapMs(cfg);
      const nextAttemptAt = new Date(cursorMs).toISOString();
      const ins = await client
        .query(
          `INSERT INTO public.pending_driver_outreach
             (driver_key, trigger, phone, message, correlation_id, metadata, next_attempt_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
           ON CONFLICT (driver_key, trigger) DO NOTHING
           RETURNING id`,
          [inter.driver_key, trigger, inter.phone, text, `return-match-${loadId}`, JSON.stringify(metadata), nextAttemptAt],
        )
        .catch(() => ({ rows: [] }));

      await client.query(
        `UPDATE public.driver_return_interests
            SET matched_at = now(), matched_load_id = $2
          WHERE id = $1`,
        [inter.id, loadId],
      );
      if (ins.rows[0]) matched += 1;
    }

    if (matched > 0) {
      await client
        .query(
          `INSERT INTO public.operator_notifications (kind, title, body, metadata)
           VALUES ('return_interest_match', $1, $2, $3::jsonb)`,
          [
            `${matched} motorista(s) avisado(s) sobre nova carga`,
            `${rotaLabel}${dataFrag}`,
            JSON.stringify({ loadId, matched, rota: rotaLabel }),
          ],
        )
        .catch(() => {});
    }
    return { matched, load: cargo };
  });
}

/**
 * Job periódico: varre TODAS as cargas OPEN recentes e roda o match.
 * Idempotente porque `matchAndNotifyReturnInterest` marca `matched_at`, e o
 * trigger `return-match:<loadId>` é único por (driver_key, trigger).
 */
export async function runReturnInterestSweep({ limit = 100 } = {}) {
  return withPgClient(async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM public.cargas
        WHERE status = 'OPEN' AND updated_at > now() - interval '48 hours'
        ORDER BY updated_at DESC
        LIMIT $1`,
      [Math.max(1, Math.min(500, Number(limit) || 100))],
    );
    let total = 0;
    for (const r of rows) {
      const res = await matchAndNotifyReturnInterest({ loadId: r.id });
      total += res.matched || 0;
    }
    return { total, cargosChecked: rows.length };
  });
}
