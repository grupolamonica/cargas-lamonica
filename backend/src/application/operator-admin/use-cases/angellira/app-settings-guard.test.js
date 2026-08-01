/**
 * Guarda de processo do bootstrap de `app_settings`.
 *
 * `ensureAppSettingsTable` era chamada por TODO acesso a app_settings (17 pontos,
 * vários em jobs recorrentes) e rodava `CREATE TABLE IF NOT EXISTS` toda vez —
 * medido em produção: 6.566 execuções em 87 dias. Estes testes travam a
 * regressão contando o DDL que realmente chega ao banco.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetAppSettingsTableGuard,
  ensureAppSettingsTable,
} from "./auto-approve-vigentes.js";

function makeClient({ failTimes = 0 } = {}) {
  let remainingFailures = failTimes;
  const ddl = [];
  return {
    ddl,
    query: vi.fn(async (sql) => {
      ddl.push(String(sql).replace(/\s+/g, " ").trim());
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("boom");
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

const isCreateAppSettings = (sql) =>
  sql.includes("CREATE TABLE IF NOT EXISTS public.app_settings");

describe("ensureAppSettingsTable — guarda de processo", () => {
  beforeEach(() => {
    __resetAppSettingsTableGuard();
  });

  afterEach(() => {
    __resetAppSettingsTableGuard();
  });

  it("roda o DDL na primeira chamada", async () => {
    const client = makeClient();
    await ensureAppSettingsTable(client);
    expect(client.ddl.filter(isCreateAppSettings)).toHaveLength(1);
  });

  it("NAO repete o DDL nas chamadas seguintes (era 1 por acesso a app_settings)", async () => {
    const client = makeClient();
    for (let i = 0; i < 20; i += 1) {
      await ensureAppSettingsTable(client);
    }
    expect(client.ddl.filter(isCreateAppSettings)).toHaveLength(1);

    // eslint-disable-next-line no-console
    console.log(
      `[egress] app_settings bootstrap: 20 acessos => ${client.ddl.filter(isCreateAppSettings).length} DDL (era 20)`,
    );
  });

  it("chamadas concorrentes compartilham UM unico CREATE", async () => {
    const client = makeClient();
    await Promise.all(Array.from({ length: 12 }, () => ensureAppSettingsTable(client)));
    expect(client.ddl.filter(isCreateAppSettings)).toHaveLength(1);
  });

  it("nao vaza entre clients diferentes depois do reset (isolamento de teste)", async () => {
    const a = makeClient();
    await ensureAppSettingsTable(a);
    __resetAppSettingsTableGuard();
    const b = makeClient();
    await ensureAppSettingsTable(b);
    expect(a.ddl.filter(isCreateAppSettings)).toHaveLength(1);
    expect(b.ddl.filter(isCreateAppSettings)).toHaveLength(1);
  });

  it("FAIL-SAFE: se o DDL falha, a proxima chamada tenta de novo", async () => {
    const client = makeClient({ failTimes: 1 });
    await expect(ensureAppSettingsTable(client)).rejects.toThrow("boom");
    // não pode ficar marcado como pronto — senão o processo acharia que criou.
    await ensureAppSettingsTable(client);
    expect(client.ddl.filter(isCreateAppSettings)).toHaveLength(2);
  });

  it("propaga o erro (nao engole) para o chamador decidir", async () => {
    const client = makeClient({ failTimes: 1 });
    await expect(ensureAppSettingsTable(client)).rejects.toThrow("boom");
  });
});
