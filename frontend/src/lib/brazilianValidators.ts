const VALID_DDD_SET = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

const OLD_PLATE_PATTERN = /^[A-Z]{3}[0-9]{4}$/;
const MERCOSUL_PLATE_PATTERN = /^[A-Z]{3}[0-9][A-Z][0-9]{2}$/;

export function onlyDigits(value: string | null | undefined): string {
  return String(value || "").replace(/\D/g, "");
}

export function isValidCpf(raw: string | null | undefined): boolean {
  const digits = onlyDigits(raw);
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    sum += Number(digits[i]) * (10 - i);
  }
  let check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  if (check !== Number(digits[9])) return false;

  sum = 0;
  for (let i = 0; i < 10; i += 1) {
    sum += Number(digits[i]) * (11 - i);
  }
  check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  return check === Number(digits[10]);
}

export function isValidBrazilianPhone(raw: string | null | undefined): boolean {
  const digits = onlyDigits(raw);
  if (digits.length !== 10 && digits.length !== 11) return false;
  const ddd = Number(digits.slice(0, 2));
  if (!VALID_DDD_SET.has(ddd)) return false;
  if (digits.length === 11 && digits[2] !== "9") return false;
  return true;
}

export function normalizePlateValue(raw: string | null | undefined): string {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isValidPlate(raw: string | null | undefined): boolean {
  const normalized = normalizePlateValue(raw);
  if (normalized.length !== 7) return false;
  return OLD_PLATE_PATTERN.test(normalized) || MERCOSUL_PLATE_PATTERN.test(normalized);
}

export function isValidCnpj(raw: string | null | undefined): boolean {
  const digits = onlyDigits(raw);
  if (digits.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false;

  const calcDigit = (slice: string, weights: number[]) => {
    let sum = 0;
    for (let i = 0; i < weights.length; i += 1) {
      sum += Number(slice[i]) * weights[i];
    }
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };

  const weights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const weights2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  const dv1 = calcDigit(digits.slice(0, 12), weights1);
  if (dv1 !== Number(digits[12])) return false;
  const dv2 = calcDigit(digits.slice(0, 13), weights2);
  return dv2 === Number(digits[13]);
}

export function isValidPis(raw: string | null | undefined): boolean {
  const digits = onlyDigits(raw);
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;

  const weights = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    sum += Number(digits[i]) * weights[i];
  }
  const remainder = sum % 11;
  const expectedDv = remainder < 2 ? 0 : 11 - remainder;
  return expectedDv === Number(digits[10]);
}
