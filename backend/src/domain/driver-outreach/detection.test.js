import { describe, expect, it } from "vitest";

import {
  OUTREACH_TRIGGERS,
  detectAbandonment,
  detectChurn,
  detectLostRegistration,
  detectOpportunitiesForDriver,
  detectReturnLoad,
  diffCalendarDays,
  extractUf,
  inferPreferences,
  normalizeText,
} from "./detection.js";

const TODAY = "2026-07-07";
const NOW = "2026-07-07T12:00:00.000Z";

describe("helpers", () => {
  it("normalizeText remove acentos, uppercase e colapsa espaços", () => {
    expect(normalizeText("  Jaboatão  dos   Guararapes ")).toBe("JABOATAO DOS GUARARAPES");
    expect(normalizeText(null)).toBe("");
  });

  it("extractUf pega o trecho após a última barra", () => {
    expect(extractUf("Jaboatão dos Guararapes / PE")).toBe("PE");
    expect(extractUf("Simoes Filho / BA")).toBe("BA");
    expect(extractUf("Sem barra")).toBe("");
  });

  it("diffCalendarDays conta dias de calendário em UTC", () => {
    expect(diffCalendarDays("2026-05-01", "2026-07-07")).toBe(67);
    expect(diffCalendarDays("2026-07-07", "2026-07-07")).toBe(0);
    expect(diffCalendarDays("lixo", "2026-07-07")).toBeNull();
  });
});

describe("detectChurn", () => {
  it("sinaliza quando passou do limite (medium) e escala para high", () => {
    const medium = detectChurn({ lastLoadIso: "2026-05-01", totalLoads: 4, todayIso: TODAY });
    expect(medium?.trigger).toBe(OUTREACH_TRIGGERS.CHURN);
    expect(medium.severity).toBe("medium");
    expect(medium.data.daysSinceLastLoad).toBe(67);

    const high = detectChurn({ lastLoadIso: "2026-01-01", totalLoads: 10, todayIso: TODAY });
    expect(high.severity).toBe("high"); // 187 dias >= 90
  });

  it("não sinaliza dentro da janela, sem histórico ou sem última carga", () => {
    expect(detectChurn({ lastLoadIso: "2026-07-01", totalLoads: 3, todayIso: TODAY })).toBeNull();
    expect(detectChurn({ lastLoadIso: "2026-01-01", totalLoads: 0, todayIso: TODAY })).toBeNull();
    expect(detectChurn({ totalLoads: 5, todayIso: TODAY })).toBeNull();
  });

  it("respeita churnDays customizado", () => {
    const opp = detectChurn(
      { lastLoadIso: "2026-06-25", totalLoads: 2, todayIso: TODAY },
      { churnDays: 10 },
    );
    expect(opp?.data.daysSinceLastLoad).toBe(12);
  });
});

describe("inferPreferences", () => {
  it("agrega rota/perfil/UF mais frequentes acima do mínimo de cargas", () => {
    const loads = [
      { origem: "Simoes Filho / BA", destino: "Jaboatão / PE", perfil: "Carreta" },
      { origem: "Simoes Filho / BA", destino: "Jaboatão / PE", perfil: "Carreta" },
      { origem: "Simoes Filho / BA", destino: "Recife / PE", perfil: "Truck" },
    ];
    const pref = inferPreferences({ loads });
    expect(pref?.trigger).toBe(OUTREACH_TRIGGERS.PREFERENCES);
    expect(pref.data.sampleSize).toBe(3);
    expect(pref.data.topRoutes[0].key).toBe("SIMOES FILHO / BA -> JABOATAO / PE");
    expect(pref.data.topPerfil).toBe("CARRETA");
    expect(pref.data.homeBaseUf).toBe("BA");
    expect(pref.data.topDestinoUf).toContain("PE");
  });

  it("retorna null abaixo do mínimo de cargas", () => {
    expect(inferPreferences({ loads: [{ origem: "A / BA", destino: "B / PE" }] })).toBeNull();
  });
});

describe("detectLostRegistration", () => {
  it("sinaliza cadastro draft antigo e lista o que falta a partir de onde parou", () => {
    const opp = detectLostRegistration({
      registration: { status: "draft", currentStep: "step-c", createdAt: "2026-07-05T00:00:00.000Z" },
      now: NOW,
    });
    expect(opp?.trigger).toBe(OUTREACH_TRIGGERS.LOST_REGISTRATION);
    expect(opp.data.currentStep).toBe("step-c");
    expect(opp.data.ageHours).toBeGreaterThanOrEqual(24);
    expect(opp.data.completedSteps.map((s) => s.key)).toEqual(["step-a", "step-b"]);
    expect(opp.data.missingSteps.map((s) => s.key)).toEqual(["step-c", "step-d", "step-e", "confirmation"]);
    expect(opp.data.missingSteps[0].label).toMatch(/Proprietário/);
  });

  it("não sinaliza cadastro concluído/aprovado ou com protocolo", () => {
    expect(
      detectLostRegistration({ registration: { status: "concluido", createdAt: "2026-06-01" }, now: NOW }),
    ).toBeNull();
    expect(
      detectLostRegistration({
        registration: { status: "draft", hasProtocolo: true, createdAt: "2026-06-01" },
        now: NOW,
      }),
    ).toBeNull();
  });

  it("não sinaliza cadastro recém-iniciado (dentro da janela)", () => {
    expect(
      detectLostRegistration({
        registration: { status: "draft", createdAt: "2026-07-07T06:00:00.000Z" },
        now: NOW,
      }),
    ).toBeNull(); // 6h < 24h
  });
});

