import { describe, expect, it } from "vitest";
import { parseSchedulePreference, addDaysIso, normalizeText } from "./schedule-nlp.js";

// Hoje fixo para determinismo: 2026-07-09 é uma QUINTA-FEIRA.
const TODAY = "2026-07-09";
const p = (text) => parseSchedulePreference(text, { todayIso: TODAY });

describe("normalizeText", () => {
  it("tira acentos e baixa caixa", () => {
    expect(normalizeText("Amanhã De MANHÃ")).toBe("amanha de manha");
    expect(normalizeText("terça-feira à tarde")).toBe("terca-feira a tarde");
  });
});

describe("parseSchedulePreference — ASAP (urgência)", () => {
  for (const txt of [
    "o quanto antes",
    "o mais rápido possível",
    "pode ser urgente",
    "é pra ontem",
    "preciso agora",
    "assim que possível",
    "o mais breve",
    "asap",
    "o mais rápido que der",
  ]) {
    it(`"${txt}" → asap`, () => {
      const r = p(txt);
      expect(r.kind).toBe("asap");
      expect(r.flexible).toBe(true);
    });
  }
});

describe("parseSchedulePreference — ANY (tanto faz)", () => {
  for (const txt of [
    "tanto faz",
    "qualquer dia",
    "qualquer data",
    "pode ser qualquer um",
    "quando tiver",
    "quando você puder",
    "o que tiver",
    "me manda o que tem",
    "não tenho preferência",
    "você escolhe",
    "qualquer horário serve",
  ]) {
    it(`"${txt}" → any`, () => {
      expect(p(txt).kind).toBe("any");
    });
  }
});

describe("parseSchedulePreference — hoje / amanhã / depois", () => {
  it("hoje", () => {
    expect(p("hoje").dateIso).toBe(TODAY);
    expect(p("hoje mesmo").dateIso).toBe(TODAY);
    expect(p("ainda hoje").dateIso).toBe(TODAY);
    expect(p("hj").dateIso).toBe(TODAY);
  });
  it("amanhã", () => {
    expect(p("amanhã").dateIso).toBe("2026-07-10");
    expect(p("pode ser amanhã").dateIso).toBe("2026-07-10");
    expect(p("amanhã cedo").dateIso).toBe("2026-07-10");
    expect(p("amanhã cedo").period).toBe("manha");
  });
  it("depois de amanhã", () => {
    expect(p("depois de amanhã").dateIso).toBe("2026-07-11");
    expect(p("só depois de amanhã").dateIso).toBe("2026-07-11");
  });
});

describe("parseSchedulePreference — dias da semana", () => {
  // hoje é quinta (2026-07-09)
  it("sexta = amanhã (2026-07-10)", () => {
    expect(p("sexta").dateIso).toBe("2026-07-10");
    expect(p("na sexta").dateIso).toBe("2026-07-10");
    expect(p("sexta-feira").dateIso).toBe("2026-07-10");
  });
  it("segunda = próxima segunda (2026-07-13)", () => {
    expect(p("segunda").dateIso).toBe("2026-07-13");
    expect(p("segunda que vem").dateIso).toBe("2026-07-13");
  });
  it("quinta (hoje) sem 'que vem' = hoje", () => {
    expect(p("quinta").dateIso).toBe(TODAY);
  });
  it("quinta que vem = +7 (2026-07-16)", () => {
    expect(p("quinta que vem").dateIso).toBe("2026-07-16");
    expect(p("quinta proxima").dateIso).toBe("2026-07-16");
  });
  it("sábado / domingo", () => {
    expect(p("sábado").dateIso).toBe("2026-07-11");
    expect(p("domingo").dateIso).toBe("2026-07-12");
  });
});

describe("parseSchedulePreference — datas explícitas", () => {
  it("dd/mm", () => {
    expect(p("22/07").dateIso).toBe("2026-07-22");
    expect(p("dia 22/07").dateIso).toBe("2026-07-22");
  });
  it("dd/mm passado rola pro ano seguinte", () => {
    expect(p("05/01").dateIso).toBe("2027-01-05");
  });
  it("dd/mm/aaaa", () => {
    expect(p("22/07/2026").dateIso).toBe("2026-07-22");
  });
  it("N de mês", () => {
    expect(p("15 de julho").dateIso).toBe("2026-07-15");
    expect(p("dia 20 de agosto").dateIso).toBe("2026-08-20");
  });
  it("dia N (só o dia)", () => {
    expect(p("dia 20").dateIso).toBe("2026-07-20");
    expect(p("dia 5").dateIso).toBe("2026-08-05"); // 5 já passou em julho
  });
});

