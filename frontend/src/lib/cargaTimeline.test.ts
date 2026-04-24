import { describe, expect, it } from "vitest";

import { upsertCargoBySchedule } from "./cargaTimeline";

describe("upsertCargoBySchedule", () => {
  it("insere uma nova carga mantendo a linha do tempo ordenada", () => {
    const result = upsertCargoBySchedule(
      [
        { id: "1", data: "2026-04-03", horario: "09:00" },
        { id: "3", data: "2026-04-03", horario: "15:00" },
      ],
      { id: "2", data: "2026-04-03", horario: "12:00" },
    );

    expect(result.map((item) => item.id)).toEqual(["1", "2", "3"]);
  });

  it("reposiciona a carga existente quando a agenda muda", () => {
    const result = upsertCargoBySchedule(
      [
        { id: "1", data: "2026-04-03", horario: "09:00" },
        { id: "2", data: "2026-04-03", horario: "12:00" },
        { id: "3", data: "2026-04-03", horario: "15:00" },
      ],
      { id: "2", data: "2026-04-03", horario: "18:00" },
    );

    expect(result.map((item) => item.id)).toEqual(["1", "3", "2"]);
  });
});
