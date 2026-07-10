-- =============================================================================
-- ROLLBACK — janela 2026-07-10 (feat/rotas-multi-tarifa) — PROD (lbpzkdec)
-- =============================================================================
-- Reverte o que foi ALTERADO NO DADO do prod nesta janela: a limpeza das rotas
-- "N EIXOS". Restaura as 9 linhas originais (com os ids/valores exatos que
-- estavam no prod antes) e remove as tarifas limpas por eixo que foram criadas.
--
-- As MIGRATIONS foram ADITIVAS (colunas/constraint novas) — o código antigo as
-- ignora, então NÃO precisam ser revertidas para um rollback de código. Se
-- ainda assim quiser reverter o schema por completo, use a SEÇÃO 2 (comentada).
--
-- Rede extra: o Supabase mantém backup/PITR do projeto — é possível restaurar o
-- banco inteiro para um instante ANTES desta janela pelo dashboard.
--
-- COMO USAR: rodar a SEÇÃO 1 inteira (transação) no projeto lbpzkdec.
-- =============================================================================

-- ── SEÇÃO 1: reverter a limpeza de rotas (dado) ─────────────────────────────
BEGIN;

-- 1a) Remove as tarifas limpas por eixo criadas pela limpeza (5 trechos).
DELETE FROM public.route_metrics_cache
WHERE (origin_key, destination_key, perfil_padrao, eixos) IN (
  ('cordeiropolis/sp','feira de santana/ba','CARRETA',5),
  ('cordeiropolis/sp','feira de santana/ba','CARRETA',6),
  ('feira de santana/ba','jaboatao dos guararapes/pe','CARRETA',5),
  ('feira de santana/ba','jaboatao dos guararapes/pe','CARRETA',6),
  ('feira de santana/ba','maceio/al','CARRETA',5),
  ('feira de santana/ba','maceio/al','CARRETA',6),
  ('feira de santana/ba','cabo de santo agostinho/pe','CARRETA',5),
  ('simoes filho/ba','aracaju/se','CARRETA',5),
  ('simoes filho/ba','aracaju/se','CARRETA',6)
);

-- 1b) Restaura as 9 rotas "N EIXOS" originais (ids/valores exatos do prod).
INSERT INTO public.route_metrics_cache
  (id, origin_key, destination_key, origem, destino, perfil_padrao, eixos, valor_padrao, bonus_padrao, distancia_km, duracao_horas, tempo_estimado_horas, ativa)
VALUES
  ('88bb082c-a272-4696-84e3-06b1462cd811','cordeiropolis/sp','feira de santana/ba - 5 eixos','CORDEIRÓPOLIS/SP','FEIRA DE SANTANA/BA - 5 EIXOS','CARRETA',0,14000,NULL,1855,30,30,true),
  ('ed7471a7-7b23-4b37-afb6-62a42f165c44','cordeiropolis/sp','feira de santana/sp - 6 eixos','CORDEIRÓPOLIS/SP','FEIRA DE SANTANA/SP - 6 EIXOS','CARRETA',0,14670,NULL,1855,30,30,true),
  ('94e11443-f0a6-4231-9408-a3729585fd63','feira de santana/ba','cabo de santo agostinho/pe - 5 eixos','FEIRA DE SANTANA/BA','CABO DE SANTO AGOSTINHO/PE - 5 EIXOS','CARRETA',0,NULL,NULL,784.33,8.77,NULL,true),
  ('06ac8576-a0f2-4caa-b3a9-cb5d2b979076','feira de santana/ba','jaboatao dos guararapes/pe - 6 eixos','FEIRA DE SANTANA/BA','JABOATÃO DOS GUARARAPES/PE  - 6 EIXOS','CARRETA',0,6450,NULL,780,16,16,true),
  ('187d91b4-1464-4e08-8526-e026604d635a','feira de santana/ba','jaboatao dos guararapes/pe - 5 eixos','FEIRA DE SANTANA/BA','JABOATÃO DOS GUARARAPES/PE - 5 EIXOS','CARRETA',0,5900,NULL,780,16,16,true),
  ('6576aada-ef61-4603-9a71-6935a45f638c','feira de santana/ba','maceio/al - 5 eixos','FEIRA DE SANTANA/BA','MACEIÓ/AL - 5 EIXOS','CARRETA',0,4900,NULL,580,12,12,true),
  ('9697826e-5409-49de-8c18-b75880121dd4','feira de santana/ba','maceio/al - 6 eixos','FEIRA DE SANTANA/BA','MACEIÓ/AL - 6 EIXOS','CARRETA',0,5000,NULL,580,12,12,true),
  ('8be79a7b-43fe-4e82-a7a0-e38b178c64b6','simoes filho/ba','aracaju/se - 5 eixos','SIMOES FILHO/BA','ARACAJU/SE - 5 EIXOS','CARRETA',0,2200,200,297.77,3.58,3.58,true),
  ('f6f894b5-ffd4-4d91-bd08-b5aef2074889','simoes filho/ba','aracaju/se - 6 eixos','SIMÕES FILHO/BA','ARACAJU/SE - 6 EIXOS','CARRETA',0,2400,200,425.81,5.52,5.52,true)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- ── SEÇÃO 2 (OPCIONAL): reverter as migrations aditivas ─────────────────────
-- Só se quiser reverter o SCHEMA por completo. Não é necessário para rollback
-- de código (o código antigo ignora estas colunas). Descomentar para usar.
--
-- BEGIN;
--   DROP INDEX IF EXISTS public.idx_cargas_codigo_viagem;
--   ALTER TABLE public.cargas DROP COLUMN IF EXISTS codigo_viagem;
--
--   ALTER TABLE public.rota_tarifas DROP CONSTRAINT IF EXISTS rota_tarifas_rota_veiculo_eixos_unique;
--   DROP INDEX IF EXISTS public.idx_rota_tarifas_perfil_eixos;
--   ALTER TABLE public.rota_tarifas DROP COLUMN IF EXISTS eixos;
--   ALTER TABLE public.rota_tarifas ADD CONSTRAINT rota_tarifas_rota_veiculo_unique UNIQUE (rota_id, tipo_veiculo);
--   -- (as views v_rotas_com_tarifas / v_clientes_com_rotas continuam válidas com eixos;
--   --  se quiser a versão pré-eixos, recriar a partir da migration 20260508000002.)
-- COMMIT;
