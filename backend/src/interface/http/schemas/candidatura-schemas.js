import { z } from "zod";

const dadosBancariosSchema = z
  .object({
    banco_compe: z.string().trim().min(1).optional(),
    banco_nome: z.string().trim().optional(),
    agencia: z.string().trim().optional(),
    conta: z.string().trim().optional(),
    tipo: z.string().trim().optional(),
  })
  .passthrough()
  .optional();

const anttTitularSchema = z
  .object({
    tipo: z.enum(["pf", "pj"]).optional(),
    doc: z.string().trim().min(1),
    nome: z.string().trim().min(1),
    rntrc: z.string().trim().optional(),
    pis: z.string().trim().optional(),
    estado_civil: z.string().trim().optional(),
    cor_raca: z.string().trim().optional(),
    dados_bancarios: dadosBancariosSchema,
  })
  .passthrough();

const ownerSchema = z
  .object({
    tipo: z.enum(["pf", "pj"]).optional(),
    doc: z.string().trim().min(1),
    nome: z.string().trim().min(1),
    dados_bancarios: dadosBancariosSchema,
    antt_titular: anttTitularSchema.optional(),
  })
  .passthrough();

const veiculoSchema = z
  .object({
    placa: z.string().trim().min(1),
    renavam: z.string().trim().optional(),
    chassi: z.string().trim().optional(),
    marca: z.string().trim().optional(),
    ano: z.number().optional(),
    cor: z.string().trim().optional(),
    owner_doc: z.string().trim().optional(),
    owner_doc_type: z.string().trim().optional(),
  })
  .passthrough();

const motoristaSchema = z
  .object({
    nome: z.string().trim().min(1),
    telefones: z.array(z.string()).optional(),
    telefone_primario: z.string().trim().optional(),
    endereco: z
      .object({
        cep: z.string().trim().optional(),
        numero: z.string().trim().optional(),
        logradouro: z.string().trim().optional(),
        bairro: z.string().trim().optional(),
        cidade: z.string().trim().optional(),
        uf: z.string().trim().optional(),
      })
      .passthrough()
      .optional(),
    tag_pedagio: z.string().trim().optional(),
    pancary_autodeclaration: z.string().trim().optional(),
  })
  .passthrough();

export const candidaturaSubmitSchema = z
  .object({
    cargaId: z.string().trim().min(1),
    dados: z
      .object({
        motorista: motoristaSchema,
        cavalo: veiculoSchema.optional(),
        cavalo_owner: ownerSchema.optional(),
        carretas: z.array(veiculoSchema).optional(),
        carreta_owners: z.array(ownerSchema).optional(),
      })
      .passthrough(),
  })
  .passthrough();
