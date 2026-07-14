// Schemas (zod) do cofre de credenciais do rastreador (DC-236).
// A placa do CAVALO é normalizada (uppercase, sem hífen/espaço) e validada contra
// os dois formatos brasileiros: antigo (ABC1234) e Mercosul (ABC1D23).
import { z } from "zod";

const horsePlateSchema = z
  .string()
  .trim()
  .toUpperCase()
  .transform((v) => v.replace(/[^A-Z0-9]/g, ""))
  .refine((v) => /^[A-Z]{3}[0-9][0-9A-Z][0-9]{2}$/.test(v), "Placa de cavalo inválida.");

export const rastreadorCredentialUpsertSchema = z.object({
  horsePlate: horsePlateSchema,
  provider: z.string().trim().max(80).default(""),
  username: z.string().trim().max(160).default(""),
  // senha omitida no update => preserva a atual (COALESCE no use-case).
  senha: z.string().min(1).max(200).optional(),
  notes: z.string().trim().max(500).optional(),
});

export const rastreadorCredentialRevealSchema = z.object({
  horsePlate: horsePlateSchema,
});
