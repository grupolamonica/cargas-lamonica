/**
 * Phase 10 / Plan 10-08 — Task 2
 *
 * Happy path E2E: operador cria pacote (3 cargas premium) → publica → motorista A
 * ve no portal → clica "Candidatar-se" → todas 3 cargas + pacote ficam reservadas.
 *
 * Strategy:
 *  - Setup via DB direto (mais rapido + deterministico que via UI cliques)
 *  - UI usada APENAS para validar visibilidade no operador e candidatura do motorista
 *  - Assertions finais via SELECT na DB (fonte da verdade)
 *
 * Pre-requisitos: ver `fixtures.ts` (SUPABASE_DB_URL local/staging + auth env vars).
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
  loginAsDriver,
} from "./fixtures";

test.describe("Cargas Casadas — happy path", () => {
  let pacoteId = "";
  let cargaIds: string[] = [];

  test.afterEach(async ({ pgClient }) => {
    if (pacoteId) {
      try {
        await cleanupPacote(pgClient, pacoteId);
      } catch {
        // ignora — pode ja ter sido removido
      }
      pacoteId = "";
    }
    if (cargaIds.length) {
      try {
        await cleanupCargas(pgClient, cargaIds);
      } catch {
        // ignora — pode ja ter sido removido
      }
      cargaIds = [];
    }
  });

  test("operador publica pacote → motorista A candidata → todas 3 cargas + pacote reservados", async ({
    pgClient,
    page,
    browser,
    operatorLogin,
    driverALogin,
  }) => {
    const operatorId = process.env.E2E_OPERATOR_USER_ID;
    if (!operatorId) {
      test.skip(true, "E2E_OPERATOR_USER_ID nao definida — pre-requisito para fixture do pacote");
      return;
    }

    // ─── SETUP: 3 cargas PREMIUM + OPEN + pacote publicado ───
    cargaIds = [
      await createTestCarga(pgClient, {
        origem: "Sao Paulo - SP",
        destino: "Salvador - BA",
        valor: 2000,
      }),
      await createTestCarga(pgClient, {
        origem: "Salvador - BA",
        destino: "Recife - PE",
        valor: 1500,
      }),
      await createTestCarga(pgClient, {
        origem: "Recife - PE",
        destino: "Fortaleza - CE",
        valor: 1500,
      }),
    ];
    pacoteId = await createTestPacote(pgClient, {
      valorTotal: 5000,
      operatorId,
    });
    await linkCargasToPacote(pgClient, pacoteId, cargaIds);
    await publishTestPacote(pgClient, pacoteId);

    // ─── ACT 1: operador ve pacote no painel ───
    await loginAsOperator(page, operatorLogin);
    await page.goto("/pacotes");

    // ManagePacotes lista pacotes publicados; pacoteId aparece (8 primeiros chars usados como label fallback)
    await expect(
      page.locator(`text=${pacoteId.substring(0, 8)}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // ─── ACT 2: motorista A abre portal + ve viagem casada ───
    const driverContext = await browser.newContext();
    const driverPage = await driverContext.newPage();
    try {
      await loginAsDriver(driverPage, driverALogin);
      await driverPage.goto("/motorista");

      // LoadCard com pacote_meta renderiza header "Viagem casada" (CONTEXT line 100)
      await expect(
        driverPage.locator("text=/Viagem casada.*3 paradas?/i").first(),
      ).toBeVisible({ timeout: 15_000 });

      // ─── ACT 3: candidatar ─── navega para detalhe da carga 1 (parte do pacote)
      await driverPage.goto(`/motorista/cargas/${cargaIds[0]}`);
      await expect(driverPage.getByTestId("pacote-panel")).toBeVisible({
        timeout: 10_000,
      });

      const candidateBtn = driverPage
        .getByRole("button", { name: /Candidatar-se/i })
        .first();
      await candidateBtn.waitFor({ state: "visible", timeout: 10_000 });
      await candidateBtn.click();

      // espera transacao commit + realtime propagar
      await driverPage.waitForTimeout(3_000);

      // ─── ASSERT: DB reflete reserva atomica ───
      const { rows: cargasAfter } = await pgClient.query<{ status: string }>(
        `SELECT status FROM public.cargas WHERE viagem_id = $1 ORDER BY ordem_viagem`,
        [pacoteId],
      );
      expect(cargasAfter).toHaveLength(3);
      expect(
        cargasAfter.every((c) => c.status === "RESERVED"),
        `Esperado todas 3 cargas RESERVED; obtido: ${cargasAfter.map((c) => c.status).join(",")}`,
      ).toBe(true);

      const { rows: pacoteRows } = await pgClient.query<{
        status: string;
        reserved_driver_id: string | null;
      }>(
        `SELECT status, reserved_driver_id FROM public.cargas_casadas WHERE id = $1`,
        [pacoteId],
      );
      expect(pacoteRows).toHaveLength(1);
      expect(pacoteRows[0].status).toBe("reservado");
      expect(pacoteRows[0].reserved_driver_id).toBeTruthy();
    } finally {
      await driverContext.close();
    }
  });
});
