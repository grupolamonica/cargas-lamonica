// Validacoes de campos sensiveis com checksum real (CPF/CNPJ).
// Convencao: empty -> {valid: true} (deixa o "required" do HTML cuidar disso).
// Assim os erros so aparecem quando o usuario digita algo errado.

export type ValidationResult = { valid: boolean; reason?: string };

const onlyDigits = (s: string) => s.replace(/\D/g, "");
const ok: ValidationResult = { valid: true };

// ─────────────────────────── CPF ───────────────────────────
// Algoritmo oficial da Receita Federal: 2 digitos verificadores
// (mod 11 com pesos decrescentes).
export function validateCpf(value: string): ValidationResult {
  const d = onlyDigits(value);
  if (!d) return ok;
  if (d.length !== 11) return { valid: false, reason: "CPF deve ter 11 digitos" };
  if (/^(\d)\1{10}$/.test(d)) return { valid: false, reason: "CPF invalido" };

  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(d[i], 10) * (10 - i);
  let check = (sum * 10) % 11;
  if (check === 10) check = 0;
  if (check !== parseInt(d[9], 10)) return { valid: false, reason: "CPF invalido" };

  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(d[i], 10) * (11 - i);
  check = (sum * 10) % 11;
  if (check === 10) check = 0;
  if (check !== parseInt(d[10], 10)) return { valid: false, reason: "CPF invalido" };

  return ok;
}

// ─────────────────────────── CNPJ ───────────────────────────
// Algoritmo oficial: pesos diferentes para os 2 digitos verificadores.
export function validateCnpj(value: string): ValidationResult {
  const d = onlyDigits(value);
  if (!d) return ok;
  if (d.length !== 14) return { valid: false, reason: "CNPJ deve ter 14 digitos" };
  if (/^(\d)\1{13}$/.test(d)) return { valid: false, reason: "CNPJ invalido" };

  const weights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const weights2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  const calc = (length: number, weights: number[]) => {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += parseInt(d[i], 10) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };

  if (calc(12, weights1) !== parseInt(d[12], 10)) {
    return { valid: false, reason: "CNPJ invalido" };
  }
  if (calc(13, weights2) !== parseInt(d[13], 10)) {
    return { valid: false, reason: "CNPJ invalido" };
  }
  return ok;
}

// ─────────────────────────── Placa ───────────────────────────
// Mercosul: AAA0A00. Antiga: AAA0000.
export function validatePlaca(value: string): ValidationResult {
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return ok;
  if (cleaned.length !== 7) {
    return { valid: false, reason: "Placa deve ter 7 caracteres" };
  }
  const mercosul = /^[A-Z]{3}\d[A-Z]\d{2}$/;
  const antiga = /^[A-Z]{3}\d{4}$/;
  if (!mercosul.test(cleaned) && !antiga.test(cleaned)) {
    return { valid: false, reason: "Formato invalido (AAA0A00 ou AAA0000)" };
  }
  return ok;
}

// ─────────────────────────── Chassi (VIN) ───────────────────────────
// 17 caracteres alfanumericos. Letras I, O, Q sao proibidas no VIN
// (ISO 3779) para evitar confusao com 1 e 0.
export function validateChassi(value: string): ValidationResult {
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return ok;
  if (cleaned.length !== 17) {
    return { valid: false, reason: "Chassi deve ter 17 caracteres" };
  }
  if (/[IOQ]/.test(cleaned)) {
    return { valid: false, reason: "Chassi nao pode conter I, O ou Q" };
  }
  if (/^(.)\1{16}$/.test(cleaned)) {
    return { valid: false, reason: "Chassi invalido" };
  }
  return ok;
}

// ─────────────────────────── Renavam ───────────────────────────
// 9 a 11 digitos. CRLVs antigos tinham 9, novos tem 11.
export function validateRenavam(value: string): ValidationResult {
  const d = onlyDigits(value);
  if (!d) return ok;
  if (d.length < 9 || d.length > 11) {
    return { valid: false, reason: "Renavam deve ter 9 a 11 digitos" };
  }
  return ok;
}

// ─────────────────────────── CEP ───────────────────────────
export function validateCep(value: string): ValidationResult {
  const d = onlyDigits(value);
  if (!d) return ok;
  if (d.length !== 8) return { valid: false, reason: "CEP deve ter 8 digitos" };
  return ok;
}

// ─────────────────────────── Email ───────────────────────────
export function validateEmail(value: string): ValidationResult {
  if (!value) return ok;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!re.test(value)) return { valid: false, reason: "Email invalido" };
  return ok;
}

// ─────────────────────────── CNH (registro) ───────────────────────────
// 11 digitos numericos.
export function validateCnhRegistro(value: string): ValidationResult {
  const d = onlyDigits(value);
  if (!d) return ok;
  if (d.length !== 11) {
    return { valid: false, reason: "Registro CNH deve ter 11 digitos" };
  }
  return ok;
}

// ─────────────────────────── Telefone ───────────────────────────
// 10 (fixo com DDD) ou 11 digitos (movel com DDD).
export function validateTelefone(value: string): ValidationResult {
  const d = onlyDigits(value);
  if (!d) return ok;
  if (d.length !== 10 && d.length !== 11) {
    return { valid: false, reason: "Telefone deve ter 10 ou 11 digitos" };
  }
  return ok;
}

// ─────────────────────────── PIS / PASEP / NIS / NIT ───────────────────────────
// 11 digitos com 1 digito verificador (algoritmo mod 11 com pesos 3..2).
export function validatePis(value: string): ValidationResult {
  const d = onlyDigits(value);
  if (!d) return ok;
  if (d.length !== 11) return { valid: false, reason: "PIS deve ter 11 digitos" };
  if (/^(\d)\1{10}$/.test(d)) return { valid: false, reason: "PIS invalido" };
  const weights = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(d[i], 10) * weights[i];
  const r = sum % 11;
  const check = r < 2 ? 0 : 11 - r;
  if (check !== parseInt(d[10], 10)) return { valid: false, reason: "PIS invalido" };
  return ok;
}
