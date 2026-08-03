/**
 * PROVA 1 de 2 da agregação server-side do Painel (/painel).
 *
 * O Painel deixou de baixar 3x select(500) (~1500 linhas / ~0,5 MB por aba) e
 * passou a consumir um endpoint agregado. Este arquivo prova que a MONTAGEM
 * server-side (backend/.../overview-snapshot-metrics.js) devolve exatamente o
 * mesmo snapshot que `buildOverviewSnapshot` (o caminho antigo, no navegador),
 * sobre a MESMA fixture.
 *
 * A prova 2 (`backend/.../overview-snapshot-read-model.test.js`) mostra que o SQL
 * produz os mesmos agregados que o oráculo usado aqui. Front == oráculo == SQL.
 * (As duas metades não podem morar no mesmo runner: aqui é jsdom com alias `@/`,
 * lá é pg-mem, devDependency do backend.)
 *
 * ⚠ FUSO — o motivo de este arquivo existir. `buildLoadingDateTime` usa `parseISO`
 * sem offset, então no navegador a carga é lida no fuso LOCAL (BRT, o operador
 * está no Brasil) enquanto o container do backend roda em UTC. O TZ do processo é
 * fixado em America/Sao_Paulo para que o lado "navegador" da comparação
 * represente produção; o lado servidor é provado INVARIANTE a TZ mais abaixo.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// `vi.hoisted` roda ANTES dos imports — o TZ tem de estar de pé antes de
// qualquer módulo tocar em Date. O valor original é devolvido no afterAll porque
// o vitest REUTILIZA workers entre arquivos: deixar o TZ trocado vazaria para o
// próximo arquivo de teste do mesmo worker.
const { ORIGINAL_TZ } = vi.hoisted(() => {
  const original = process.env.TZ;
  process.env.TZ = "America/Sao_Paulo";
  return { ORIGINAL_TZ: original };
});

import { buildLoadingDateTime } from "@/lib/estimatedTime";
import { buildOverviewSnapshot, type OverviewCargoRow, type OverviewClaimRow, type OverviewLeadRow } from "@/lib/overviewMetrics";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- módulo JS do backend (fora do rootDir do tsconfig do frontend)
import {
  buildOverviewSnapshotFromAggregates,
  resolveLoadingWallClock,
} from "../../../backend/src/application/operator-admin/use-cases/overview-snapshot-metrics.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {
  OVERVIEW_PARITY_CARGOS,
  OVERVIEW_PARITY_CLAIMS,
  OVERVIEW_PARITY_LEADS,
  OVERVIEW_PARITY_NOW,
  aggregateOverviewRowsAsSql,
} from "../../../backend/src/application/operator-admin/use-cases/overview-snapshot-parity-oracle.js";

const NOW = new Date(OVERVIEW_PARITY_NOW);

const cargos = OVERVIEW_PARITY_CARGOS as unknown as OverviewCargoRow[];
const leads = OVERVIEW_PARITY_LEADS as unknown as OverviewLeadRow[];
const claims = OVERVIEW_PARITY_CLAIMS as unknown as OverviewClaimRow[];

function clientSnapshot(now = NOW) {
  // `recentActivity` fica fora da comparação: o feed exigiria as 3 tabelas
  // inteiras de volta (é justamente o que se eliminou) e NENHUM componente do
  // Painel o renderiza — `Overview.tsx` só lê `hero`, `attentionLoads` e
  // `lastUpdatedAt`. O builder do cliente continua produzindo o feed e seus
  // próprios testes continuam cobrindo-o.
  const { recentActivity: _recentActivity, ...rest } = buildOverviewSnapshot(cargos, leads, claims, now);
  return rest;
}

function serverSnapshot(now = NOW) {
  return buildOverviewSnapshotFromAggregates(
    aggregateOverviewRowsAsSql(cargos, leads, claims, { now }),
    now,
  );
}

describe("Painel — paridade front x agregação server-side", () => {
  beforeAll(() => {
    // Se o runtime ignorasse a troca de TZ, o lado "navegador" da comparação
    // deixaria de representar produção e a prova viraria vácuo. Falha alto.
    expect(new Date().getTimezoneOffset()).toBe(180);
  });

  afterAll(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  it("produz o MESMO snapshot que buildOverviewSnapshot sobre a mesma fixture", () => {
    expect(serverSnapshot()).toEqual(clientSnapshot());
  });

  it("ancora os números que dependem de fuso (o que a porta ingênua erraria)", () => {
    const snapshot = serverSnapshot();

    // Janela BRT de "agora" = 2026-07-31 23:00 até 2026-08-01 23:00.
    // Entram: 00:30, 01:30, 21:30, rótulo "01/08/2026 22:30", rótulo inválido
    // caindo em 12:00 e rótulo com Z (05:30Z = 02:30 BRT). Fica FORA o rótulo
    // "2026-08-01T23:30" (23:30 BRT > horizonte). Uma porta que lesse tudo como
    // UTC daria 5 saídas e 7 atrasadas — números diferentes, mesma fixture.
    expect(snapshot.hero.departuresNext24h).toBe(6);
    expect(snapshot.hero.overdueLoads).toBe(5);

    // "Hoje" = 31/07 em São Paulo. Conta o lead da borda exata (03:00Z = 00:00
    // BRT) e NÃO conta o de 04:00Z (já é 01/08 em BRT) nem o de 02:59:59.999Z.
    // Com o dia em UTC daria 1.
    expect(snapshot.hero.approvedToday).toBe(2);

    // load_claims segue na conta: o timestamp mais recente da fixture é o
    // confirmed_at de uma disputa. Dropar a tabela regrediria este valor — e o
    // regresso está medido logo abaixo, não só afirmado.
    expect(snapshot.lastUpdatedAt).toBe("2026-08-01T05:00:00.000Z");
    const semClaims = buildOverviewSnapshotFromAggregates(
      aggregateOverviewRowsAsSql(cargos, leads, [], { now: NOW }),
      NOW,
    );
    expect(semClaims.lastUpdatedAt).toBe("2026-08-01T04:00:00.000Z");
    // ... e o interesse por carga também cai (a disputa WAITLISTED de c-open-far).
    expect(semClaims.hero.noDriverLoads).toBe(snapshot.hero.noDriverLoads + 1);

    // Resto do hero (independente de fuso), para o teste de igualdade acima não
    // poder passar por dois lados vazios.
    expect(snapshot.hero).toMatchObject({
      activeLoads: 15,
      queuedLeads: 1,
      noDriverLoads: 11,
      activeClaims: 4,
      draftCount: 1,
      bookedCount: 2,
      reservedCount: 1,
      pendingApprovals: 1,
    });

    // Fila de atenção: ordem por idade decrescente com empate (72h x 72h)
    // resolvido pela ordem da consulta (created_at DESC) — `sort` estável.
    expect(snapshot.attentionLoads.map((item: { id: string }) => item.id)).toEqual([
      "c-open-antiga",
      "c-open-empate-a",
      "c-open-empate-b",
      "c-open-incompleta",
    ]);
    expect(snapshot.attentionLoads.map((item: { ageHours: number }) => item.ageHours)).toEqual([98, 72, 72, 16]);
    expect(snapshot.attentionLoads.at(-1)?.missingFields).toEqual(["perfil", "distancia_km"]);
  });

  // Prova no nível do PARSER, não só do agregado: `buildLoadingDateTime` é a
  // função exata que a porta teria copiado errado. Com o TZ do processo em BRT, o
  // relógio de parede LOCAL do Date que ela devolve é o mesmo relógio que o
  // navegador do operador usa — e é o que a porta tem de reproduzir.
  it.each([
    ["2026-08-01T05:30:00Z", null, null],
    ["2026-08-01T05:30:00-03:00", null, null],
    ["2026-08-01T05:30:00+02:00", null, null],
    ["2026-08-01T05:30-03", null, null],
    ["01/08/2026 22:30", null, null],
    ["2026-08-01 08:00", null, null],
    ["2026-08-01T23:30", null, null],
    ["2026-08-01", null, null],
    ["A confirmar", "2026-08-01", "12:00:00"],
    ["", "2026-08-01", "08:00:00"],
    ["   ", "2026-08-01", "08:00:00"],
    [null, "2026-08-01", "00:30:00"],
    [null, "2026-08-01", "21:30:00"],
    [null, "2026-08-01", "23:59:59"],
    [null, "2026-08-01", "2026-08-01T02:00"],
    [null, "2026-08-01", null],
    [null, null, "08:00:00"],
    [null, null, null],
  ])("parser: rótulo=%o data=%o horario=%o casa com buildLoadingDateTime", (label, data, horario) => {
    const fromClient = buildLoadingDateTime(label, data, horario);
    const pad = (value: number, size = 2) => String(value).padStart(size, "0");
    const expected = fromClient
      ? `${fromClient.getFullYear()}-${pad(fromClient.getMonth() + 1)}-${pad(fromClient.getDate())}` +
        `T${pad(fromClient.getHours())}:${pad(fromClient.getMinutes())}:${pad(fromClient.getSeconds())}` +
        `.${pad(fromClient.getMilliseconds(), 3)}`
      : null;

    expect(
      resolveLoadingWallClock({ carregamentoLabel: label, dataIso: data, horario }, NOW),
    ).toBe(expected);
  });

  it("o lado servidor é INVARIANTE ao fuso do processo — e a fixture prova que o do navegador não é", () => {
    const inSaoPaulo = { client: clientSnapshot(), server: serverSnapshot() };

    process.env.TZ = "UTC";
    expect(new Date().getTimezoneOffset()).toBe(0);
    const inUtc = { client: clientSnapshot(), server: serverSnapshot() };
    process.env.TZ = "America/Sao_Paulo";
    expect(new Date().getTimezoneOffset()).toBe(180);

    // O que se estava tentando evitar: a agregação NÃO pode mudar por o
    // container rodar em UTC.
    expect(inUtc.server).toEqual(inSaoPaulo.server);

    // E a fixture é discriminante de verdade: o builder do navegador, o mesmo
    // código que a porta copiaria, muda de resposta com o fuso do processo.
    // (Isto é o "silent 3-hour shift" tornado visível.)
    expect(inUtc.client.hero.departuresNext24h).not.toBe(inSaoPaulo.client.hero.departuresNext24h);
    expect(inUtc.client.hero.overdueLoads).not.toBe(inSaoPaulo.client.hero.overdueLoads);
    expect(inUtc.client.hero.approvedToday).not.toBe(inSaoPaulo.client.hero.approvedToday);
  });
});
