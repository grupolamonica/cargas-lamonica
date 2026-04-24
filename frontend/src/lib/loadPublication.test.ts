import { describe, expect, it } from "vitest";

import { resolveCargoPublicationReadiness } from "@/lib/loadPublication";

describe("loadPublication", () => {
  it("marca a carga como pendente quando faltam frete e metricas da rota", () => {
    const publication = resolveCargoPublicationReadiness(
      {
        perfil: "CARRETA",
        valor: null,
        bonus: null,
        distancia_km: null,
        duracao_horas: null,
        tempo_estimado_horas: null,
      },
      null,
    );

    expect(publication.isReady).toBe(false);
    expect(publication.missingFields).toEqual(["payment", "distance", "estimatedTime"]);
  });

  it("usa os dados da rota para completar a carga e liberar a publicacao", () => {
    const publication = resolveCargoPublicationReadiness(
      {
        perfil: "",
        valor: null,
        bonus: null,
        distancia_km: null,
        duracao_horas: null,
        tempo_estimado_horas: null,
      },
      {
        perfil_padrao: "TRUCK",
        valor_padrao: 8400,
        bonus_padrao: 350,
        distancia_km: 1510,
        duracao_horas: 22,
        tempo_estimado_horas: 26,
      },
    );

    expect(publication.isReady).toBe(true);
    expect(publication.missingFields).toEqual([]);
    expect(publication.perfil).toBe("TRUCK");
    expect(publication.valor).toBe(8400);
    expect(publication.bonus).toBe(350);
    expect(publication.totalPayment).toBe(8750);
    expect(publication.distancia_km).toBe(1510);
    expect(publication.tempo_estimado_horas).toBe(26);
  });

  it("gera um resumo amigavel das pendencias para o operador", () => {
    const publication = resolveCargoPublicationReadiness(
      {
        perfil: "",
        valor: null,
        bonus: null,
        distancia_km: null,
        duracao_horas: 18,
        tempo_estimado_horas: null,
      },
      null,
    );

    expect(publication.alertSummary).toBe("Faltam perfil do veiculo, frete e distancia da rota.");
  });
});
