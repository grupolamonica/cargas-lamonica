import { describe, expect, it } from "vitest";

import { buildRouteContext, normalizeRouteQuerySegments } from "../../../api/[...route].mjs";

describe("vercel api catch-all route parsing", () => {
  it("usa os segmentos reais do pathname quando a requisicao chega com /api/... normal", () => {
    const context = buildRouteContext({
      url: "/api/driver/loads?page=1&pageSize=12",
      query: {
        page: "1",
        pageSize: "12",
      },
    });

    expect(context.segments).toEqual(["driver", "loads"]);
  });

  it("usa request.query.route quando a Vercel encaminha a rota dinamica pelo catch-all", () => {
    const context = buildRouteContext({
      url: "/api/[...route]?page=1&pageSize=12",
      query: {
        route: ["driver", "loads"],
        page: "1",
        pageSize: "12",
      },
    });

    expect(context.segments).toEqual(["driver", "loads"]);
  });

  it("normaliza o catch-all mesmo quando a query route chega como string", () => {
    expect(normalizeRouteQuerySegments("driver/loads/facets")).toEqual(["driver", "loads", "facets"]);
  });
});
