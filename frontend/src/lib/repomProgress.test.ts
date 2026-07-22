import { describe, expect, it } from "vitest";

import { REPOM_STALE_MS, repomBadge } from "./repomProgress";

const NOW = 1_700_000_000_000; // epoch ms fixo pros testes
const iso = (ms: number) => new Date(ms).toISOString();

describe("repomBadge — selo derivado de dados.repom", () => {
  it("cadastro que não é do Repom (sem dados.repom) → sem selo", () => {
    expect(repomBadge(null, NOW)).toBeNull();
    expect(repomBadge({}, NOW)).toBeNull();
    expect(repomBadge({ motorista: { cpf: "1" } }, NOW)).toBeNull();
  });

  it("origem diferente de whatsapp → sem selo", () => {
    expect(repomBadge({ repom: { origem: "wizard", coleta_status: "coletando" } }, NOW)).toBeNull();
  });

  it("coletando + interação recente → EM ANDAMENTO, com o próximo doc", () => {
    const b = repomBadge(
      { repom: { origem: "whatsapp", coleta_status: "coletando", etapa_atual: "selfie_cnh", ultima_interacao: iso(NOW - 60_000) } },
      NOW,
    );
    expect(b).toEqual({ label: "EM ANDAMENTO", tone: "andamento", aguardando: "selfie com a CNH" });
  });

  it("coletando + parado além do limite → PAROU", () => {
    const b = repomBadge(
      { repom: { origem: "whatsapp", coleta_status: "coletando", etapa_atual: "comprovante", ultima_interacao: iso(NOW - REPOM_STALE_MS - 1) } },
      NOW,
    );
    expect(b?.label).toBe("PAROU");
    expect(b?.tone).toBe("parou");
    expect(b?.aguardando).toBe("comprovante de residência");
  });

  it("bem na borda do limite ainda é EM ANDAMENTO (não parou)", () => {
    const b = repomBadge(
      { repom: { origem: "whatsapp", coleta_status: "coletando", etapa_atual: "telefone", ultima_interacao: iso(NOW - REPOM_STALE_MS) } },
      NOW,
    );
    expect(b?.label).toBe("EM ANDAMENTO");
  });

  it("sem ultima_interacao (data ausente/ilegível) → não marca PAROU", () => {
    const b = repomBadge({ repom: { origem: "whatsapp", coleta_status: "coletando", etapa_atual: "cnh" } }, NOW);
    expect(b?.label).toBe("EM ANDAMENTO");
    expect(b?.aguardando).toBe("CNH");
  });

  it("concluida → COMPLETO, sem aguardando", () => {
    const b = repomBadge({ repom: { origem: "whatsapp", coleta_status: "concluida", etapa_atual: null } }, NOW);
    expect(b).toEqual({ label: "COMPLETO", tone: "concluido", aguardando: null });
  });

  it("etapa desconhecida → usa a própria chave como rótulo", () => {
    const b = repomBadge(
      { repom: { origem: "whatsapp", coleta_status: "coletando", etapa_atual: "veiculo", ultima_interacao: iso(NOW) } },
      NOW,
    );
    expect(b?.aguardando).toBe("veiculo");
  });
});
