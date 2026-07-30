-- Verdito manual do checklist do veículo, por slot (cavalo / carreta), feito pelo
-- operador no modal da carga do Monitor: "Aprovado" / "Reprovado" (ou NULL = sem
-- verdito). Segue o padrão de override do operador (alloc_*): o sync da planilha
-- nunca toca alloc_*, então o verdito sobrevive a cada sincronização. O write-back
-- espelha o verdito nas colunas "CheckList Cavalo" / "CheckList Carreta1" da planilha
-- Lamonica-Shopee (por LH), quando o write-back está ligado.
-- Aditivas e idempotentes (ADD COLUMN IF NOT EXISTS) — retrocompatíveis, NULL = "sem
-- verdito registrado".
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS alloc_checklist_cavalo TEXT;
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS alloc_checklist_carreta TEXT;
