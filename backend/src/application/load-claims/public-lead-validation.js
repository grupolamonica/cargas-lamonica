import "../../infrastructure/config/load-env.js";
import { getTrailerPlateRequirement } from "../../domain/vehicle-profiles.js";
import { logStructuredEvent } from "../../infrastructure/security-log.js";
import { recordPublicLeadValidationMetrics } from "../../infrastructure/metrics.js";
import { lookupAngelliraDriverByCpf, lookupAngelliraPlate } from "../../infrastructure/angellira/angellira-client.js";
import { lookupAspxDriverByCpf } from "../../infrastructure/aspx/aspx-directory.js";
import {
  syncDriverAngelliraValidation,
  syncVehicleAngelliraLookup,
  lookupCachedAngelliraValidation,
  lookupCachedAngelliraPlate,
} from "../operator-admin/service.js";
import { syncDriverBrkValidation, extractEarliestBrkValidUntil } from "../operator-admin/use-cases/brk-cache.js";
import { consultarBrkPainel } from "../../infrastructure/brk/brk-client.js";
import { syncDriverSpxValidation } from "../operator-admin/use-cases/spx-vigency-cache.js";

const VALIDATION_SCHEMA_VERSION = 1;
const SUPPORT_MESSAGE_MAX_REASONS = 3;

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function buildSupportWhatsappNumber() {
  const digits = normalizePhone(process.env.PUBLIC_LOAD_WHATSAPP_NUMBER || "");

  if (!digits) {
    return null;
  }

  if (digits.startsWith("55")) {
    return digits;
  }

  if (digits.length === 10 || digits.length === 11) {
    return `55${digits}`;
  }

  return null;
}

function buildSupportWhatsappUrl({ loadId, reasons }) {
  const whatsappNumber = buildSupportWhatsappNumber();

  if (!whatsappNumber) {
    return {
      whatsappNumber: null,
      whatsappUrl: null,
    };
  }

  const safeReasons = Array.isArray(reasons) ? reasons.filter(Boolean).slice(0, SUPPORT_MESSAGE_MAX_REASONS) : [];
  const reasonLines = safeReasons.map((reason, index) => `${index + 1}. ${reason}`);

  const messageLines = [
    "Ola! Preciso de ajuda para regularizar meu cadastro e disputar cargas.",
    loadId ? `\nCarga pretendida: *${loadId}*` : null,
    reasonLines.length ? `\nPendencias identificadas:\n${reasonLines.join("\n")}` : null,
    "\nPor favor, me orientem sobre os proximos passos. Obrigado!",
  ].filter(Boolean);

  return {
    whatsappNumber,
    whatsappUrl: `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(messageLines.join("\n"))}`,
  };
}

function toUtcDateOnly(value) {
  if (!value) {
    return null;
  }

  const rawValue = String(value).trim();
  const dateOnlyMatch = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (dateOnlyMatch) {
    return Date.UTC(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]));
  }

  const parsedDate = new Date(rawValue);

  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  return Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate());
}

function toIsoTimestamp(value) {
  const parsedDate = new Date(value);
  return Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString();
}

function calculateDaysUntilExpiry(validUntil, candidateSubmittedAt) {
  const validUntilUtc = toUtcDateOnly(validUntil);
  const candidateUtc = toUtcDateOnly(toIsoTimestamp(candidateSubmittedAt).slice(0, 10));

  if (validUntilUtc === null || candidateUtc === null) {
    return null;
  }

  return Math.round((validUntilUtc - candidateUtc) / 86_400_000);
}

function buildPlateLookups(payload) {
  const plateLookups = [
    {
      field: "horsePlate",
      label: "Placa do cavalo",
      value: payload.horsePlate,
      required: true,
    },
  ];

  const trailerPlateRequirement = getTrailerPlateRequirement(payload.vehicleType);

  if (trailerPlateRequirement >= 1) {
    plateLookups.push({
      field: "trailerPlate",
      label: trailerPlateRequirement >= 2 ? "1a placa da carreta" : "Placa da carreta",
      value: payload.trailerPlate,
      required: true,
    });
  }

  if (trailerPlateRequirement >= 2) {
    plateLookups.push({
      field: "trailerPlate2",
      label: "2a placa da carreta",
      value: payload.trailerPlate2,
      required: true,
    });
  }

  return plateLookups;
}

