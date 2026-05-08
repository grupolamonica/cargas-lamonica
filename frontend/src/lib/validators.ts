// Validators com retorno { ok, reason } usados por CadastroDocumentos
// para erro inline por campo. Para checagens boolean puras (sem mensagem),
// use os helpers de @/lib/brazilianValidators.

import {
  MERCOSUL_PLATE_PATTERN,
  OLD_PLATE_PATTERN,
  isValidCpf,
  normalizePlateValue,
  onlyDigits,
} from "@/lib/brazilianValidators";

type ValidationResult = { ok: boolean; reason?: string };

export function validateCpf(raw: string | null | undefined): ValidationResult {
  const d = onlyDigits(raw);
  if (!d) return { ok: false, reason: "CPF obrigatorio" };
  if (d.length !== 11) return { ok: false, reason: "CPF deve ter 11 digitos" };
  if (!isValidCpf(d)) return { ok: false, reason: "CPF invalido" };
  return { ok: true };
}

export function validateCnpj(raw: string | null | undefined): ValidationResult {
  const d = onlyDigits(raw);
  if (!d) return { ok: false, reason: "CNPJ obrigatorio" };
  if (d.length !== 14) return { ok: false, reason: "CNPJ deve ter 14 digitos" };
  if (/^(\d)\1{13}$/.test(d)) return { ok: false, reason: "CNPJ invalido" };
  const calc = (weights: number[]) => {
    const sum = weights.reduce((acc, w, i) => acc + Number(d[i]) * w, 0);
    const rem = sum % 11;
    return rem < 2 ? 0 : 11 - rem;
  };
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  if (calc(w1) !== Number(d[12])) return { ok: false, reason: "CNPJ invalido" };
  if (calc(w2) !== Number(d[13])) return { ok: false, reason: "CNPJ invalido" };
  return { ok: true };
}

export function validateTelefone(raw: string | null | undefined): ValidationResult {
  if (!raw || raw.trim() === "") return { ok: true };
  const d = onlyDigits(raw);
  if (d.length < 10 || d.length > 11) return { ok: false, reason: "Telefone invalido (10 ou 11 digitos)" };
  return { ok: true };
}

export function validateCep(raw: string | null | undefined): ValidationResult {
  const d = onlyDigits(raw);
  if (!d) return { ok: false, reason: "CEP obrigatorio" };
  if (d.length !== 8) return { ok: false, reason: "CEP deve ter 8 digitos" };
  return { ok: true };
}

export function validatePlaca(raw: string | null | undefined): ValidationResult {
  const n = normalizePlateValue(raw);
  if (!n) return { ok: false, reason: "Placa obrigatoria" };
  if (n.length !== 7) return { ok: false, reason: "Placa deve ter 7 caracteres" };
  if (!OLD_PLATE_PATTERN.test(n) && !MERCOSUL_PLATE_PATTERN.test(n)) {
    return { ok: false, reason: "Placa invalida" };
  }
  return { ok: true };
}

export function validateRenavam(raw: string | null | undefined): ValidationResult {
  const d = onlyDigits(raw);
  if (!d) return { ok: false, reason: "Renavam obrigatorio" };
  if (d.length < 9 || d.length > 11) return { ok: false, reason: "Renavam invalido" };
  return { ok: true };
}

export function validateChassi(raw: string | null | undefined): ValidationResult {
  const v = String(raw || "").trim().toUpperCase();
  if (!v) return { ok: false, reason: "Chassi obrigatorio" };
  if (v.length !== 17) return { ok: false, reason: "Chassi deve ter 17 caracteres" };
  return { ok: true };
}

export function validateCnhRegistro(raw: string | null | undefined): ValidationResult {
  const d = onlyDigits(raw);
  if (!d) return { ok: false, reason: "Registro CNH obrigatorio" };
  if (d.length < 9 || d.length > 11) return { ok: false, reason: "Registro CNH invalido" };
  return { ok: true };
}

export function validatePis(raw: string | null | undefined): ValidationResult {
  if (!raw || raw.trim() === "") return { ok: true };
  const d = onlyDigits(raw);
  if (d.length !== 11) return { ok: false, reason: "PIS/NIS deve ter 11 digitos" };
  return { ok: true };
}
