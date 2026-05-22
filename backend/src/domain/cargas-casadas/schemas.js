/**
 * Zod schemas para endpoints REST de cargas_casadas (pacote de cargas).
 *
 * Standalone — nao reusa optionalNumeric/optionalUuid de operator-admin/schemas.js
 * para evitar acoplamento entre subsistemas (clean architecture: domain layer puro).
 */

import { z } from "zod";

import { MAX_CARGAS_POR_PACOTE, PACOTE_STATUS_VALUES } from "./constants.js";

/** UUID parametrizado em paths. */
export const pacoteIdParamsSchema = z
  .object({
    pacoteId: z.string().uuid("pacoteId deve ser UUID valido."),
  })
  .strict();

export const removeCargaParamsSchema = z
  .object({
    pacoteId: z.string().uuid("pacoteId deve ser UUID valido."),
    cargaId: z.string().uuid("cargaId deve ser UUID valido."),
  })
  .strict();

/** Body de criacao: rascunho aceita valor_total opcional. */
export const pacoteCreateSchema = z
  .object({
    valor_total: z
      .union([z.number().positive("valor_total deve ser positivo."), z.null()])
      .optional(),
  })
  .strict();

/** Body de update: por enquanto so altera valor_total (mudanca de status via endpoints dedicados). */
export const pacoteUpdateSchema = z
  .object({
    valor_total: z.number().positive("valor_total deve ser positivo."),
  })
  .strict();

/** Add carga: ordem opcional (inferida = last+1). */
export const addCargaSchema = z
  .object({
    cargaId: z.string().uuid("cargaId deve ser UUID valido."),
    ordem: z
      .number()
      .int("ordem deve ser inteiro.")
      .min(1, "ordem minima e 1.")
      .max(MAX_CARGAS_POR_PACOTE, `ordem maxima e ${MAX_CARGAS_POR_PACOTE}.`)
      .optional(),
  })
  .strict();

/**
 * Reorder em massa: array de {cargaId, ordem}; ordens devem ser unicas e contiguas 1..N.
 */
export const reorderCargasSchema = z
  .object({
    orderings: z
      .array(
        z
          .object({
            cargaId: z.string().uuid("cargaId deve ser UUID valido."),
            ordem: z
              .number()
              .int("ordem deve ser inteiro.")
              .min(1, "ordem minima e 1.")
              .max(MAX_CARGAS_POR_PACOTE, `ordem maxima e ${MAX_CARGAS_POR_PACOTE}.`),
          })
          .strict(),
      )
      .min(1, "orderings nao pode ser vazio.")
      .max(MAX_CARGAS_POR_PACOTE, `orderings excede o limite de ${MAX_CARGAS_POR_PACOTE} cargas.`),
  })
  .strict()
  .refine(
    (data) => {
      const ordens = data.orderings.map((item) => item.ordem);
      const cargaIds = data.orderings.map((item) => item.cargaId);
      const ordensUnicas = new Set(ordens);
      const cargaIdsUnicas = new Set(cargaIds);
      return ordensUnicas.size === ordens.length && cargaIdsUnicas.size === cargaIds.length;
    },
    { message: "orderings nao pode ter ordens ou cargaIds duplicados." },
  )
  .refine(
    (data) => {
      const ordens = data.orderings.map((item) => item.ordem).sort((a, b) => a - b);
      return ordens.every((ordem, index) => ordem === index + 1);
    },
    { message: "orderings deve ser contigua iniciando em 1 (1..N)." },
  );

/** Lista de pacotes com paginacao. */
export const listPacotesQuerySchema = z
  .object({
    status: z
      .enum([
        PACOTE_STATUS_VALUES[0],
        PACOTE_STATUS_VALUES[1],
        PACOTE_STATUS_VALUES[2],
        PACOTE_STATUS_VALUES[3],
        PACOTE_STATUS_VALUES[4],
        PACOTE_STATUS_VALUES[5],
      ])
      .optional(),
    limit: z.coerce.number().int().positive().max(50).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
