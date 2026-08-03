import {
  buildEstimatedDurationLabel,
  buildLoadingDateTime,
  buildOperationalDateLabel,
  buildRouteEstimatedDurationLabel,
  calculateEstimatedTimeInMinutes,
  formatEstimatedTime,
  isHumanScheduleLabel,
} from "@/lib/estimatedTime";

describe("estimatedTime", () => {
  it("calculates unloading minus loading plus two hours", () => {
    expect(
      calculateEstimatedTimeInMinutes("07/04/2026 11:00", "10/04/2026 10:00"),
    ).toBe(4140);
  });

  it("formats long spans using day and hour tokens", () => {
    expect(formatEstimatedTime("07/04/2026 11:00", "10/04/2026 10:00")).toBe("2d 21h");
  });

  it("builds the driver duration label from unloading minus loading plus two hours", () => {
    expect(
      buildEstimatedDurationLabel({
        loadingLabel: "07/04/2026 11:00",
        unloadingLabel: "10/04/2026 10:00",
      }),
    ).toBe("Tempo estimado: 2d 21h");
  });

  it("falls back to the direct loading-to-unloading interval when the two-hour offset would zero the window", () => {
    expect(formatEstimatedTime("07/04/2026 11:00", "07/04/2026 12:00")).toBe("1h");
  });

  it("falls back to carga data and horario when the sheet loading label is missing", () => {
    expect(buildOperationalDateLabel(null, "2026-04-07", "11:00:00")).toBe("07/04/2026 11:00");
    expect(buildLoadingDateTime(null, "2026-04-07", "11:00:00")).toBeInstanceOf(Date);
  });

  it('mantém o rótulo humano "A confirmar" em vez do placeholder de data/horário', () => {
    // Carga lançada sem agenda: sheet_data_carregamento = "A confirmar" e data/horario são
    // placeholder (dia do lançamento às 00:00). O motorista não pode ver "hoje às 00:00".
    expect(buildOperationalDateLabel("A confirmar", "2026-08-03", "00:00:00")).toBe("A confirmar");
    expect(isHumanScheduleLabel("A confirmar")).toBe(true);
    expect(isHumanScheduleLabel("07/04/2026 11:00")).toBe(false);
    expect(isHumanScheduleLabel("2026-08-06T10:00")).toBe(false);
    expect(isHumanScheduleLabel(null)).toBe(false);
    expect(isHumanScheduleLabel("   ")).toBe(false);
  });

  it("uses the load date even when the api sends it as an ISO timestamp", () => {
    expect(buildOperationalDateLabel(null, "2026-04-09T03:00:00.000Z", "21:31:00")).toBe("09/04/2026 21:31");
    expect(buildLoadingDateTime(null, "2026-04-09T03:00:00.000Z", "21:31:00")).toBeInstanceOf(Date);
  });

  it("returns a placeholder when dates are invalid", () => {
    expect(formatEstimatedTime("invalido", null)).toBe("A confirmar");
  });

  it("falls back to route duration when the sheet dates are unavailable", () => {
    expect(
      buildEstimatedDurationLabel({
        loadingLabel: null,
        unloadingLabel: null,
        fallbackDurationHours: 18.5,
      }),
    ).toBe("Tempo estimado: ~18h 30min");
  });

  it("prioritizes the explicit route eta when it exists", () => {
    expect(
      buildRouteEstimatedDurationLabel({
        routeEstimatedHours: 16,
        fallbackDurationHours: 18.5,
      }),
    ).toBe("Tempo estimado: 16h");
  });

  it("converts decimal route hours into minutes for the driver label", () => {
    expect(
      buildRouteEstimatedDurationLabel({
        routeEstimatedHours: 1.2,
      }),
    ).toBe("Tempo estimado: 1h 12min");
  });

  it("keeps zero minutes only when the unloading time is not after loading", () => {
    expect(formatEstimatedTime("07/04/2026 11:00", "07/04/2026 11:00")).toBe("0min");
  });
});
