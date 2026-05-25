import { validatePublicLeadPreRegistration } from "../../load-claims/public-lead-validation.js";
import { withPgClient } from "../../../infrastructure/pg/postgres.js";

// Iter #7 — janela de busca para duplicate detection no pre-check.
// Cadastros enviados ha menos de 30 dias na mesma (CPF, horsePlate) sao
// surfaceados como pendencia DUPLICATE_PENDING_REGISTRATION pra evitar que
// o motorista refaca o wizard inteiro quando ja submeteu a mesma combinacao.
const DUPLICATE_LOOKBACK_DAYS = 30;

// Janela de vigencia em dias para considerar uma pendencia de renovacao (D-11).
// Veiculos com daysUntilExpiry <= 20 entram em `pendencias` para renovacao.
// daysUntilExpiry > 20 vai para `completos`.
const VIGENCY_PENDING_THRESHOLD_DAYS = 20;

/**
 * Decide o vehicleType canonico com base no numero de carretas declaradas.
 * Garante que buildPlateLookups inclua todas as placas fornecidas.
 *
 * - 0 carretas -> TRUCK (so cavalo)
 * - 1 carreta -> CARRETA
 * - 2 carretas -> BITREM
 */
function resolveVehicleTypeFromTrailerCount(trailerCount) {
  if (trailerCount >= 2) return "BITREM";
  if (trailerCount === 1) return "CARRETA";
  return "TRUCK";
}

/**
 * Mapeia o resultado de driverLookup do summary do public-lead-validation
 * para uma pendencia de Step A, se aplicavel.
 */
function buildDriverPendency(driverSummary) {
  const angellira = driverSummary?.angelira || {};
  const aspx = driverSummary?.aspx || {};

  // Se nenhuma fonte retornou cadastro do motorista, e pendencia de Step A.
  if (!angellira.found && !aspx.found) {
    return {
      step: "A",
      reason: "DRIVER_NOT_FOUND",
      label: "Seus dados de motorista ainda nao foram cadastrados",
    };
  }

  return null;
}

// Meses abreviados em pt-BR para labels amigaveis tipo "fev/2022".
const MESES_PT_BR = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/**
 * Formata uma data como "mes/ano" pt-BR (ex: "fev/2022").
 * Retorna null se a data nao for parseavel.
 */
function formatMonthYearPtBr(validUntil) {
  if (!validUntil) return null;
  const rawValue = String(validUntil).trim();
  const dateOnlyMatch = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let year;
  let monthIdx;
  if (dateOnlyMatch) {
    year = Number(dateOnlyMatch[1]);
    monthIdx = Number(dateOnlyMatch[2]) - 1;
  } else {
    const parsedDate = new Date(rawValue);
    if (Number.isNaN(parsedDate.getTime())) return null;
    year = parsedDate.getUTCFullYear();
    monthIdx = parsedDate.getUTCMonth();
  }
  if (monthIdx < 0 || monthIdx > 11) return null;
  return `${MESES_PT_BR[monthIdx]}/${year}`;
}

/**
 * Constroi label do CRLV em linguagem amigavel ao motorista.
 *
 * Regras (linguagem caminhoneiro, conservadora):
 * - sem data:                    "Documento do veiculo X esta sem data de validade"
 * - vencido > 30 dias:           "Documento do veiculo X venceu em mes/ano. Precisamos do novo."
 * - vencido entre 1 e 30 dias:   "Documento do veiculo X venceu ha N dia(s). Sobe o CRLV novo."
 * - vence hoje:                  "Documento do veiculo X vence hoje. Renove ja!"
 * - vence em <= 20 dias:         "Documento do veiculo X vence em N dia(s). Renove em breve."
 */
function buildPlateExpiryLabel({ plate, daysUntilExpiry, validUntil }) {
  if (daysUntilExpiry === null || daysUntilExpiry === undefined) {
    return `Documento do veiculo ${plate} esta sem data de validade`;
  }
  if (daysUntilExpiry < -30) {
    const monthYear = formatMonthYearPtBr(validUntil);
    return monthYear
      ? `Documento do veiculo ${plate} venceu em ${monthYear}. Precisamos do novo.`
      : `Documento do veiculo ${plate} esta vencido faz tempo. Precisamos do novo.`;
  }
  if (daysUntilExpiry < 0) {
    const abs = Math.abs(daysUntilExpiry);
    return `Documento do veiculo ${plate} venceu ha ${abs} dia(s). Sobe o CRLV novo.`;
  }
  if (daysUntilExpiry === 0) {
    return `Documento do veiculo ${plate} vence hoje. Renove ja!`;
  }
  return `Documento do veiculo ${plate} vence em ${daysUntilExpiry} dia(s). Renove em breve.`;
}

