import { z } from "zod";
import { uuidSchema } from "./common.js";

/** Route params for /api/operator/clientes/:clienteId */
export const clienteIdParamsSchema = z.object({
  clienteId: uuidSchema,
});

/** Route params for /api/operator/clientes/:clienteId/rotas/:rotaId */
export const clienteRotaParamsSchema = z.object({
  clienteId: uuidSchema,
  rotaId: uuidSchema,
});

/** Body for POST /api/operator/clientes/:clienteId/rotas */
export const attachClienteRotaBodySchema = z.object({
  rotaId: uuidSchema,
});
