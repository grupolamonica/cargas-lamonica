import { describe, expect, it } from "vitest";

import {
  MONITOR_DEFAULT_WINDOW_DAYS,
  createHiddenFutureTally,
  defaultLoadWindow,
  isFutureLoadDate,
  monitorLocalDateKey,
  resolveLoadWindow,
  revealFutureWindow,
  tallyHiddenFuture,
} from "./monitorDateWindow";

// Datas construídas com o construtor LOCAL (mesmo fuso do operador), porque é
// esse o fuso em que o <input datetime-local> vive.
const at = (y: number, m: number, d: number, h = 9) => new Date(y, m - 1, d, h);

describe("defaultLoadWindow", () => {
  it("hoje 00:00 → hoje+7 23:59", () => {
    expect(defaultLoadWindow(at(2026, 8, 6))).toEqual({ from: "2026-08-06T00:00", to: "2026-08-13T23:59" });
  });

  it("o padrão são 7 dias (cobre as cargas abertas de 07/08 a 10/08 medidas em produção)", () => {
    expect(MONITOR_DEFAULT_WINDOW_DAYS).toBe(7);
    const { from, to } = defaultLoadWindow(at(2026, 8, 6));
    // `to` fecha às 23:59 do último dia → a diferença é de N dias + 23h59.
    const dias = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
    expect(Math.floor(dias)).toBe(MONITOR_DEFAULT_WINDOW_DAYS);
  });

  it("vira o MÊS sem estourar o dia", () => {
    expect(defaultLoadWindow(at(2026, 8, 30)).to).toBe("2026-09-06T23:59");
    // fevereiro curto (2026 não é bissexto)
    expect(defaultLoadWindow(at(2026, 2, 25)).to).toBe("2026-03-04T23:59");
    // fevereiro bissexto
    expect(defaultLoadWindow(at(2028, 2, 25)).to).toBe("2028-03-03T23:59");
  });

  it("vira o ANO", () => {
    expect(defaultLoadWindow(at(2026, 12, 29))).toEqual({ from: "2026-12-29T00:00", to: "2027-01-05T23:59" });
  });

  it("o horário do relógio não vaza para a janela (o input nasce em 00:00/23:59)", () => {
    expect(defaultLoadWindow(at(2026, 8, 6, 23))).toEqual(defaultLoadWindow(at(2026, 8, 6, 0)));
  });

  it("a virada de horário de verão não desloca o dia final (só lemos ano/mês/dia)", () => {
    // 18/10/2026: domingo de virada de DST no hemisfério norte/histórico BR.
    expect(defaultLoadWindow(at(2026, 10, 15)).to).toBe("2026-10-22T23:59");
  });
});

describe("monitorLocalDateKey", () => {
  it("zero-pad de mês e dia", () => {
    expect(monitorLocalDateKey(at(2026, 1, 3))).toBe("2026-01-03");
    expect(monitorLocalDateKey(at(2026, 11, 30))).toBe("2026-11-30");
  });
});

describe("resolveLoadWindow", () => {
  const hoje = at(2026, 8, 6);

  it("sem nada persistido → janela operacional em modo auto", () => {
    expect(resolveLoadWindow(null, hoje)).toEqual({ from: "2026-08-06T00:00", to: "2026-08-13T23:59", mode: "auto" });
    expect(resolveLoadWindow({}, hoje)).toEqual({ from: "2026-08-06T00:00", to: "2026-08-13T23:59", mode: "auto" });
  });

  it("janela AUTO de ONTEM é recalculada — o dia morto não sobrevive ao F5", () => {
    const ontem = { dateWindowMode: "auto", dateFromFilter: "2026-08-05T00:00", dateToFilter: "2026-08-12T23:59" };
    expect(resolveLoadWindow(ontem, hoje)).toEqual({ from: "2026-08-06T00:00", to: "2026-08-13T23:59", mode: "auto" });
  });

  it("payload legado (v1, sem discriminador) é tratado como auto → recalculado", () => {
    const v1 = { dateFromFilter: "2026-07-14T00:00", dateToFilter: "2026-07-14T23:59" };
    expect(resolveLoadWindow(v1, hoje)).toEqual({ from: "2026-08-06T00:00", to: "2026-08-13T23:59", mode: "auto" });
  });

  it("janela MANUAL sobrevive ao F5 exatamente como o operador deixou", () => {
    const manual = { dateWindowMode: "manual", dateFromFilter: "2026-09-01T08:00", dateToFilter: "2026-09-02T18:30" };
    expect(resolveLoadWindow(manual, hoje)).toEqual({ from: "2026-09-01T08:00", to: "2026-09-02T18:30", mode: "manual" });
  });

  it("manual com datas VAZIAS é recorte legítimo (sem limite) — não vira o padrão", () => {
    const semLimite = { dateWindowMode: "manual", dateFromFilter: "", dateToFilter: "" };
    expect(resolveLoadWindow(semLimite, hoje)).toEqual({ from: "", to: "", mode: "manual" });
  });

  it("valores de tipo errado no localStorage não derrubam a tela", () => {
    const lixo = { dateWindowMode: "manual", dateFromFilter: 42, dateToFilter: null };
    expect(resolveLoadWindow(lixo, hoje)).toEqual({ from: "", to: "", mode: "manual" });
    expect(resolveLoadWindow({ dateWindowMode: 7 }, hoje).mode).toBe("auto");
  });
});

