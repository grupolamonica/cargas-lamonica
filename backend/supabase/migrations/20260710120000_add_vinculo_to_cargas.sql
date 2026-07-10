-- Vínculo do motorista (coluna "VÍNCULO" da planilha, ex.: AGREGADO DEDICADO,
-- TERCEIRO, PME, FROTA…) editável no Monitor e espelhável de volta na planilha.
--
-- Guardamos só o override do operador (alloc_vinculo); o valor que vem da
-- planilha continua fluindo pelo snapshot do Monitor (parse da coluna H), sem
-- precisar de coluna sheet_* nem mexer no upsert do sync. Efetivo exibido/
-- espelhado = alloc_vinculo (override) ?? vínculo da planilha (snapshot).
-- Aditiva/nullable, idempotente.

ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS alloc_vinculo TEXT;
