import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedPendingRegistration,
  withPgClient,
  withPgTransaction,
} from "../operator-admin/test-harness.js";

vi.mock("../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));

const { brDateToIso, buildEnderecoFromComprovanteFields, buildMotoristaFromCnhFields, buildRepomProgress, renderObservacoes, upsertPendingCnh } =
  await import("./cnh-registration.js");

// campos como o sidecar (Vision) devolve
const visionFields = {
  nome: "LUCAS CAVALHEIRO",
  cpf: "11296552969",
  data_nascimento: "13/07/2000",
  numero_registro: "07314868241",
  categoria: "D",
  validade: "06/04/2032",
  primeira_habilitacao: "21/09/2018",
  rg_numero: "6170658",
  rg_orgao: "SSP",
  rg_uf: "SC",
  codigo_seguranca: "123456789",
  uf_emissor: "SC",
};

describe("repom cnh-registration", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  describe("brDateToIso", () => {
    it("BR→ISO; ISO mantém; vazio→null; formato estranho mantém", () => {
      expect(brDateToIso("06/04/2032")).toBe("2032-04-06");
      expect(brDateToIso("2032-04-06")).toBe("2032-04-06");
      expect(brDateToIso("")).toBeNull();
      expect(brDateToIso(null)).toBeNull();
      expect(brDateToIso("abril/2032")).toBe("abril/2032");
    });
  });

  describe("buildMotoristaFromCnhFields", () => {
    it("mapeia pros nomes canônicos do wizard (cnh.registro, datas ISO, pessoais no topo)", () => {
      const m = buildMotoristaFromCnhFields(visionFields, { cpf: "112.965.529-69" });
      expect(m).toMatchObject({
        cpf: "11296552969",
        nome: "LUCAS CAVALHEIRO",
        data_nascimento: "13/07/2000", // BR, não converte
        rg: "6170658",
        rg_orgao: "SSP",
        rg_uf: "SC",
        cnh: {
          registro: "07314868241",
          categoria: "D",
          validade: "2032-04-06", // ISO
          primeira_emissao: "2018-09-21", // ISO
          codigo_seguranca: "123456789",
          uf_emissor: "SC",
        },
      });
      expect(m.cnh_url).toBeUndefined(); // quem seta é o caller (staging)
    });

    it("aceita apelido do Infosimples (registro) e descarta primeira_emissao == validade", () => {
      const m = buildMotoristaFromCnhFields(
        { cpf: "11296552969", registro: "999", validade: "06/04/2032", primeira_habilitacao: "06/04/2032" },
        { cpf: "11296552969" },
      );
      expect(m.cnh.registro).toBe("999");
      expect(m.cnh.primeira_emissao).toBeUndefined(); // == validade → descartado
    });

    it("omite campos vazios (só cpf quando o OCR não achou nada)", () => {
      const m = buildMotoristaFromCnhFields({}, { cpf: "11296552969" });
      expect(m).toEqual({ cpf: "11296552969" });
    });
  });

  describe("buildEnderecoFromComprovanteFields (Vision → dados.motorista.endereco)", () => {
    it("mapeia chaves canônicas + split cidade/UF do municipio_uf", () => {
      const e = buildEnderecoFromComprovanteFields({
        cep: "40000-000",
        logradouro: "Rua das Flores",
        numero: "123",
        bairro: "Centro",
        municipio_uf: "Salvador - BA",
      });
      expect(e).toEqual({ cep: "40000-000", logradouro: "Rua das Flores", numero: "123", bairro: "Centro", cidade: "Salvador", uf: "BA" });
    });
    it("aceita aliases (endereco→logradouro, numero_cep→cep, municipio/uf separados)", () => {
      const e = buildEnderecoFromComprovanteFields({ endereco: "Av. Brasil", numero_cep: "12345678", municipio: "Recife", uf: "pe" });
      expect(e).toMatchObject({ logradouro: "Av. Brasil", cep: "12345678", cidade: "Recife", uf: "PE" });
    });
    it("endereço parcial só inclui o que veio; vazio → {}", () => {
      expect(buildEnderecoFromComprovanteFields({ bairro: "Boa Viagem" })).toEqual({ bairro: "Boa Viagem" });
      expect(buildEnderecoFromComprovanteFields({})).toEqual({});
    });
  });

  describe("buildRepomProgress (dados.repom — progresso da coleta)", () => {
    it("só CNH → coletando, próximo passo = selfie_cnh", () => {
      const r = buildRepomProgress({ cpf: "12345678901", cnh_url: "p/cnh.jpg" });
      expect(r).toMatchObject({ origem: "whatsapp", coleta_status: "coletando", etapa_atual: "selfie_cnh" });
      expect(typeof r.ultima_interacao).toBe("string");
    });
    it("cadastro completo → concluida, etapa_atual null", () => {
      const r = buildRepomProgress({ cpf: "12345678901", cnh_url: "a", selfie_cnh_url: "b", comprovante_url: "c", telefone: "71999998888" });
      expect(r).toMatchObject({ coleta_status: "concluida", etapa_atual: null });
    });
  });

  describe("renderObservacoes", () => {
    it("com issues → marca + motivos; sem issues → só marca", () => {
      expect(renderObservacoes([{ code: "cnh_vencida" }, { code: "cpf_diverge_sessao" }])).toMatch(
        /\[Cadastro via WhatsApp\] Revisar: CNH vencida; CPF da CNH difere do informado\./,
      );
      expect(renderObservacoes([])).toMatch(/\[Cadastro via WhatsApp\] cadastro iniciado/);
      expect(renderObservacoes(null, "OCR indisponível — ler manual.")).toMatch(/OCR indisponível/);
    });
  });

  describe("upsertPendingCnh", () => {
    it("create (sem registrationId): INSERT novo com id_cadastro repom-<cpf> e dados.motorista", async () => {
      const motorista = buildMotoristaFromCnhFields(visionFields, { cpf: "11296552969" });
      motorista.cnh_url = "11296552969/repom/motorista_cnh_1.jpg";
      const r = await withPgClient((c) =>
        upsertPendingCnh(c, { cpf: "11296552969", registrationId: null, motorista, status: "pendente", observacoes: "obs" }),
      );
      expect(r.created).toBe(true);
      const { rows } = await query(
        `SELECT id_cadastro, status, versao_cadastro, observacoes, dados FROM public.pending_driver_registrations WHERE id = $1`,
        [r.id],
      );
      expect(rows[0]).toMatchObject({ id_cadastro: "repom-11296552969", status: "pendente", versao_cadastro: "v2", observacoes: "obs" });
      expect(rows[0].dados.motorista.cnh.registro).toBe("07314868241");
      expect(rows[0].dados.motorista.cnh_url).toContain("motorista_cnh");
      // Fase 3d: progresso derivado gravado — só CNH → coletando, próximo = selfie.
      expect(rows[0].dados.repom).toMatchObject({ origem: "whatsapp", coleta_status: "coletando", etapa_atual: "selfie_cnh" });
    });

    it("update (com registrationId): merge no dados existente, dado NOVO prevalece", async () => {
      const seeded = await seedPendingRegistration({
        status: "em_analise",
        dados: { motorista: { cpf: "11296552969", nome: "NOME ANTIGO", telefones: ["71999"] } },
      });
      const motorista = buildMotoristaFromCnhFields(visionFields, { cpf: "11296552969" });
      const r = await withPgClient((c) =>
        upsertPendingCnh(c, { cpf: "11296552969", registrationId: seeded.id, motorista, status: "pendente", observacoes: null }),
      );
      expect(r).toEqual({ id: seeded.id, created: false });
      const { rows } = await query(`SELECT dados, status FROM public.pending_driver_registrations WHERE id = $1`, [seeded.id]);
      expect(rows[0].status).toBe("pendente");
      expect(rows[0].dados.motorista.nome).toBe("LUCAS CAVALHEIRO"); // novo prevalece
      expect(rows[0].dados.motorista.telefones).toEqual(["71999"]); // campo não tocado preservado
      expect(rows[0].dados.motorista.cnh.categoria).toBe("D");
      // não criou linha nova
      const { rows: all } = await query(`SELECT count(*)::int AS n FROM public.pending_driver_registrations`);
      expect(all[0].n).toBe(1);
    });

    it("create idempotente por id_cadastro: 2º upsert do MESMO CPF (sem registrationId) faz merge, NÃO duplica", async () => {
      const m1 = buildMotoristaFromCnhFields(visionFields, { cpf: "11296552969" });
      const r1 = await withPgClient((c) =>
        upsertPendingCnh(c, { cpf: "11296552969", registrationId: null, motorista: m1, status: "pendente" }),
      );
      expect(r1.created).toBe(true);

      // 2ª foto do mesmo CPF (corrida / reenvio) — id_cadastro repom-<cpf> já existe
      const m2 = buildMotoristaFromCnhFields({ ...visionFields, categoria: "E" }, { cpf: "11296552969" });
      const r2 = await withPgClient((c) =>
        upsertPendingCnh(c, { cpf: "11296552969", registrationId: null, motorista: m2, status: "pendente" }),
      );
      expect(r2).toEqual({ id: r1.id, created: false }); // merge na mesma linha

      const { rows } = await query(
        `SELECT count(*)::int AS n FROM public.pending_driver_registrations WHERE id_cadastro='repom-11296552969'`,
      );
      expect(rows[0].n).toBe(1); // não duplicou
      const { rows: d } = await query(`SELECT dados FROM public.pending_driver_registrations WHERE id=$1`, [r1.id]);
      expect(d[0].dados.motorista.cnh.categoria).toBe("E"); // novo prevalece
    });
  });
});
