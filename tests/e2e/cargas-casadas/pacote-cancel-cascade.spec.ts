/**
 * Phase 10 / Plan 10-08 — Task 4a
 *
 * Cancel cascade E2E: cancelar carga que pertence a pacote publicado dispara
 * cascade — pacote + cargas-irmas viram CANCELLED em transacao atomica.
 *
 * Cobre:
 *  - Validacao do plano 10-04 (cascade on cancel)
 *  - Regra de negocio: status do pacote propaga para todas as cargas-membros
 *  - Operacao via UI do operador (ManageCargas → cancel)
 */
import {
  test,
  expect,
  createTestCarga,
  createTestPacote,
  linkCargasToPacote,
  publishTestPacote,
  cleanupPacote,
  cleanupCargas,
  loginAsOperator,
} from "./fixtures";

test.describe("Cargas Casadas — cancel cascade", () => {
  let pacoteId = "";
  let cargaIds: string[] = [];

  test.afterEach(async ({ pgClient }) => {
    if (pacoteId) {
      try {
        await cleanupPacote(pgClient, pacoteId);
      } catch {
        /* ignora */
      }
      pacoteId = "";
    }
    if (cargaIds.length) {
      try {
        await cleanupCargas(pgClient, cargaIds);
      } catch {
        /* ignora */
      }
      cargaIds = [];
    }
  });

  test("cancelar carga 1 via /cargas → pacote + cargas-irmas viram CANCELLED (cancel cascade)", async ({
    pgClient,
    page,
    operatorLogin,
  }) => {
    const operatorId = process.env.E2E_OPERATOR_USER_ID;
    if (!operatorId) {
      test.skip(true, "E2E_OPERATOR_USER_ID nao definida");
      return;
    }

    // ─── SETUP: pacote publicado com 3 cargas ───
    cargaIds = [
      await createTestCarga(pgClient, { origem: "A", destino: "B" }),
      await createTestCarga(pgClient, { origem: "B", destino: "C" }),
      await createTestCarga(pgClient, { origem: "C", destino: "D" }),
    ];
    pacoteId = await createTestPacote(pgClient, { valorTotal: 5000, operatorId });
    await linkCargasToPacote(pgClient, pacoteId, cargaIds);
    await publishTestPacote(pgClient, pacoteId);

    // ─── ACT: operador cancela carga 1 via UI ───
    await loginAsOperator(page, operatorLogin);
    await page.goto("/cargas");

    // Localiza a linha da carga e o trigger de cancelamento. Estrategia robusta:
    // procurar a celula com o id (ou substring) e clicar na acao "Cancelar" do menu.
    const cargaRow = page.locator(
      `[data-cargo-id="${cargaIds[0]}"], tr:has-text("${cargaIds[0].substring(0, 8)}")`,
    ).first();
    await cargaRow.waitFor({ state: "visible", timeout: 10_000 });

    // Acao cancelar — pode estar em menu dropdown ou botao direto.
    // Tentativa 1: aria-label="Cancelar" dentro da linha.
    const cancelTrigger = cargaRow.locator(
      '[aria-label="Cancelar"], button:has-text("Cancelar")',
    ).first();
    if (await cancelTrigger.isVisible().catch(() => false)) {
      await cancelTrigger.click();
    } else {
      // Tentativa 2: menu de acoes (3 dots) e depois "Cancelar"
      const menuTrigger = cargaRow
        .locator('button[aria-haspopup="menu"], [aria-label*="Acoes" i]')
        .first();
      await menuTrigger.click();
      await page.getByRole("menuitem", { name: /Cancelar/i }).click();
    }

    // Modal de confirmacao
    const confirmButton = page
      .getByRole("button", { name: /Confirmar|OK|Sim/i })
      .first();
    await confirmButton.waitFor({ state: "visible", timeout: 5_000 });
    await confirmButton.click();

    // Espera transacao commit (cascade roda em transacao no use case)
    await page.waitForTimeout(2_500);

    // ─── ASSERT: cascade aplicado ───
    const { rows: cargasAfter } = await pgClient.query<{ status: string; id: string }>(
      `SELECT id, status FROM public.cargas WHERE id = ANY($1::uuid[]) ORDER BY ordem_viagem`,
      [cargaIds],
    );
    expect(cargasAfter).toHaveLength(3);
    expect(
      cargasAfter.every((c) => c.status === "CANCELLED"),
      `Esperado todas 3 cargas CANCELLED; obtido: ${cargasAfter
        .map((c) => `${c.id.substring(0, 8)}=${c.status}`)
        .join(",")}`,
    ).toBe(true);

    const { rows: [pacoteAfter] } = await pgClient.query<{ status: string }>(
      `SELECT status FROM public.cargas_casadas WHERE id = $1`,
      [pacoteId],
    );
    expect(pacoteAfter.status).toBe("cancelado");
  });
});
