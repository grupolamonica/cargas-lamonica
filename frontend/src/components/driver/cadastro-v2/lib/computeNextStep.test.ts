import { describe, expect, it } from "vitest";

import type { CandidaturaPendency } from "@/api/candidaturaApi";
import type { StepDTrailerInput } from "../steps/StepDCarretas";

import { describeSkippedStep, nextPendencyStep } from "./computeNextStep";

const pend = (steps: string[]): CandidaturaPendency[] =>
  steps.map((step) => ({
    step,
    reason: "NOT_FOUND",
    label: `${step} pendente`,
  })) as CandidaturaPendency[];

const trailers = (n: number): StepDTrailerInput[] =>
  Array.from({ length: n }, (_, i) => ({ plate: `ABC${i}D23` })) as StepDTrailerInput[];

describe("nextPendencyStep", () => {
  it("tela0 → step-a quando A pendente", () => {
    expect(
      nextPendencyStep({
        currentStep: "tela0",
        pendencias: pend(["A", "B"]),
        ownerIsDriver: false,
        trailersToCollect: trailers(0),
        currentTrailerIdx: 0,
      }),
    ).toBe("step-a");
  });

  it("tela0 → step-b quando A NAO pendente mas B sim", () => {
    expect(
      nextPendencyStep({
        currentStep: "tela0",
        pendencias: pend(["B"]),
        ownerIsDriver: false,
        trailersToCollect: trailers(0),
        currentTrailerIdx: 0,
      }),
    ).toBe("step-b");
  });

  it("tela0 → step-d quando so D pendente", () => {
    expect(
      nextPendencyStep({
        currentStep: "tela0",
        pendencias: pend(["D"]),
        ownerIsDriver: false,
        trailersToCollect: trailers(1),
        currentTrailerIdx: 0,
      }),
    ).toBe("step-d");
  });

  it("tela0 → confirmation quando nenhuma pendencia conhecida", () => {
    expect(
      nextPendencyStep({
        currentStep: "tela0",
        pendencias: [],
        ownerIsDriver: false,
        trailersToCollect: trailers(0),
        currentTrailerIdx: 0,
      }),
    ).toBe("confirmation");
  });

  it("step-a → step-b quando B pendente", () => {
    expect(
      nextPendencyStep({
        currentStep: "step-a",
        pendencias: pend(["A", "B"]),
        ownerIsDriver: false,
        trailersToCollect: trailers(0),
        currentTrailerIdx: 0,
      }),
    ).toBe("step-b");
  });

  it("step-a → step-d (pula B) quando B nao pendente mas D sim", () => {
    expect(
      nextPendencyStep({
        currentStep: "step-a",
        pendencias: pend(["A"]),
        ownerIsDriver: false,
        trailersToCollect: trailers(1),
        currentTrailerIdx: 0,
      }),
    ).toBe("step-d");
  });

  it("step-a → confirmation quando so A pendente e sem carretas", () => {
    expect(
      nextPendencyStep({
        currentStep: "step-a",
        pendencias: pend(["A"]),
        ownerIsDriver: false,
        trailersToCollect: trailers(0),
        currentTrailerIdx: 0,
      }),
    ).toBe("confirmation");
  });

  it("step-b → step-d (pula C) quando ownerIsDriver + carretas pendentes", () => {
    expect(
      nextPendencyStep({
        currentStep: "step-b",
        pendencias: pend(["B"]),
        ownerIsDriver: true,
        trailersToCollect: trailers(2),
        currentTrailerIdx: 0,
      }),
    ).toBe("step-d");
  });

  it("step-b → confirmation quando ownerIsDriver + sem carretas", () => {
    expect(
      nextPendencyStep({
        currentStep: "step-b",
        pendencias: pend(["B"]),
        ownerIsDriver: true,
        trailersToCollect: trailers(0),
        currentTrailerIdx: 0,
      }),
    ).toBe("confirmation");
  });

  it("step-b → step-c quando owner != driver", () => {
    expect(
      nextPendencyStep({
        currentStep: "step-b",
        pendencias: pend(["B"]),
        ownerIsDriver: false,
        trailersToCollect: trailers(0),
        currentTrailerIdx: 0,
      }),
    ).toBe("step-c");
  });

  it("step-c → step-d quando D pendente", () => {
    expect(
      nextPendencyStep({
        currentStep: "step-c",
        pendencias: pend(["C", "D"]),
        ownerIsDriver: false,
        trailersToCollect: trailers(1),
        currentTrailerIdx: 0,
      }),
    ).toBe("step-d");
  });

  it("step-c → confirmation quando sem carretas", () => {
    expect(
      nextPendencyStep({
        currentStep: "step-c",
        pendencias: pend(["C"]),
        ownerIsDriver: false,
        trailersToCollect: trailers(0),
        currentTrailerIdx: 0,
      }),
    ).toBe("confirmation");
  });

  it("step-d → step-d quando idx < total-1 (proxima carreta)", () => {
    expect(
      nextPendencyStep({
        currentStep: "step-d",
        pendencias: pend(["D"]),
        ownerIsDriver: false,
        trailersToCollect: trailers(2),
        currentTrailerIdx: 0,
      }),
    ).toBe("step-d");
  });

  it("step-d → confirmation quando idx == total-1 (ultima carreta)", () => {
    expect(
      nextPendencyStep({
        currentStep: "step-d",
        pendencias: pend(["D"]),
        ownerIsDriver: false,
        trailersToCollect: trailers(2),
        currentTrailerIdx: 1,
      }),
    ).toBe("confirmation");
  });

  it("step-e → step-d quando idx < total-1", () => {
    expect(
      nextPendencyStep({
        currentStep: "step-e",
        pendencias: pend(["D"]),
        ownerIsDriver: false,
        trailersToCollect: trailers(2),
        currentTrailerIdx: 0,
      }),
    ).toBe("step-d");
  });

  it("step-e → confirmation quando ultima carreta", () => {
    expect(
      nextPendencyStep({
        currentStep: "step-e",
        pendencias: pend(["D"]),
        ownerIsDriver: false,
        trailersToCollect: trailers(1),
        currentTrailerIdx: 0,
      }),
    ).toBe("confirmation");
  });
});

describe("describeSkippedStep", () => {
  it("step-a → step-d retorna copy 'cavalo em dia'", () => {
    expect(describeSkippedStep("step-a", "step-d")).toMatch(/cavalo já está em dia/i);
  });

  it("step-a → confirmation retorna copy 'so faltava voce'", () => {
    expect(describeSkippedStep("step-a", "confirmation")).toMatch(/só faltava você/i);
  });

  it("step-c → confirmation retorna copy 'carretas em dia'", () => {
    expect(describeSkippedStep("step-c", "confirmation")).toMatch(/carretas estão em dia/i);
  });

  it("step-b → step-d retorna null (skip C tem banner proprio)", () => {
    expect(describeSkippedStep("step-b", "step-d")).toBeNull();
  });

  it("step-c → step-d retorna null (sequencial natural)", () => {
    expect(describeSkippedStep("step-c", "step-d")).toBeNull();
  });
});
