import { z } from "zod";
import { uuidSchema } from "./common.js";

/** Route params for /api/operator/cargas/:cargoId */
export const cargoIdParamsSchema = z.object({
  cargoId: uuidSchema,
});

/** Query for GET /api/operator/cargas/lookup/codigo-viagem?codigo_viagem= */
export const cargoCodigoViagemQuerySchema = z.object({
  codigo_viagem: z.string().trim().min(1).max(255),
});

/**
 * Query for GET /api/operator/cargas/historico?lh=&cargo_id=
 *
 * Aceita `lh` (carga da planilha ou lançada) e/ou `cargo_id` (carga do sistema —
 * inclusive as SEM LH, que antes ficavam sem histórico porque o front não tinha
 * identificador para consultar). Pelo menos um dos dois.
 */
export const cargoHistoryQuerySchema = z
  .object({
    lh: z.string().trim().min(1).max(255).optional(),
    // Fonte da PLANILHA da linha ('nestle', …). Ausente = Shopee. O id da carga de
    // planilha e namespaced por fonte, entao sem ela o historico da carga Nestle
    // ficava vazio.
    source: z.string().trim().max(40).optional(),
    cargo_id: uuidSchema.optional(),
  })
  .refine((v) => Boolean(v.lh || v.cargo_id), {
    message: "Informe lh ou cargo_id.",
  });
