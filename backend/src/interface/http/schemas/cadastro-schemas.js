import { z } from "zod";

export const finalizarCadastroSchema = z
  .object({
    id_cadastro: z.string().trim().min(1).max(100),
    dados: z
      .object({
        motorista: z
          .object({
            nome: z.string().trim().min(2),
            cpf: z.string().trim().min(11).max(14),
            telefone: z.string().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .strict();
