import { describe, expect, it } from "vitest";
import {
  CHECKLIST_LEVEL,
  normalizePlate,
  computeChecklistLevel,
  aggregateLevel,
} from "./status.js";

const NOW = Date.UTC(2026, 4, 1, 12, 0, 0); // 2026-05-01 12:00 UTC
const DAY = 86_400_000;

describe("normalizePlate", () => {
  it("remove hífen/espaço e sobe para maiúsculo", () => {
    expect(normalizePlate("MTY-0443")).toBe("MTY0443");
    expect(normalizePlate(" ouo3a58 ")).toBe("OUO3A58");
    expect(normalizePlate(null)).toBe("");
  });
});

describe("computeChecklistLevel", () => {
  it("vermelho (overdue) quando a validade já passou", () => {
    const r = computeChecklistLevel({ validadeMs: NOW - 45 * DAY, statusRaw: "Aprovado", nowMs: NOW });
    expect(r.level).toBe(CHECKLIST_LEVEL.OVERDUE);
    expect(r.daysToDue).toBe(-45);
  });

  it("amarelo (warning) dentro da janela de 30 dias", () => {
    const r = computeChecklistLevel({ validadeMs: NOW + 10 * DAY, statusRaw: "Aprovado", nowMs: NOW, yellowDays: 30 });
    expect(r.level).toBe(CHECKLIST_LEVEL.WARNING);
    expect(r.daysToDue).toBe(10);
  });

  it("verde (ok) além da janela amarela", () => {
    const r = computeChecklistLevel({ validadeMs: NOW + 60 * DAY, statusRaw: "Aprovado", nowMs: NOW, yellowDays: 30 });
    expect(r.level).toBe(CHECKLIST_LEVEL.OK);
    expect(r.daysToDue).toBe(60);
  });

  it("threshold configurável muda a fronteira do amarelo", () => {
    expect(computeChecklistLevel({ validadeMs: NOW + 10 * DAY, statusRaw: "Aprovado", nowMs: NOW, yellowDays: 7 }).level).toBe(CHECKLIST_LEVEL.OK);
    expect(computeChecklistLevel({ validadeMs: NOW + 10 * DAY, statusRaw: "Aprovado", nowMs: NOW, yellowDays: 15 }).level).toBe(CHECKLIST_LEVEL.WARNING);
  });

  it("Status 'Reprovado' força vermelho mesmo com validade longe", () => {
    const r = computeChecklistLevel({ validadeMs: NOW + 90 * DAY, statusRaw: "Reprovado", nowMs: NOW });
    expect(r.level).toBe(CHECKLIST_LEVEL.OVERDUE);
  });

  it("Status 'Vencido' força vermelho", () => {
    expect(computeChecklistLevel({ validadeMs: NOW + 90 * DAY, statusRaw: "Vencido", nowMs: NOW }).level).toBe(CHECKLIST_LEVEL.OVERDUE);
  });

  it("sem validade: aprovado→verde, reprovado→vermelho, outro→desconhecido", () => {
    expect(computeChecklistLevel({ validadeMs: null, statusRaw: "Aprovado", nowMs: NOW }).level).toBe(CHECKLIST_LEVEL.OK);
    expect(computeChecklistLevel({ validadeMs: null, statusRaw: "Reprovado", nowMs: NOW }).level).toBe(CHECKLIST_LEVEL.OVERDUE);
    expect(computeChecklistLevel({ validadeMs: null, statusRaw: "", nowMs: NOW }).level).toBe(CHECKLIST_LEVEL.UNKNOWN);
  });

  it("usa o Vencimento do robô como dias restantes (positivo → amarelo/verde)", () => {
    expect(computeChecklistLevel({ vencimentoDias: 16, statusRaw: "Aprovado", nowMs: NOW, yellowDays: 30 })).toEqual({ level: CHECKLIST_LEVEL.WARNING, daysToDue: 16 });
    expect(computeChecklistLevel({ vencimentoDias: 35, statusRaw: "Aprovado", nowMs: NOW, yellowDays: 30 })).toEqual({ level: CHECKLIST_LEVEL.OK, daysToDue: 35 });
    expect(computeChecklistLevel({ vencimentoDias: -5, statusRaw: "Aprovado", nowMs: NOW })).toEqual({ level: CHECKLIST_LEVEL.OVERDUE, daysToDue: -5 });
  });

  it("REGRESSÃO: Vencimento manda mesmo quando a data 'Validade' já passou", () => {
    // Bug: 431 aprovados apareciam VERMELHO porque a data "Data Validade
    // Checklist" está no passado, mas o Vencimento do robô é positivo.
    const r = computeChecklistLevel({
      vencimentoDias: 16,
      validadeMs: NOW - 66 * DAY, // data enganosa (passada)
      statusRaw: "Aprovado",
      nowMs: NOW,
      yellowDays: 30,
    });
    expect(r).toEqual({ level: CHECKLIST_LEVEL.WARNING, daysToDue: 16 });
  });
});

describe("aggregateLevel", () => {
  it("pega o pior nível da lista", () => {
    expect(aggregateLevel(["ok", "warning"])).toBe(CHECKLIST_LEVEL.WARNING);
    expect(aggregateLevel(["ok", "overdue", "warning"])).toBe(CHECKLIST_LEVEL.OVERDUE);
    expect(aggregateLevel(["unknown", "ok"])).toBe(CHECKLIST_LEVEL.OK);
    expect(aggregateLevel([])).toBe(CHECKLIST_LEVEL.UNKNOWN);
  });
});
