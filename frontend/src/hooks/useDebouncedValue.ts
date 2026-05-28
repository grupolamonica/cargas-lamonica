import { useEffect, useState } from "react";

/**
 * Trailing-edge debounce of a value.
 *
 * Atualiza o valor retornado apenas após `delayMs` sem mudanças. Útil para
 * fontes de input (busca, filtros) cujo consumidor (query/fetch) é caro.
 * Diferente de `useDeferredValue`, que apenas adia render: este atrasa a
 * propagação do valor — ideal para gatear chamadas de rede.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
}
