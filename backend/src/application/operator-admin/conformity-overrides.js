import { logStructuredEvent } from "../../infrastructure/security-log.js";

// Verdito manual de conformidade Angellira (Aprovado/Não aprovado) por ENTIDADE:
// motorista pelo CPF (só dígitos) e veículo pela placa normalizada. O overlay é
// aplicado em READ-TIME sobre os mapas de enriquecimento do Monitor (não persiste
// em sheet_monitor_enriched) — sempre fresco, sem mexer no cache/merge do enrich.

/** CPF só-dígitos (motoristas_historico guarda cru, driver_profiles com pontuação). */
export function normalizeCpfKey(v) {
  return (v || "").toString().replace(/\D/g, "");
}

/** Placa normalizada: sem separadores, maiúscula (igual ao sheet-monitor-enrichment). */
export function normalizePlateKey(v) {
  return (v || "").toString().replace(/[\s\-.]/g, "").toUpperCase();
}

/** Chave de assunto normalizada por tipo (DRIVER=CPF, VEHICLE=placa). */
export function normalizeSubjectKey(subjectType, key) {
  return subjectType === "DRIVER" ? normalizeCpfKey(key) : normalizePlateKey(key);
}

/**
 * Carrega todos os overrides de conformidade e indexa por CPF (motorista) e por
 * placa (veículo). Tabela pequena. Best-effort: se a tabela ainda não existe
 * (migração pendente) ou a leitura falha, devolve mapas vazios — o Monitor segue
 * mostrando o selo derivado, sem quebrar.
 *
 * @returns {Promise<{ driver: Map<string,object>, vehicle: Map<string,object> }>}
 */
export async function loadConformityOverrides(supabaseClient, correlationId) {
  const driver = new Map();
  const vehicle = new Map();
  try {
    const { data, error } = await supabaseClient
      .from("angellira_conformity_overrides")
      .select("subject_type, subject_key, decision, observacao, set_by_name, set_at, updated_at");
    if (error) {
      logStructuredEvent("warn", "conformity-overrides.read-failed", {
        correlationId,
        code: error.code,
        message: error.message,
      });
      return { driver, vehicle };
    }
    for (const r of data || []) {
      const key = normalizeSubjectKey(r.subject_type, r.subject_key);
      if (!key) continue;
      const verdict = {
        decision: r.decision,
        observacao: r.observacao ?? "",
        setBy: r.set_by_name ?? null,
        setAt: r.updated_at ?? r.set_at ?? null,
      };
      if (r.subject_type === "DRIVER") driver.set(key, verdict);
      else if (r.subject_type === "VEHICLE") vehicle.set(key, verdict);
    }
  } catch (err) {
    logStructuredEvent("warn", "conformity-overrides.read-error", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return { driver, vehicle };
}

/** CPF do motorista de uma linha enriquecida (ASPX ou detalhes Angellira). */
function driverCpfOf(row) {
  const details = row?.angellira_driver_details;
  const detailsCpf = details && typeof details === "object" ? details.cpf : null;
  return normalizeCpfKey(row?.aspx_cpf || detailsCpf || "");
}

/**
 * Anexa o verdito manual (quando existir) a UMA linha enriquecida, por CPF do
 * motorista e placa de cavalo/carreta. Não muta a linha original (o mapa vem do
 * cache) — devolve a MESMA referência quando não há override, ou um CLONE quando há.
 */
export function applyOverrideToEnrichedRow(row, overrides) {
  if (!row) return row;
  const driverV = overrides.driver.get(driverCpfOf(row)) || null;
  const cavaloV = overrides.vehicle.get(normalizePlateKey(row.cavalo_plate)) || null;
  const carretaV = overrides.vehicle.get(normalizePlateKey(row.carreta_plate)) || null;
  if (!driverV && !cavaloV && !carretaV) return row;
  return {
    ...row,
    angellira_driver_manual: driverV,
    cavalo_angellira_manual: cavaloV,
    carreta_angellira_manual: carretaV,
  };
}

/**
 * Aplica o overlay a AMBOS os mapas (por lh e por cargo_id), devolvendo novos mapas
 * (linhas clonadas só quando há override). Puro/testável.
 */
export function applyConformityOverridesToEnriched(maps, overrides) {
  const overlay = (dict) => {
    const out = {};
    for (const [k, row] of Object.entries(dict || {})) out[k] = applyOverrideToEnrichedRow(row, overrides);
    return out;
  };
  return {
    enrichedByLh: overlay(maps?.enrichedByLh),
    enrichedByCargoId: overlay(maps?.enrichedByCargoId),
  };
}