function buildMissingFields(payload) {
  const missingFields = [];

  if (!String(payload?.cpf || "").trim()) {
    missingFields.push("CPF");
  }

  if (!String(payload?.phone || "").trim()) {
    missingFields.push("telefone");
  }

  if (!String(payload?.horsePlate || "").trim()) {
    missingFields.push("placa do cavalo");
  }

  buildPlateLookups(payload)
    .filter((plateLookup) => plateLookup.field !== "horsePlate")
    .forEach((plateLookup) => {
      if (plateLookup.required && !String(plateLookup.value || "").trim()) {
        missingFields.push(plateLookup.label.toLowerCase());
      }
    });

  return missingFields;
}

function buildVigencySummary(candidateSubmittedAt, driverLookup, plateLookups) {
  const candidates = [
    {
      source: "ANGELLIRA_DRIVER",
      validUntil: driverLookup.validUntil,
    },
    ...plateLookups
      .filter((plateLookup) => plateLookup.found && plateLookup.validUntil)
      .map((plateLookup) => ({
        source: `ANGELLIRA_${plateLookup.field.toUpperCase()}`,
        validUntil: plateLookup.validUntil,
      })),
  ].filter((entry) => entry.validUntil);

  if (driverLookup.availability === "UNAVAILABLE" && candidates.length === 0) {
    return {
      status: "UNAVAILABLE",
      validUntil: null,
      daysUntilExpiry: null,
      source: null,
    };
  }

  if (candidates.length === 0) {
    return {
      status: "MISSING",
      validUntil: null,
      daysUntilExpiry: null,
      source: null,
    };
  }

  const earliestCandidate = candidates.reduce((earliest, currentCandidate) => {
    if (!earliest) {
      return currentCandidate;
    }

    const currentDays = calculateDaysUntilExpiry(currentCandidate.validUntil, candidateSubmittedAt);
    const earliestDays = calculateDaysUntilExpiry(earliest.validUntil, candidateSubmittedAt);

    if (currentDays === null) {
      return earliest;
    }

    if (earliestDays === null || currentDays < earliestDays) {
      return currentCandidate;
    }

    return earliest;
  }, null);

  const daysUntilExpiry = calculateDaysUntilExpiry(earliestCandidate?.validUntil, candidateSubmittedAt);

  if (daysUntilExpiry === null) {
    return {
      status: "MISSING",
      validUntil: earliestCandidate?.validUntil || null,
      daysUntilExpiry: null,
      source: earliestCandidate?.source || null,
    };
  }

  if (daysUntilExpiry <= 0) {
    return {
      status: "INVALID",
      validUntil: earliestCandidate?.validUntil || null,
      daysUntilExpiry,
      source: earliestCandidate?.source || null,
    };
  }

  if (daysUntilExpiry < 30) {
    return {
      status: "EXPIRING",
      validUntil: earliestCandidate?.validUntil || null,
      daysUntilExpiry,
      source: earliestCandidate?.source || null,
    };
  }

  return {
    status: "VALID",
    validUntil: earliestCandidate?.validUntil || null,
    daysUntilExpiry,
    source: earliestCandidate?.source || null,
  };
}

function buildWarnings({
  angeliraDriverLookup,
  aspxDriverLookup,
  plateResults,
  vigency,
  missingFields,
}) {
  const warnings = [];

  if (missingFields.length > 0) {
    warnings.push(`Campos obrigatorios ausentes: ${missingFields.join(", ")}.`);
  }

  if (angeliraDriverLookup.status === "NOT_FOUND") {
    warnings.push("Motorista nao encontrado no Angellira.");
  } else if (angeliraDriverLookup.status === "UNAVAILABLE") {
    warnings.push("Nao foi possivel consultar o Angellira agora.");
  }

  if (aspxDriverLookup.status === "NOT_FOUND") {
    warnings.push("Motorista nao encontrado no diretorio ASPx.");
  } else if (aspxDriverLookup.status === "UNAVAILABLE") {
    warnings.push("Nao foi possivel consultar o diretorio ASPx agora.");
  }

  plateResults.forEach((plateResult) => {
    if (plateResult.status === "NOT_FOUND") {
      warnings.push(`${plateResult.label} nao encontrada no Angellira.`);
    } else if (plateResult.status === "UNAVAILABLE") {
      warnings.push(`Nao foi possivel validar ${plateResult.label.toLowerCase()} no Angellira.`);
    }
  });

  if (vigency.status === "MISSING") {
    warnings.push("Vigencia do cadastro nao foi encontrada.");
  } else if (vigency.status === "INVALID") {
    warnings.push("Vigencia do cadastro esta vencida para esta candidatura.");
  } else if (vigency.status === "EXPIRING" && typeof vigency.daysUntilExpiry === "number") {
    warnings.push(`Vigencia do cadastro vence em ${vigency.daysUntilExpiry} dia(s).`);
  } else if (vigency.status === "UNAVAILABLE") {
    warnings.push("A vigencia nao pode ser validada porque o Angelira esta indisponivel.");
  }

  return warnings;
}