describe("parseSchedulePreference — intervalos (semana / fds)", () => {
  it("essa semana", () => {
    const r = p("essa semana");
    expect(r.kind).toBe("range");
    expect(r.dateFrom).toBe(TODAY);
    expect(r.dateTo).toBe("2026-07-12"); // domingo
  });
  it("semana que vem", () => {
    const r = p("semana que vem");
    expect(r.kind).toBe("range");
    expect(r.dateFrom).toBe("2026-07-13"); // próxima segunda
    expect(r.dateTo).toBe("2026-07-19");
  });
  it("fim de semana", () => {
    const r = p("fim de semana");
    expect(r.kind).toBe("range");
    expect(r.dateFrom).toBe("2026-07-11"); // sábado
    expect(r.dateTo).toBe("2026-07-12");
  });
});

describe("parseSchedulePreference — períodos", () => {
  it("de manhã", () => expect(p("de manhã").period).toBe("manha"));
  it("de tarde", () => expect(p("de tarde").period).toBe("tarde"));
  it("à noite", () => expect(p("à noite").period).toBe("noite"));
  it("de madrugada", () => expect(p("de madrugada").period).toBe("madrugada"));
  it("cedo = manhã", () => expect(p("bem cedo").period).toBe("manha"));
});

describe("parseSchedulePreference — horários", () => {
  it("8h", () => expect(p("às 8h").timeIso).toBe("08:00"));
  it("14:30", () => expect(p("14:30").timeIso).toBe("14:30"));
  it("8h30", () => expect(p("8h30").timeIso).toBe("08:30"));
  it("2 da tarde = 14:00", () => expect(p("2 da tarde").timeIso).toBe("14:00"));
  it("8 da noite = 20:00", () => expect(p("8 da noite").timeIso).toBe("20:00"));
  it("6 da manhã = 06:00", () => expect(p("6 da manhã").timeIso).toBe("06:00"));
  it("meio dia = 12:00", () => expect(p("meio dia").timeIso).toBe("12:00"));
  it("meia noite = 00:00", () => expect(p("meia noite").timeIso).toBe("00:00"));
  it("14 horas", () => expect(p("14 horas").timeIso).toBe("14:00"));
});

describe("parseSchedulePreference — combinações", () => {
  it("amanhã de manhã", () => {
    const r = p("amanhã de manhã");
    expect(r.dateIso).toBe("2026-07-10");
    expect(r.period).toBe("manha");
  });
  it("dia 20 de tarde", () => {
    const r = p("dia 20 de tarde");
    expect(r.dateIso).toBe("2026-07-20");
    expect(r.period).toBe("tarde");
  });
  it("22/07 às 8h", () => {
    const r = p("22/07 às 8h");
    expect(r.dateIso).toBe("2026-07-22");
    expect(r.timeIso).toBe("08:00");
  });
  it("sexta à tarde", () => {
    const r = p("sexta à tarde");
    expect(r.dateIso).toBe("2026-07-10");
    expect(r.period).toBe("tarde");
  });
});

describe("parseSchedulePreference — só período (sem dia) = period_only flexível", () => {
  it("de manhã sem dia", () => {
    const r = p("pode ser de manhã");
    expect(r.kind).toBe("period_only");
    expect(r.flexible).toBe(true);
    expect(r.period).toBe("manha");
  });
});

describe("parseSchedulePreference — em N dias", () => {
  it("em 3 dias", () => expect(p("em 3 dias").dateIso).toBe(addDaysIso(TODAY, 3)));
  it("daqui a 5 dias", () => expect(p("daqui a 5 dias").dateIso).toBe(addDaysIso(TODAY, 5)));
});

describe("parseSchedulePreference — gírias/abreviações reais (corpus caminhoneiro)", () => {
  it("qquer horario / qlqr = qualquer → any/period", () => {
    expect(["any", "period_only"]).toContain(p("qquer horario").kind);
    expect(p("qlqr dia").kind).toBe("any");
    expect(p("qualqer uma").kind).toBe("any");
  });
  it("oq/o q tiver = o que tiver → any", () => {
    expect(p("o q tiver pra mim ta certo").kind).toBe("any");
    expect(p("me manda oq tiver").kind).toBe("any");
    expect(p("oq aparecer eu pego").kind).toBe("any");
  });
  it("dps de amanha = depois de amanhã", () => {
    expect(p("dps de amanha").dateIso).toBe("2026-07-11");
    expect(p("dps de amanha pela manha").period).toBe("manha");
  });
  it("madruga = madrugada", () => {
    expect(p("amanha na madruga").period).toBe("madrugada");
  });
  it("voce que sabe / pode marcar → any", () => {
    expect(p("voce que sabe patrao").kind).toBe("any");
    expect(p("pode marcar ai").kind).toBe("any");
  });
  it("seg/ter/qua abreviados", () => {
    expect(p("seg que vem").dateIso).toBe("2026-07-13");
    expect(p("na sex cedo").dateIso).toBe("2026-07-10");
  });
});

describe("parseSchedulePreference — desconhecido", () => {
  it("texto sem data → unknown", () => {
    expect(p("blz obrigado").kind).toBe("unknown");
    expect(p("").kind).toBe("unknown");
  });
});
