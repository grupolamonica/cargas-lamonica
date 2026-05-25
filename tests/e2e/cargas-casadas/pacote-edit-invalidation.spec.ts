/**
 * Phase 10 / Plan 10-08 — Task 3
 *
 * Edit invalidation E2E: pacote publicado → motorista A abre detalhe →
 * operador edita pacote → version bump → motorista A recebe notificacao
 * realtime (toast "pacote atualizado") + invalidacao da query.
 *
 * Cobre:
 *  - Supabase Realtime subscription no PacotePanel (DriverCargoDetails)
 *  - Backend incrementa `cargas_casadas.version` em qualquer mutacao
 *  - Frontend driver dispara toast + re-fetch ao receber UPDATE
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

test.describe("Cargas Casadas — edit invalidation", () => {
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

  test("operador edita valor_total → motorista A recebe toast 'pacote atualizado' via realtime + version bump", async ({
    pgClient,
    page,
    browser,
    operatorLogin,
    driverALogin,
  }) => {
    const operatorId = process.env.E2E_OPERATOR_USER_ID;
    if (!operatorId) {
      test.skip(true, "E2E_OPERATOR_USER_ID nao definida");
      return;
    }

    // ─── SETUP ───
    cargaIds = [
      await createTestCarga(pgClient, { origem: "SP", destino: "BA", valor: 1500 }),
      await createTestCarga(pgClient, { origem: "BA", destino: "PE", valor: 1500 }),
    ];
    pacoteId = await createTestPacote(pgClient, { valorTotal: 3000, operatorId });
    await linkCargasToPacote(pgClient, pacoteId, cargaIds);
    await publishTestPacote(pgClient, pacoteId);

    // Captura version inicial
    const { rows: [{ version: versionBefore }] } = await pgClient.query<{
      version: number;
    }>(`SELECT version FROM public.cargas_casadas WHERE id = $1`, [pacoteId]);

    // ─── ACT 1: motorista A abre detalhe da carga 1 (parte do pacote) ───
    const driverContext = await browser.newContext();
    const driverPage = await driverContext.newPage();
    try {
      await loginAsDriver(driverPage, driverALogin);
      await driverPage.goto(`/motorista/cargas/${cargaIds[0]}`);
      await expect(driverPage.getByTestId("pacote-panel")).toBeVisible({
        timeout: 15_000,
      });

      // ─── ACT 2: operador edita pacote ───
      await loginAsOperator(page, operatorLogin);
      await page.goto(`/pacotes/${pacoteId}`);

      // Clica em "Editar" para abrir o PacoteFormModal (ManagePacotes/PacoteDetails padrao)
      const editButton = page.getByRole("button", { name: /Editar/i }).first();
      await editButton.waitFor({ state: "visible", timeout: 10_000 });
      await editButton.click();

      // Atualiza valor_total para disparar UPDATE
      const valorInput = page.locator(
        'input[id="valor_total"], input[name="valor_total"]',
      ).first();
      await valorInput.waitFor({ state: "visible", timeout: 5_000 });
      await valorInput.fill("4000");

      const saveButton = page.getByRole("button", { name: /Salvar/i }).first();
      await saveButton.click();

      // ─── ASSERT 1: motorista recebe toast realtime ───
      // sonner usa data-sonner-toast como wrapper
      const toast = driverPage.locator(
        '[data-sonner-toast], [role="status"]:has-text("pacote")',
      );
      await expect(toast.first()).toBeVisible({ timeout: 15_000 });

      // ─── ASSERT 2: version bumped na DB ───
      // Pequena espera para garantir commit antes do SELECT
      await page.waitForTimeout(1_500);
      const { rows: [{ version: versionAfter, valor_total: valorAfter }] } = await pgClient.query<{
        version: number;
        valor_total: string;
      }>(
        `SELECT version, valor_total FROM public.cargas_casadas WHERE id = $1`,
        [pacoteId],
      );
      expect(versionAfter).toBeGreaterThan(versionBefore);
      expect(Number(valorAfter)).toBe(4000);
    } finally {
      await driverContext.close();
    }
  });
});