/**
 * Mapeia o resultado por placa para pendencia ou completo.
 *
 * - status NOT_FOUND -> pendencia NOT_FOUND
 * - status FOUND + classificacao mismatch (cavalo<->carreta) -> pendencia
 *   VEHICLE_TYPE_MISMATCH (bloqueia avanco, motorista precisa corrigir placa).
 * - status FOUND + daysUntilExpiry <= 20 -> pendencia EXPIRING
 * - status FOUND + daysUntilExpiry > 20 -> completo
 * - status UNAVAILABLE -> pula (nao bloqueia o motorista por indisponibilidade externa)
 */
function classifyPlate({ plateResult, plate, step, candidateSubmittedAt }) {
  if (plateResult.status === "NOT_FOUND") {
    return {
      pendencia: {
        step,
        plate,
        reason: "NOT_FOUND",
        label: `Documento do veiculo ${plate} ainda nao foi cadastrado`,
      },
    };
  }

  if (plateResult.status === "UNAVAILABLE") {
    // Sem dado disponivel — nao bloqueia nem certifica como completo.
    return {};
  }

  // Mismatch tipo veiculo: o slot (horsePlate=B / trailerPlate=D) define o
  // tipo esperado; classificacao do Angellira/ASPX precisa bater. Quando
  // diferge, bloqueamos pra evitar candidatura com placa errada (motorista
  // pode ter digitado a carreta no campo do cavalo).
  const expectedType = step === "B" ? "cavalo" : step === "D" ? "carreta" : null;
  const actualType = plateResult.vehicleClassification || null;
  if (expectedType && actualType && expectedType !== actualType) {
    const wrongHere = actualType === "cavalo" ? "cavalo" : "carreta";
    const correctHere = expectedType === "cavalo" ? "cavalo" : "carreta";
    return {
      pendencia: {
        step,
        plate,
        reason: "VEHICLE_TYPE_MISMATCH",
        expectedType,
        actualType,
        label: `A placa ${plate} esta cadastrada como ${wrongHere}, mas voce informou no campo de ${correctHere}. Confirme a placa correta.`,
      },
    };
  }

  const daysUntilExpiry = calculateDaysUntilExpiry(plateResult.validUntil, candidateSubmittedAt);

  if (daysUntilExpiry === null) {
    // Sem validUntil reconhecivel mas veio FOUND — trata como pendencia de renovacao.
    return {
      pendencia: {
        step,
        plate,
        reason: "EXPIRING",
        daysUntilExpiry: null,
        validUntil: plateResult.validUntil || null,
        label: buildPlateExpiryLabel({ plate, daysUntilExpiry: null, validUntil: null }),
      },
    };
  }

  if (daysUntilExpiry <= VIGENCY_PENDING_THRESHOLD_DAYS) {
    return {
      pendencia: {
        step,
        plate,
        reason: daysUntilExpiry <= 0 ? "EXPIRED" : "EXPIRING",
        daysUntilExpiry,
        validUntil: plateResult.validUntil || null,
        label: buildPlateExpiryLabel({
          plate,
          daysUntilExpiry,
          validUntil: plateResult.validUntil,
        }),
      },
    };
  }

  return {
    completo: { plate, daysUntilExpiry },
  };
}

function toUtcDateOnly(value) {
  if (!value) return null;
  const rawValue = String(value).trim();
  const dateOnlyMatch = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (dateOnlyMatch) {
    return Date.UTC(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]));
  }

  const parsedDate = new Date(rawValue);
  if (Number.isNaN(parsedDate.getTime())) return null;

  return Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate());
}

function calculateDaysUntilExpiry(validUntil, candidateSubmittedAt) {
  const validUntilUtc = toUtcDateOnly(validUntil);
  const submittedUtc = toUtcDateOnly(String(candidateSubmittedAt || new Date().toISOString()).slice(0, 10));

  if (validUntilUtc === null || submittedUtc === null) return null;

  return Math.round((validUntilUtc - submittedUtc) / 86_400_000);
}

/**
 * Pre-check para o wizard de cadastro v2.
 *
 * Reusa `validatePublicLeadPreRegistration` (Angellira+ASPX+vigencia) para o CPF/placas
 * do motorista autenticado e retorna a divisao entre pendencias (steps A/B/D do wizard)
 * e cadastros completos.
 *
 * @param {Object} args
 * @param {string} args.driverCpf CPF do motorista autenticado (D-02 — sempre do perfil).
 * @param {string} [args.driverPhone] Telefone do motorista autenticado.
 * @param {string} args.horsePlate Placa do cavalo.
 * @param {string[]} args.trailerPlates 0 a 2 placas de carreta.
 * @param {string} [args.correlationId]
 * @returns {Promise<{ pendencias: Array, completos: Array }>}
 */