function resolveOverallStatus({
  missingFields,
  driverRegisteredSomewhere,
  allRequiredPlatesFound,
  somePlateUnavailable,
  someSourceUnavailable,
  vigency,
}) {
  if (missingFields.length > 0) {
    return "INCOMPLETE";
  }

  if (vigency.status === "INVALID") {
    return "INVALID";
  }

  if (vigency.status === "EXPIRING") {
    return "EXPIRING";
  }

  if (!driverRegisteredSomewhere && !someSourceUnavailable) {
    return "NOT_FOUND";
  }

  if (!allRequiredPlatesFound && !somePlateUnavailable) {
    return "PLATE_MISMATCH";
  }

  if (someSourceUnavailable || somePlateUnavailable || vigency.status === "UNAVAILABLE") {
    if (driverRegisteredSomewhere || allRequiredPlatesFound) {
      return "PARTIAL";
    }

    return "UNAVAILABLE";
  }

  if (driverRegisteredSomewhere && allRequiredPlatesFound && vigency.status === "VALID") {
    return "VALID";
  }

  return "PARTIAL";
}

export function sanitizeValidationSummaryForStorage(summary) {
  // Previously stripped displayName from driver sources before storage.
  // Now kept so operators can see the Angellira/ASPx name for public leads.
  return summary;
}

export function rehydrateStoredValidationSummary(rawSummary, fallback = {}) {
  if (!rawSummary || typeof rawSummary !== "object" || Array.isArray(rawSummary)) {
    return null;
  }

  if (!rawSummary.driver || !rawSummary.vigency || !Array.isArray(rawSummary.plates)) {
    return null;
  }

  return {
    ...rawSummary,
    overallStatus: fallback.status || rawSummary.overallStatus || "PARTIAL",
    checkedAt: fallback.checkedAt || rawSummary.checkedAt || null,
  };
}

// Resultado sintético "indisponível" para o modo cacheOnly: quando não há cache
// fresco e não queremos disparar a chamada ao vivo (8-15s) ao Angellira. O
// pipeline trata UNAVAILABLE de forma graciosa (warnings + fallback stale 7d).
function makeUnavailableAngellira(queryFor, queryValue) {
  return {
    queryFor,
    queryValue,
    availability: "UNAVAILABLE",
    status: "UNAVAILABLE",
    found: false,
    displayName: null,
    validUntil: null,
    lastSeenAt: null,
    statusText: null,
  };
}

