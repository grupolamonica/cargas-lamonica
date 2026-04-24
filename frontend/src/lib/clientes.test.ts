import { createEmptyClienteForm, mapClienteFormToPayload, mapClienteToFormData, type Cliente } from "@/lib/clientes";

describe("clientes helpers", () => {
  it("keeps logo url when mapping cliente to form data", () => {
    const cliente = {
      id: "cliente-1",
      created_at: "2026-04-06T12:00:00.000Z",
      nome: "Cliente Exemplo",
      descricao: "Descricao",
      logo_url: "https://example.com/logo.png",
      forma_pagamento: "Pix",
      prazo_pagamento: "48h",
      exige_rastreamento: false,
      exige_antt: false,
      exige_seguro: false,
      exige_carga_monitorada: false,
      reputacao_pagamento_rapido: false,
      reputacao_bom_pagador: false,
      reputacao_liberacao_rapida: false,
      reputacao_carga_organizada: false,
      reputacao_boa_comunicacao: false,
      observacoes: null,
      rastreamento: null,
      antt: null,
      peso: null,
      tipo_veiculo: null,
      valor_frete: null,
    } as Cliente;

    expect(mapClienteToFormData(cliente).logo_url).toBe("https://example.com/logo.png");
  });

  it("persists logo url in the payload sent to supabase", () => {
    const payload = mapClienteFormToPayload({
      ...createEmptyClienteForm(),
      nome: "Cliente Exemplo",
      logo_url: " https://example.com/logo.png ",
      exige_rastreamento: true,
      exige_antt: true,
    });

    expect(payload.logo_url).toBe("https://example.com/logo.png");
    expect(payload).not.toHaveProperty("rastreamento");
    expect(payload).not.toHaveProperty("antt");
    expect(payload.exige_rastreamento).toBe(true);
    expect(payload.exige_antt).toBe(true);
  });
});
