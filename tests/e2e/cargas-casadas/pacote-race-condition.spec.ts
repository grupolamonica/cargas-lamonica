/**
 * Phase 10 / Plan 10-08 — Task 4b
 *
 * Race condition E2E: 2 motoristas candidatam ao mesmo pacote em ~mesmo instante
 * (Promise.all em 2 browser contexts paralelos) → exatamente 1 vence.
 *
 * Cobre:
 *  - Reserva atomica (plano 10-03) via UPDATE...WHERE reserved_driver_id IS NULL
 *  - Garantia: NENHUMA situacao em que pacote fica parcialmente reservado
 *  - load_claims do perdedor recebem WAITLISTED/REJECTED (ou nao sao criados)
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
  loginAsDriver,
} from "./fixtures";

test.describe("Cargas Casadas — race condition", () => {
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

  test("2 motoristas candidatam simultaneo → exatamente 1 vence (reserva atomica)", async ({
    pgClient,
    browser,
    driverALogin,
    driverBLogin,
  }) => {
    const operatorId = process.env.E2E_OPERATOR_USER_ID;
    if (!operatorId) {
      test.skip(true, "E2E_OPERATOR_USER_ID nao definida");
      return;
    }

    // ─── SETUP: pacote publicado com 2 cargas ───
    cargaIds = [
      await createTestCarga(pgClient, { origem: "X", destino: "Y", valor: 2000 }),
      await createTestCarga(pgClient, { origem: "Y", destino: "Z", valor: 2000 }),
    ];
    pacoteId = await createTestPacote(pgClient, { valorTotal: 4000, operatorId });
    await linkCargasToPacote(pgClient, pacoteId, cargaIds);
    await publishTestPacote(pgClient, pacoteId);

    // ─── ACT: 2 motoristas abrem detalhe e clicam simultaneo ───
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await Promise.all([
        loginAsDriver(pageA, driverALogin),
        loginAsDriver(pageB, driverBLogin),
      ]);

      // Ambos navegam para a mesma carga (parte do pacote) — botao "Candidatar-se"
      // gera claim que reserva o pacote atomicamente.
      await Promise.all([
        pageA.goto(`/motorista/cargas/${cargaIds[0]}`),
        pageB.goto(`/motorista/cargas/${cargaIds[0]}`),
      ]);

      // Espera o botao aparecer em ambas as paginas
      const ctaA = pageA.getByRole("button", { name: /Candidatar-se/i }).first();
      const ctaB = pageB.getByRole("button", { name: /Candidatar-se/i }).first();
      await Promise.all([
        ctaA.waitFor({ state: "visible", timeout: 15_000 }),
        ctaB.waitFor({ state: "visible", timeout: 15_000 }),
      ]);

      // Click simultaneo (Promise.all minimiza skew entre eventos)
      await Promise.all([ctaA.click(), ctaB.click()]);

      // Espera ambas as responses (transacao + render)
      await pageA.waitForTimeout(4_000);

      // ─── ASSERT 1: pacote tem EXATAMENTE 1 reserved_driver_id ───
      const { rows: [pacoteAfter] } = await pgClient.query<{
        reserved_driver_id: string | null;
        status: string;
      }>(
        `SELECT reserved_driver_id, status FROM public.cargas_casadas WHERE id = $1`,
        [pacoteId],
      );
      expect(pacoteAfter.reserved_driver_id).toBeTruthy();
      expect(pacoteAfter.status).toBe("reservado");

      // ─── ASSERT 2: todas as cargas RESERVED com o MESMO driver ───
      const { rows: cargasAfter } = await pgClient.query<{
        status: string;
        reserved_driver_id: string | null;
      }>(
        `SELECT status, reserved_driver_id FROM public.cargas WHERE viagem_id = $1`,
        [pacoteId],
      );
      expect(cargasAfter).toHaveLength(2);
      expect(cargasAfter.every((c) => c.status === "RESERVED")).toBe(true);
      const uniqueDrivers = new Set(
        cargasAfter.map((c) => c.reserved_driver_id).filter(Boolean),
      );
      expect(
        uniqueDrivers.size,
        `Cargas devem ter UM unico reserved_driver_id; obtido: ${[...uniqueDrivers].join(",")}`,
      ).toBe(1);

      // ─── ASSERT 3: load_claims tem exatamente 1 driver vencedor ───
      // O perdedor pode nao ter criado claim (rejeitado upstream) ou ter claim em
      // status WAITLISTED/REJECTED. O vencedor tem WON_RESERVATION em ambas as cargas.
      const { rows: claims } = await pgClient.query<{
        driver_id: string;
        status: string;
      }>(
        `SELECT driver_id, status FROM public.load_claims WHERE load_id = ANY($1::uuid[])`,
        [cargaIds],
      );
      const winners = claims.filter((c) => c.status === "WON_RESERVATION");
      const winnerDrivers = new Set(winners.map((c) => c.driver_id));
      expect(
        winnerDrivers.size,
        `Esperado 1 driver vencedor; obtido: ${[...winnerDrivers].join(",")} (todos claims=${claims
          .map((c) => `${c.driver_id.substring(0, 8)}/${c.status}`)
          .join(",")})`,
      ).toBe(1);
      // Vencedor deve ter claim em TODAS as cargas do pacote
      expect(winners).toHaveLength(cargaIds.length);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
