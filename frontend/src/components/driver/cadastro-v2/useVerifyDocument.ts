import { useCallback, useEffect, useRef, useState } from "react";

import {
  verifyDocument,
  type VerifyDocumentPayload,
  type VerifyDocumentResponse,
} from "@/api/candidaturaApi";

/**
 * Hook compartilhado pelos steps do wizard cadastro-v2 para verificar
 * duplicidade de CPF/placa via `POST /api/candidatura/verify-document` (plan
 * 08-20 backend, 08-21 frontend — Bug B / Phase 8).
 *
 * Comportamento (locked):
 *  - Disparo apenas quando `value` muda E é diferente de `initialValue`
 *    (normalizado).
 *  - `isValid(value)` precisa retornar true antes de bater na API.
 *  - Debounce de 300ms para evitar requests durante digitação contínua / blur
 *    repetido.
 *  - Resposta degradada (exists:false) em 429/422/network — não bloqueia o
 *    motorista.
 *  - O usuário pode "dispensar" o warning manualmente; enquanto dismissed=true
 *    o warning não volta até `value` mudar novamente.
 *
 * Não é uma mutation TanStack porque queremos:
 *  - chamadas idempotentes silenciosas (sem cache global);
 *  - cleanup automático no unmount do step;
 *  - estado local de dismissal por step.
 */

export interface UseVerifyDocumentOptions {
  /** Tipo do documento a verificar. */
  type: VerifyDocumentPayload["type"];
  /** Valor corrente (CPF mascarado ou bruto, placa em qualquer formato). */
  value: string;
  /** Valor original do pre-check (não dispara verificação se igual). */
  initialValue: string;
  /** Validador específico (isValidCpf, isValidPlate, etc.). */
  isValid: (raw: string) => boolean;
  /** Normalizador para comparar `value` x `initialValue` (digitos / uppercase). */
  normalize: (raw: string) => string;
  /** Debounce em ms — default 300. */
  debounceMs?: number;
}

export interface UseVerifyDocumentState {
  /** Resposta crua do backend quando o documento existe. */
  result: VerifyDocumentResponse | null;
  /** Requisição em curso. */
  isPending: boolean;
  /** Mostra o warning de duplicidade. */
  shouldWarn: boolean;
  /** Dispensa o warning até `value` mudar novamente. */
  dismiss: () => void;
}

export function useVerifyDocument({
  type,
  value,
  initialValue,
  isValid,
  normalize,
  debounceMs = 300,
}: UseVerifyDocumentOptions): UseVerifyDocumentState {
  const [result, setResult] = useState<VerifyDocumentResponse | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const lastQueriedRef = useRef<string | null>(null);

  const normalizedValue = normalize(value);
  const normalizedInitial = normalize(initialValue);
  const isDifferentFromInitial =
    normalizedValue.length > 0 && normalizedValue !== normalizedInitial;
  const isValueValid = isValid(value);

  useEffect(() => {
    // Reset quando o valor não justifica mais consultar.
    if (!isValueValid || !isDifferentFromInitial) {
      if (lastQueriedRef.current !== null) {
        lastQueriedRef.current = null;
        setResult(null);
      }
      return;
    }

    // Mesmo valor já consultado — não refaz request, mas mantém result anterior.
    if (lastQueriedRef.current === normalizedValue) {
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setIsPending(true);
      void verifyDocument({ type, value: normalizedValue } as VerifyDocumentPayload)
        .then((response) => {
          if (cancelled) return;
          lastQueriedRef.current = normalizedValue;
          setResult(response.exists ? response : null);
        })
        .finally(() => {
          if (!cancelled) setIsPending(false);
        });
    }, debounceMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [type, normalizedValue, isValueValid, isDifferentFromInitial, debounceMs]);

  const dismiss = useCallback(() => {
    setDismissedKey(normalizedValue);
  }, [normalizedValue]);

  const shouldWarn = Boolean(
    result?.exists &&
      isValueValid &&
      isDifferentFromInitial &&
      dismissedKey !== normalizedValue,
  );

  return { result, isPending, shouldWarn, dismiss };
}