describe("detectAbandonment", () => {
  it("NÃO sinaliza candidatura QUEUED sozinha (aguardar alocação não é abandono)", () => {
    const opp = detectAbandonment({
      lead: { status: "QUEUED", createdAt: "2026-07-01T00:00:00.000Z" },
      now: NOW,
    });
    expect(opp).toBeNull();
  });

  it("sinaliza no-show / reserva expirada (ignora lead_stalled se junto)", () => {
    const opp = detectAbandonment({
      lead: { status: "QUEUED", createdAt: "2026-07-01T00:00:00.000Z" },
      claim: { status: "NOSHOW" },
      now: NOW,
    });
    expect(opp?.trigger).toBe(OUTREACH_TRIGGERS.ABANDONMENT);
    const kinds = opp.data.signals.map((s) => s.kind);
    expect(kinds).toContain("claim_noshow");
    // lead_stalled é filtrado — não vira card sozinho nem acompanha claim.
    expect(kinds).not.toContain("lead_stalled");
  });

  it("não sinaliza lead recente nem claim ativo", () => {
    expect(
      detectAbandonment({ lead: { status: "QUEUED", createdAt: "2026-07-07T00:00:00.000Z" }, now: NOW }),
    ).toBeNull(); // 12h < 48h
    expect(detectAbandonment({ claim: { status: "CONFIRMED" }, now: NOW })).toBeNull();
    expect(detectAbandonment({ now: NOW })).toBeNull();
  });
});

describe("detectReturnLoad", () => {
  const bundle = {
    loads: [
      { origem: "Simoes Filho / BA", destino: "Recife / PE", dateIso: "2026-07-01" },
      { origem: "Simoes Filho / BA", destino: "Salvador / BA", dateIso: "2026-05-01" },
    ],
  };

  it("sugere cargas OPEN saindo da UF do último destino, priorizando volta à base", () => {
    const openLoads = [
      { id: "l1", origem: "Recife / PE", destino: "Feira de Santana / BA", dateIso: "2026-07-10" },
      { id: "l2", origem: "Recife / PE", destino: "Natal / RN", dateIso: "2026-07-08" },
      { id: "l3", origem: "Salvador / BA", destino: "Recife / PE", dateIso: "2026-07-09" },
    ];
    const opp = detectReturnLoad(bundle, { openLoads });
    expect(opp?.trigger).toBe(OUTREACH_TRIGGERS.RETURN_LOAD);
    expect(opp.data.fromUf).toBe("PE"); // último destino
    expect(opp.data.homeBaseUf).toBe("BA"); // origem mais frequente
    expect(opp.data.suggestions.map((s) => s.id)).toEqual(["l1", "l2"]); // só as que saem de PE
    expect(opp.data.suggestions[0].id).toBe("l1"); // backToBase (BA) primeiro
    expect(opp.severity).toBe("high");
  });

  it("retorna null sem cargas OPEN casando", () => {
    expect(
      detectReturnLoad(bundle, {
        openLoads: [{ id: "x", origem: "Curitiba / PR", destino: "Sao Paulo / SP" }],
      }),
    ).toBeNull();
    expect(detectReturnLoad(bundle, { openLoads: [] })).toBeNull();
  });
});

describe("detectOpportunitiesForDriver", () => {
  it("combina múltiplos gatilhos com preferências por último", () => {
    const bundle = {
      todayIso: TODAY,
      now: NOW,
      lastLoadIso: "2026-05-01",
      totalLoads: 5,
      loads: [
        { origem: "Simoes Filho / BA", destino: "Recife / PE", dateIso: "2026-05-01", perfil: "Carreta" },
        { origem: "Simoes Filho / BA", destino: "Recife / PE", dateIso: "2026-04-01", perfil: "Carreta" },
      ],
      registration: { status: "draft", currentStep: "stepB", createdAt: "2026-07-01T00:00:00.000Z" },
    };
    const context = {
      openLoads: [{ id: "r1", origem: "Recife / PE", destino: "Simoes Filho / BA", dateIso: "2026-07-10" }],
    };
    const opps = detectOpportunitiesForDriver(bundle, context);
    const triggers = opps.map((o) => o.trigger);
    expect(triggers).toContain(OUTREACH_TRIGGERS.CHURN);
    expect(triggers).toContain(OUTREACH_TRIGGERS.LOST_REGISTRATION);
    expect(triggers).toContain(OUTREACH_TRIGGERS.RETURN_LOAD);
    expect(triggers[triggers.length - 1]).toBe(OUTREACH_TRIGGERS.PREFERENCES);
  });

  it("retorna lista vazia quando nada dispara", () => {
    expect(detectOpportunitiesForDriver({ todayIso: TODAY, now: NOW }, {})).toEqual([]);
  });
});
