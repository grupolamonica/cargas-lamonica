/**
 * Format a number as Brazilian Real currency.
 */
export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return "R$ —";
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

/**
 * Build total payment value combining valor + bonus.
 * Returns null when neither value is a finite number.
 */
export function buildTotalPayment(valor: number | null | undefined, bonus: number | null | undefined): number | null {
  const hasValor = typeof valor === "number" && Number.isFinite(valor);
  const hasBonus = typeof bonus === "number" && Number.isFinite(bonus);

  if (!hasValor && !hasBonus) {
    return null;
  }

  return (hasValor ? valor : 0) + (hasBonus ? bonus : 0);
}
