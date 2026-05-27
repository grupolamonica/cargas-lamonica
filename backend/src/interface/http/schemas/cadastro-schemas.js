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

/**
 * POST /api/cadastro/lookup-pis (260515-loi T2).
 * Body driver-auth para consultar PIS no CNIS via Infosimples.
 */
export const lookupPisSchema = z
  .object({
    cpf: z
      .string()
      .transform((v) => String(v ?? "").replace(/\D/g, ""))
      .pipe(z.string().length(11, "CPF deve ter 11 digitos")),
    nome: z.string().trim().min(2, "Nome obrigatorio"),
    dataNascimento: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Data deve ser yyyy-mm-dd"),
  })
  .strict();
