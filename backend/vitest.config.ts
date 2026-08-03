import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.{test,spec}.{js,mjs,ts}"],
    exclude: ["benchmarks/**", "node_modules/**"],
    // ── Orçamentos de tempo: a suíte é pesada em pg-mem ────────────────────
    // Boa parte dos testes sobe um Postgres em memória, roda a DDL inteira do
    // schema e semeia fixtures. Com os defaults do Vitest (testTimeout 5s,
    // hookTimeout 10s) isso vive na beira do precipício: um teste de fixture
    // grande custava 4,7s SOZINHO — 95% do orçamento — e qualquer concorrência
    // o estourava.
    //
    // E estourar é PIOR que ser lento: o Vitest ABANDONA o teste que expirou,
    // mas o trabalho assíncrono dele continua. O `query()` do harness resolve o
    // pool de módulo a cada chamada, então a escrita órfã cai no banco que o
    // `beforeEach` do teste SEGUINTE já recriou — e o sintoma aparece como
    // falha de asserção num teste inocente (um deep-equal com linhas fantasma),
    // longe da causa. Foi exatamente o que aconteceu ao investigar isto:
    // 6 rodadas, TODA falha restante era `Test timed out in 5000ms` ou
    // `Hook timed out in 10000ms` em teste com banco — NUNCA uma asserção de
    // verdade. O hook que mais estoura é o próprio `resetTestDatabase()`.
    //
    // Subir o orçamento trata a causa; remendar arquivo por arquivo com
    // `}, 30_000)` só move o problema para o próximo teste pesado. Estes
    // valores NÃO escondem lentidão real: um teste que hoje leva ~1s continua
    // a ~1s, e regressão de verdade (loop infinito, promise pendurada) ainda
    // falha, só um pouco mais tarde.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {},
  },
});