export async function candidaturaPreCheck({
  driverCpf,
  driverPhone,
  horsePlate,
  trailerPlates = [],
  correlationId,
}) {
  const candidateSubmittedAt = new Date().toISOString();
  const normalizedTrailerPlates = Array.isArray(trailerPlates) ? trailerPlates : [];

  const payload = {
    cpf: driverCpf,
    phone: driverPhone || "",
    horsePlate,
    trailerPlate: normalizedTrailerPlates[0] || "",
    trailerPlate2: normalizedTrailerPlates[1] || "",
    vehicleType: resolveVehicleTypeFromTrailerCount(normalizedTrailerPlates.length),
  };

  const { summary } = await validatePublicLeadPreRegistration({
    payload,
    candidateSubmittedAt,
    correlationId,
  });

  const pendencias = [];
  const completos = [];

  const driverPendency = buildDriverPendency(summary.driver);
  if (driverPendency) {
    pendencias.push(driverPendency);
  }

  // summary.plates nao carrega a placa original; correlacionamos pelo field name.
  const platesByField = {
    horsePlate: payload.horsePlate,
    trailerPlate: payload.trailerPlate,
    trailerPlate2: payload.trailerPlate2,
  };

  for (const plateResult of summary.plates || []) {
    const step = plateResult.field === "horsePlate" ? "B" : "D";
    const plate = (platesByField[plateResult.field] || "").trim();

    if (!plate) {
      // Campo presente no summary mas sem placa de entrada — pula.
      continue;
    }

    const { pendencia, completo } = classifyPlate({
      plateResult,
      plate,
      step,
      candidateSubmittedAt,
    });

    if (pendencia) {
      pendencias.push(pendencia);
    } else if (completo) {
      completos.push(completo);
    }
  }

  // ── Iter #7: Duplicate detection ────────────────────────────────────────
  // Checa se ja existe cadastro com mesmo (cpf, horsePlate) em status pendente/
  // em_revisao/em_analise nos ultimos 30d. Se sim, retorna pendencia informativa
  // (allowSkipWizard=true) — NAO bloqueia, apenas informa o motorista que ele
  // pode reaproveitar o cadastro existente.
  const normalizedCpf = String(driverCpf || "").replace(/\D/g, "");
  const normalizedHorsePlate = String(horsePlate || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalizedCpf.length === 11 && normalizedHorsePlate.length >= 7) {
    try {
      const duplicate = await findDuplicatePendingRegistration({
        cpf: normalizedCpf,
        horsePlate: normalizedHorsePlate,
      });
      if (duplicate) {
        pendencias.push({
          step: "A",
          reason: "DUPLICATE_PENDING_REGISTRATION",
          allowSkipWizard: true,
          pendingRegistrationId: duplicate.id,
          submittedAt: duplicate.created_at instanceof Date
            ? duplicate.created_at.toISOString()
            : new Date(duplicate.created_at).toISOString(),
          status: duplicate.status,
          label: "Cadastro em analise — voce pode enviar a candidatura sem refazer.",
        });
      }
    } catch (err) {
      // Falha de DB no duplicate-check NAO bloqueia o pre-check: apenas loga.
      console.warn("[candidatura.pre-check.duplicate-check]", {
        correlationId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { pendencias, completos };
}

/**
 * Iter #7 — consulta no Postgres por cadastros com mesmo (CPF, placa cavalo) ja
 * submetidos nos ultimos 30 dias e ainda em analise/pendentes.
 *
 * Status considerados: pendente | em_revisao | em_analise. Status 'rejeitado'/
 * 'aprovado' nao bloqueiam — motorista ja teve resolucao.
 *
 * @returns {Promise<{ id, status, created_at, carga_id } | null>}
 */
async function findDuplicatePendingRegistration({ cpf, horsePlate }) {
  return withPgClient(async (client) => {
    const result = await client.query(
      `
        SELECT id, status, created_at, carga_id
        FROM public.pending_driver_registrations
        WHERE dados->'motorista'->>'cpf' = $1
          AND dados->'cavalo'->>'placa' = $2
          AND status IN ('pendente', 'em_revisao', 'em_analise')
          AND created_at > now() - ($3 || ' days')::interval
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [cpf, horsePlate, String(DUPLICATE_LOOKBACK_DAYS)],
    );
    return result.rows[0] || null;
  });
}
