import { describe, expect, it, vi, beforeEach } from "vitest";

import { buildDriverAlternativeDateRange, fetchDriverLoadAlternatives } from "@/lib/driverLoadAlternatives";

const { mockFetchDriverLoads } = vi.hoisted(() => ({
  mockFetchDriverLoads: vi.fn(),
}));

vi.mock("@/services/readModels", () => ({
  fetchDriverLoads: mockFetchDriverLoads,
}));

describe("driverLoadAlternatives", () => {
  beforeEach(() => {
    mockFetchDriverLoads.mockReset();
  });

  it("builds a full-day range for the disputed load date", () => {
    expect(buildDriverAlternativeDateRange("2026-04-09T14:30:00.000Z")).toEqual({
      dateFrom: "2026-04-09T03:00:00.000Z",
      dateTo: "2026-04-10T02:59:59.999Z",
    });
  });

  it("prefers loads from the same origin and same eta window", async () => {
    mockFetchDriverLoads.mockResolvedValueOnce({
      items: [
        {
          id: "load-1",
        },
        {
          id: "load-2",
          origem: "Feira de Santana / BA",
        },
      ],
    });

    const response = await fetchDriverLoadAlternatives({
      loadId: "load-1",
      origem: "Feira de Santana / BA",
      data: "2026-04-09T14:30:00.000Z",
    });

    expect(mockFetchDriverLoads).toHaveBeenCalledWith({
      origem: "Feira de Santana / BA",
      page: "1",
      pageSize: "5",
      dateFrom: "2026-04-09T03:00:00.000Z",
      dateTo: "2026-04-10T02:59:59.999Z",
    });
    expect(response).toEqual({
      items: [
        {
          id: "load-2",
          origem: "Feira de Santana / BA",
        },
      ],
      scope: "same-origin-eta",
    });
  });

  it("falls back to same-origin loads when the same eta window has no open alternatives", async () => {
    mockFetchDriverLoads
      .mockResolvedValueOnce({
        items: [
          {
            id: "load-1",
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "load-3",
            origem: "Feira de Santana / BA",
          },
        ],
      });

    const response = await fetchDriverLoadAlternatives({
      loadId: "load-1",
      origem: "Feira de Santana / BA",
      data: "2026-04-09T14:30:00.000Z",
    });

    expect(mockFetchDriverLoads).toHaveBeenNthCalledWith(1, {
      origem: "Feira de Santana / BA",
      page: "1",
      pageSize: "5",
      dateFrom: "2026-04-09T03:00:00.000Z",
      dateTo: "2026-04-10T02:59:59.999Z",
    });
    expect(mockFetchDriverLoads).toHaveBeenNthCalledWith(2, {
      origem: "Feira de Santana / BA",
      page: "1",
      pageSize: "5",
    });
    expect(response).toEqual({
      items: [
        {
          id: "load-3",
          origem: "Feira de Santana / BA",
        },
      ],
      scope: "same-origin",
    });
  });
});