export async function validatePublicLeadPreRegistration({
  loadId,
  payload,
  candidateSubmittedAt = new Date().toISOString(),
  correlationId,
  // cacheOnly: pula chamadas ao vivo do Angellira (usa só cache/DB). Usado no
  // pré-check do resgate pelo operador, onde a latência de 8-15s/chamada torna
  // a tela inutilizável. A validação autoritativa ocorre no submit (cascata ANTT).
  cacheOnly = false,
}) {
  const resolvedCandidateSubmittedAt = toIsoTimestamp(candidateSubmittedAt);
  const validationStartedAt = Date.now();
  const plateLookups = buildPlateLookups(payload);
  const missingFields = buildMissingFields(payload);

  logStructuredEvent("info", "driver-validation.public-lead.started", {
    correlationId: correlationId || null,
    loadId,
    plateCount: plateLookups.length,
    missingFieldCount: missingFields.length,
  });

  // Verifica cache local (banco) antes de consultar APIs externas.
  // Se o CPF ja foi validado recentemente (< 24h), reutiliza o resultado
  // e evita a latencia de 8-15s por chamada ao Angellira.
  let cachedAngellira = null;
  if (payload.cpf) {
    try {
      cachedAngellira = await lookupCachedAngelliraValidation({
        documentNumber: payload.cpf,
        correlationId,
      });
    } catch {
      // Cache miss silencioso — segue para a API externa
      cachedAngellira = null;
    }
  }

  const useCachedAngellira = cachedAngellira?.found && cachedAngellira.cached;

  if (useCachedAngellira) {
    logStructuredEvent("info", "driver-validation.public-lead.cache_hit", {
      correlationId: correlationId || null,
      loadId,
      angelliraStatus: cachedAngellira.angelliraResult.status,
      driverName: cachedAngellira.driverName || null,
    });
  }

  // DB-first em placas: consulta a tabela vehicles em paralelo para cada placa.
  // Placas com cache fresco (<24h) nao disparam chamada Angellira.
  const plateCacheLookups = await Promise.all(
    plateLookups.map((plateLookup) =>
      lookupCachedAngelliraPlate({ plate: plateLookup.value, correlationId })
        .then((result) => ({ plateLookup, cache: result }))
        .catch(() => ({ plateLookup, cache: { found: false, reason: "CACHE_ERROR" } })),
    ),
  );

  const plateCacheHitValues = plateCacheLookups
    .filter(({ cache }) => cache?.found && cache?.cached)
    .map(({ plateLookup }) => plateLookup.value);

  if (plateCacheHitValues.length > 0) {
    logStructuredEvent("info", "driver-validation.public-lead.plate_cache_hit", {
      correlationId: correlationId || null,
      loadId,
      cachedCount: plateCacheHitValues.length,
      totalPlates: plateLookups.length,
    });
  }

  // BRK (Brasil Risk): consulta o conjunto (motorista + placas) EM PARALELO, atrás da
  // mesma feature-flag do sync (BRK_SYNC_ENABLED). O resultado vai em summary.driver.brk
  // e alimenta o card do lead (espelha angelira/aspx, que também vêm da candidatura).
  // Nunca bloqueia o fluxo: erro/indisponível → null.
  const brkPlacasParaPainel = plateCacheLookups
    .map(({ plateLookup }) => plateLookup.value)
    .filter(Boolean);
  const brkPainelPromise =
    process.env.BRK_SYNC_ENABLED === "1" && payload.cpf && !cacheOnly
      ? consultarBrkPainel({ cpf: payload.cpf, placas: brkPlacasParaPainel, correlationId }).catch(() => null)
      : Promise.resolve(null);

  const [angeliraRaw, aspxDriverLookup, ...plateResults] = await Promise.all([
    useCachedAngellira
      ? Promise.resolve(cachedAngellira.angelliraResult)
      : cacheOnly
        ? Promise.resolve(makeUnavailableAngellira("cpf", payload.cpf))
        : lookupAngelliraDriverByCpf(payload.cpf, {
            correlationId,
          }),
    lookupAspxDriverByCpf(payload.cpf, {
      correlationId,
    }),
    ...plateCacheLookups.map(({ plateLookup, cache }) => {
      const cacheHit = cache?.found && cache?.cached;
      const lookupPromise = cacheHit
        ? Promise.resolve({ ...cache.angelliraResult, fromCache: true })
        : cacheOnly
          ? Promise.resolve(makeUnavailableAngellira("plate", plateLookup.value))
          : lookupAngelliraPlate(plateLookup.value, { correlationId });

      return lookupPromise.then((lookupResult) => ({
        ...plateLookup,
        ...lookupResult,
      }));
    }),
  ]);

  // Se Angellira retornou UNAVAILABLE e não havia cache fresco, tenta stale cache (7d).
  // Evita rejeitar candidatura por indisponibilidade temporária do serviço externo.
  let angeliraDriverLookup = angeliraRaw;
  if (angeliraRaw.status === "UNAVAILABLE" && !useCachedAngellira && payload.cpf) {
    try {
      const staleCache = await lookupCachedAngelliraValidation({
        documentNumber: payload.cpf,
        correlationId,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      });
      if (staleCache?.found) {
        angeliraDriverLookup = { ...staleCache.angelliraResult, fromStaleCache: true };
        logStructuredEvent("info", "driver-validation.public-lead.angellira_stale_cache_fallback", {
          correlationId: correlationId || null,
          loadId,
          driverName: staleCache.driverName || null,
        });
      }
    } catch {
      // stale cache miss — mantém UNAVAILABLE
    }
  }

  const driverRegisteredSomewhere = Boolean(angeliraDriverLookup.found || aspxDriverLookup.found);
  const allRequiredPlatesFound = plateResults.every((plateResult) => plateResult.found);
  const somePlateUnavailable = plateResults.some((plateResult) => plateResult.status === "UNAVAILABLE");
  const someSourceUnavailable =
    angeliraDriverLookup.status === "UNAVAILABLE" || aspxDriverLookup.status === "UNAVAILABLE";
  const vigency = buildVigencySummary(resolvedCandidateSubmittedAt, angeliraDriverLookup, plateResults);

  logStructuredEvent("info", "driver-validation.public-lead.vigency_resolved", {
    correlationId: correlationId || null,
    loadId,
    vigencyStatus: vigency.status,
    validUntil: vigency.validUntil || null,
    daysUntilExpiry: vigency.daysUntilExpiry ?? null,
    source: vigency.source || null,
    driverRegisteredSomewhere,
    allRequiredPlatesFound,
  });

  const hasAnyAngelliraMatch = Boolean(
    angeliraDriverLookup.found || plateResults.some((plateResult) => plateResult.found),
  );

  if (vigency.status === "MISSING" && hasAnyAngelliraMatch && missingFields.includes("validade") === false) {
    missingFields.push("validade");
  }

  const warnings = buildWarnings({
    angeliraDriverLookup,
    aspxDriverLookup,
    plateResults,
    vigency,
    missingFields,
  });

  const overallStatus = resolveOverallStatus({
    missingFields,
    driverRegisteredSomewhere,
    allRequiredPlatesFound,
    somePlateUnavailable,
    someSourceUnavailable,
    vigency,
  });

  const supportReasons = warnings.filter(Boolean);
  const brkPainel = await brkPainelPromise;
  const summary = {
    schemaVersion: VALIDATION_SCHEMA_VERSION,
    checkedAt: new Date().toISOString(),
    candidateSubmittedAt: resolvedCandidateSubmittedAt,
    overallStatus,
    missingFields,
    warnings,
    driver: {
      angelira: {
        status: angeliraDriverLookup.status,
        found: angeliraDriverLookup.found,
        displayName: angeliraDriverLookup.displayName || null,
        validUntil: angeliraDriverLookup.validUntil || null,
        lastSeenAt: angeliraDriverLookup.lastSeenAt || null,
        // Full Angellira driver details enable the operator UI to pre-fill
        // the entire registration form (birthDate, RG, UF, parents, CNH,
        // security code, CNH validity, phone, city) instead of only the name.
        details: angeliraDriverLookup.driverDetails || null,
        statusText: angeliraDriverLookup.statusText || null,
      },
      aspx: {
        status: aspxDriverLookup.status,
        found: aspxDriverLookup.found,
        displayName: aspxDriverLookup.displayName || null,
      },
      // BRK (Brasil Risk): aptidão do conjunto vinda da consulta camoufox. Presente
      // aqui, o card do lead mostra o selo BRK real (antes ficava "Não cadastrado"
      // porque brk_* só existe em driver_profiles/motorista REGISTRADO).
      brk:
        brkPainel && brkPainel.availability === "OK" && brkPainel.status !== "erro"
          ? {
              status: brkPainel.status || null,
              found: brkPainel.conjunto_apto === true || brkPainel.status === "vigente",
              conjuntoApto: typeof brkPainel.conjunto_apto === "boolean" ? brkPainel.conjunto_apto : null,
              validUntil: extractEarliestBrkValidUntil(brkPainel.componentes),
              statusText: brkPainel.label || null,
              componentes: brkPainel.componentes || null,
              checkedAt: brkPainel.consultado_em || new Date().toISOString(),
            }
          : null,
    },
    plates: plateResults.map((plateResult) => ({
      field: plateResult.field,
      label: plateResult.label,
      status: plateResult.status,
      found: plateResult.found,
      validUntil: plateResult.validUntil || null,
      lastSeenAt: plateResult.lastSeenAt || null,
    })),
    vigency,
    support: {
      ...buildSupportWhatsappUrl({
        loadId,
        reasons: supportReasons,
      }),
    },
    sources: {
      angelira: {
        status: angeliraDriverLookup.availability === "UNAVAILABLE" ? "UNAVAILABLE" : "OK",
      },
      aspx: {
        status: aspxDriverLookup.availability === "UNAVAILABLE" ? "UNAVAILABLE" : "OK",
      },
    },
  };

  logStructuredEvent("info", "driver-validation.public-lead.completed", {
    correlationId: correlationId || null,
    loadId,
    overallStatus,
    driverRegisteredSomewhere,
    allRequiredPlatesFound,
    vigencyStatus: vigency.status,
    latencyMs: Date.now() - validationStartedAt,
  });
  recordPublicLeadValidationMetrics({
    overallStatus,
    warningsCount: warnings.length,
    latencyMs: Date.now() - validationStartedAt,
  });

  // Fire-and-forget: persistir resultado do Angellira no perfil do motorista cadastrado.
  // Se o CPF corresponder a um motorista registrado, as colunas angellira_* serao atualizadas.
  // Pula a escrita quando o resultado veio do cache local (dados ja estao no banco).
  // Erros nao devem bloquear o fluxo de validacao principal.
  if (payload.cpf && angeliraDriverLookup.availability === "OK" && !useCachedAngellira) {
    syncDriverAngelliraValidation({
      documentNumber: payload.cpf,
      angelliraResult: angeliraDriverLookup,
      correlationId,
    }).catch((syncError) => {
      logStructuredEvent("warn", "driver-validation.angellira-sync.failed", {
        correlationId: correlationId || null,
        message: syncError instanceof Error ? syncError.message : String(syncError),
      });
    });
  }

  // Fire-and-forget: persistir aptidao do BRK (Brasil Risk) no perfil do motorista.
  // ATRAS DE FEATURE-FLAG (BRK_SYNC_ENABLED=1) — desligado por padrao = no-op seguro
  // em producao. Roda EM PARALELO ao sync do Angellira. As placas do conjunto
  // (cavalo + carreta) vem dos plateResults da propria validacao publica.
  if (process.env.BRK_SYNC_ENABLED === "1" && payload.cpf) {
    const brkPlacas = plateResults
      .map((plateResult) => plateResult.value)
      .filter(Boolean);

    syncDriverBrkValidation({
      cpf: payload.cpf,
      placas: brkPlacas,
      correlationId,
    }).catch((syncError) => {
      logStructuredEvent("warn", "driver-validation.brk-sync.failed", {
        correlationId: correlationId || null,
        message: syncError instanceof Error ? syncError.message : String(syncError),
      });
    });
  }

  // Fire-and-forget: persistir a SITUACAO do motorista no SPX (Shopee Express) no
  // perfil. ATRAS DE FEATURE-FLAG (SPX_VIGENCY_SYNC_ENABLED=1) — desligado por padrao
  // = no-op seguro em producao. Lookup read-only (sem efeito colateral no SPX);
  // passa o telefone quando disponivel para reduzir resultados inconclusivos.
  if (process.env.SPX_VIGENCY_SYNC_ENABLED === "1" && payload.cpf) {
    syncDriverSpxValidation({
      cpf: payload.cpf,
      contactNumber: payload.contact_number || payload.contactNumber || "",
      correlationId,
    }).catch((syncError) => {
      logStructuredEvent("warn", "driver-validation.spx-vigency-sync.failed", {
        correlationId: correlationId || null,
        message: syncError instanceof Error ? syncError.message : String(syncError),
      });
    });
  }

  // Fire-and-forget: persist plate lookup results to the vehicles table.
  // Resultados vindos do cache local sao pulados (dados ja estao no banco).
  for (const plateResult of plateResults) {
    if (plateResult.availability === "OK" && plateResult.value && !plateResult.fromCache) {
      syncVehicleAngelliraLookup({
        plate: plateResult.value,
        plateRole: plateResult.field === "horsePlate" ? "HORSE"
                  : plateResult.field === "trailerPlate" ? "TRAILER_1"
                  : "TRAILER_2",
        vehicleType: payload.vehicleType || payload.vehicle_type || null,
        angelliraResult: plateResult,
        linkedDriverCpf: payload.cpf || null,
        correlationId,
      }).catch((syncError) => {
        logStructuredEvent("warn", "driver-validation.vehicle-sync.failed", {
          correlationId: correlationId || null,
          plate: plateResult.queryValue || null,
          message: syncError instanceof Error ? syncError.message : String(syncError),
        });
      });
    }
  }

  return {
    summary,
    storedSummary: sanitizeValidationSummaryForStorage(summary),
  };
}