describe("isFutureLoadDate", () => {
  const hoje = "2026-08-06";

  it("hoje conta como futura — carga de hoje com horário vencido ainda é acionável", () => {
    expect(isFutureLoadDate("2026-08-06", hoje)).toBe(true);
  });

  it("ontem e antes é histórico", () => {
    expect(isFutureLoadDate("2026-08-05", hoje)).toBe(false);
    expect(isFutureLoadDate("2025-12-31", hoje)).toBe(false);
  });

  it("aceita timestamp completo (só a parte da data importa)", () => {
    expect(isFutureLoadDate("2026-08-10T22:00:00", hoje)).toBe(true);
    expect(isFutureLoadDate("2026-08-01T22:00:00", hoje)).toBe(false);
  });

  it("sem data = desconhecida, NÃO conta (número inflado por palpite vira ruído)", () => {
    expect(isFutureLoadDate(null, hoje)).toBe(false);
    expect(isFutureLoadDate(undefined, hoje)).toBe(false);
    expect(isFutureLoadDate("", hoje)).toBe(false);
    expect(isFutureLoadDate("2026-08", hoje)).toBe(false);
  });
});

describe("tallyHiddenFuture", () => {
  const hoje = "2026-08-06";

  it("ignora o histórico e devolve a última futura", () => {
    // Recorte fiel ao medido: um punhado de futuras afogado em histórico.
    const escondidas = [
      "2026-07-01", "2026-07-02", "2026-08-05", // histórico
      "2026-08-07", "2026-08-07", "2026-08-08", "2026-08-10", // futuras
      null, "", // sem data
    ];
    expect(tallyHiddenFuture(escondidas, hoje)).toEqual({ count: 4, maxDate: "2026-08-10" });
  });

  it("só histórico → contador zerado (é o caso que faria o operador ignorar o número)", () => {
    expect(tallyHiddenFuture(["2026-01-01", "2026-08-05", null], hoje)).toEqual({ count: 0, maxDate: null });
  });

  it("nada escondido → zero", () => {
    expect(tallyHiddenFuture([], hoje)).toEqual({ count: 0, maxDate: null });
  });

  it("maxDate não regride quando as datas chegam fora de ordem", () => {
    const t = createHiddenFutureTally(hoje);
    t.add("2026-08-10");
    t.add("2026-08-07");
    expect(t.result()).toEqual({ count: 2, maxDate: "2026-08-10" });
  });
});

describe("revealFutureWindow", () => {
  it("estica de hoje até a última futura escondida", () => {
    expect(revealFutureWindow("2026-08-06", "2026-08-10")).toEqual({ from: "2026-08-06T00:00", to: "2026-08-10T23:59" });
  });

  it("sem futuras (ou só de hoje) → janela de um dia, nunca invertida", () => {
    expect(revealFutureWindow("2026-08-06", null)).toEqual({ from: "2026-08-06T00:00", to: "2026-08-06T23:59" });
    expect(revealFutureWindow("2026-08-06", "2026-08-06")).toEqual({ from: "2026-08-06T00:00", to: "2026-08-06T23:59" });
    // maxDate no passado é impossível pela contagem, mas não pode gerar to < from.
    expect(revealFutureWindow("2026-08-06", "2026-01-01")).toEqual({ from: "2026-08-06T00:00", to: "2026-08-06T23:59" });
  });

  // O contador promete "+N futuras fora do filtro" e o operador clica esperando
  // GANHAR N linhas. Antes desta união, um recorte manual à frente (10/08..12/08)
  // virava hoje..maxDate e o operador PERDIA as linhas que estava olhando — o
  // botão prometia somar e subtraía.
  it("UNE com a janela atual — o clique nunca encolhe nenhuma das duas pontas", () => {
    // Recorte manual à FRENTE: mantém o fim dele e só estica o início para trás.
    expect(revealFutureWindow("2026-08-06", "2026-08-08", { from: "2026-08-10T00:00", to: "2026-08-12T23:59" }))
      .toEqual({ from: "2026-08-06T00:00", to: "2026-08-12T23:59" });

    // Recorte manual ATRÁS (histórico): mantém o início dele e estica o fim.
    expect(revealFutureWindow("2026-08-06", "2026-08-10", { from: "2026-07-01T00:00", to: "2026-08-07T23:59" }))
      .toEqual({ from: "2026-07-01T00:00", to: "2026-08-10T23:59" });

    // Recorte que já contém o alvo inteiro: nada muda.
    expect(revealFutureWindow("2026-08-06", "2026-08-10", { from: "2026-01-01T00:00", to: "2026-12-31T23:59" }))
      .toEqual({ from: "2026-01-01T00:00", to: "2026-12-31T23:59" });

    // Sobreposto parcialmente: pega a ponta mais larga de cada lado.
    expect(revealFutureWindow("2026-08-06", "2026-08-10", { from: "2026-08-08T00:00", to: "2026-08-09T23:59" }))
      .toEqual({ from: "2026-08-06T00:00", to: "2026-08-10T23:59" });
  });

  it("ponta VAZIA é 'sem limite' — esticá-la seria encolher, então permanece vazia", () => {
    expect(revealFutureWindow("2026-08-06", "2026-08-10", { from: "", to: "" }))
      .toEqual({ from: "", to: "" });
    expect(revealFutureWindow("2026-08-06", "2026-08-10", { from: "", to: "2026-08-07T23:59" }))
      .toEqual({ from: "", to: "2026-08-10T23:59" });
  });

  it("sem janela atual (undefined/null) se comporta como antes", () => {
    expect(revealFutureWindow("2026-08-06", "2026-08-10", null))
      .toEqual({ from: "2026-08-06T00:00", to: "2026-08-10T23:59" });
    expect(revealFutureWindow("2026-08-06", "2026-08-10"))
      .toEqual({ from: "2026-08-06T00:00", to: "2026-08-10T23:59" });
  });

  it("nunca inclui histórico: o 'from' é sempre hoje", () => {
    expect(revealFutureWindow("2026-08-06", "2026-12-31").from).toBe("2026-08-06T00:00");
  });
});
