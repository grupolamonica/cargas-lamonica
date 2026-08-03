// Mede, sobre um FIXTURE SEMEADO de verdade (pg-mem + jsonb real), a redução de
// egress de trocar `l.validation_summary_json` (JSON inteiro do Angellira) pelo
// caminho extraído `->'driver'->'angelira'->>'displayName'` em
// reconcile-sheet-allocations.js.
//
// LIMITAÇÃO HONESTA: a query completa do reconciliador NÃO roda no harness —
// pg-mem não suporta `jsonb_array_elements(<coluna>)` (verificado: falha com
// `column "s.rows_json" does not exist` tanto na forma ANTIGA quanto na nova,
// logo é limitação do harness e não da mudança). As guardas do reconciliador
// ficam travadas por asserção no TEXTO do SQL em
// `reconcile-sheet-allocations.test.js`; aqui o que se mede é o JOIN com o lead,
// que pg-mem executa.

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const { closeTestDatabase, resetTestDatabase, query, seedCargo, seedPublicLead } = await import(
  "../operator-admin/test-harness.js"
);

// JSON do Angellira como em produção: grande, e só UM campo interessa ao write-back.
function angelliraSummary(displayName) {
  return {
    driver: {
      angelira: {
        displayName,
        found: true,
        statusText: "Conforme",
        limitDate: "2026-12-31",
        details: Array.from({ length: 40 }, (_, index) => ({
          consulta: `consulta-${index}`,
          resultado: "OK",
          observacao: "documentacao conferida e dentro da validade contratual",
        })),
      },
      aspx: { found: true, driverId: "12345", raw: "x".repeat(400) },
    },
    warnings: ["nada-a-reportar"],
  };
}

// Espelha o JOIN da classe (1) do reconciliador. `TRIM()` foi omitido de
// propósito: pg-mem não implementa `trim()` (outro motivo pelo qual a query real
// não roda no harness) e a normalização não influi na medição de bytes.
const SELECT_FROM = `
  FROM public.cargas c
  LEFT JOIN public.load_public_leads l ON l.id = c.reserved_public_lead_id
  WHERE c.sheet_lh IS NOT NULL AND c.sheet_lh <> ''
    AND (c.status = 'RESERVED' OR COALESCE(c.alloc_motorista, '') <> '')
`;

describe("reconcile-sheet-allocations: coluna do lead (fixture semeado)", () => {
  beforeEach(async () => {
    await resetTestDatabase();

    // 3 cargas da planilha RESERVADAS por lead, cada uma com o JSON cheio.
    for (const [index, nome] of ["Maria Souza", "Joao Lima", "Ana Paula"].entries()) {
      const cargo = await seedCargo({ sheet_lh: `LT-${index}`, status: "RESERVED" });
      const lead = await seedPublicLead({
        load_id: cargo.id,
        horse_plate: `HHH${index}A11`,
        trailer_plate: `TTT${index}B22`,
        validation_summary_json: angelliraSummary(nome),
      });
      await query(
        `UPDATE public.cargas SET sheet_source = 'shopee', reserved_public_lead_id = $2 WHERE id = $1`,
        [cargo.id, lead.id],
      );
    }
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("extrai o MESMO nome que a função JS extraía do JSON inteiro", async () => {
    const cru = await query(
      `SELECT c.sheet_lh, l.validation_summary_json ${SELECT_FROM} ORDER BY c.sheet_lh`,
    );
    const extraido = await query(
      `SELECT c.sheet_lh,
              l.validation_summary_json->'driver'->'angelira'->>'displayName' AS angelira_display_name
         ${SELECT_FROM} ORDER BY c.sheet_lh`,
    );

    expect(cru.rows).toHaveLength(3);
    expect(extraido.rows).toHaveLength(3);

    // Réplica da leitura JS antiga (angelliraDisplayName) sobre o JSON cru.
    const antigo = cru.rows.map((row) => {
      let summary = row.validation_summary_json;
      if (typeof summary === "string") summary = JSON.parse(summary);
      const name = summary?.driver?.angelira?.displayName;
      return typeof name === "string" && name.trim() ? name.trim() : "";
    });
    const novo = extraido.rows.map((row) => (row.angelira_display_name ?? "").trim());

    expect(novo).toEqual(antigo);
    expect(novo).toEqual(["Maria Souza", "Joao Lima", "Ana Paula"]);
  });

  it("mesmas LINHAS, muito menos BYTES", async () => {
    const cru = await query(
      `SELECT c.sheet_lh, l.horse_plate, l.trailer_plate, l.validation_summary_json ${SELECT_FROM}`,
    );
    const extraido = await query(
      `SELECT c.sheet_lh, l.horse_plate, l.trailer_plate,
              l.validation_summary_json->'driver'->'angelira'->>'displayName' AS angelira_display_name
         ${SELECT_FROM}`,
    );

    // Contagem de LINHAS idêntica — a redução é de COLUNA, não de filtro.
    expect(extraido.rows).toHaveLength(cru.rows.length);

    const bytesAntes = JSON.stringify(cru.rows).length;
    const bytesDepois = JSON.stringify(extraido.rows).length;

    console.info(
      `[medido] 3 linhas: ${bytesAntes} bytes -> ${bytesDepois} bytes ` +
        `(-${(100 - (bytesDepois / bytesAntes) * 100).toFixed(1)}%)`,
    );

    expect(bytesDepois).toBeLessThan(bytesAntes / 20);
  });

  it("lead sem displayName no JSON → NULL (mesma degradação de antes)", async () => {
    const cargo = await seedCargo({ sheet_lh: "LT-SEM-NOME", status: "RESERVED" });
    const lead = await seedPublicLead({
      load_id: cargo.id,
      validation_summary_json: { driver: { aspx: { found: false } } },
    });
    await query(
      `UPDATE public.cargas SET sheet_source = 'shopee', reserved_public_lead_id = $2 WHERE id = $1`,
      [cargo.id, lead.id],
    );

    const { rows } = await query(
      `SELECT l.validation_summary_json->'driver'->'angelira'->>'displayName' AS angelira_display_name
         FROM public.cargas c
         JOIN public.load_public_leads l ON l.id = c.reserved_public_lead_id
        WHERE c.sheet_lh = 'LT-SEM-NOME'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].angelira_display_name ?? null).toBeNull();
  });
});
