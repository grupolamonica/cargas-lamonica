-- Repom (cadastro de motorista via WhatsApp) — definições de fluxo conversacional.
--
-- Base do futuro editor visual (estilo Blip): cada linha é um fluxo com um grafo
-- de nós/arestas em `definition` (JSONB). ADITIVA e IDEMPOTENTE — o sub-módulo
-- Repom está OFF: nenhum código consome esta tabela ainda.
--
-- Segurança: RLS ligada SEM policy permissiva = acesso somente via service_role
-- (o backend), negando anon/authenticated por padrão (dados sensíveis de cadastro).

CREATE TABLE IF NOT EXISTS public.repom_flows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  definition  jsonb NOT NULL DEFAULT '{"nodes": [], "edges": []}'::jsonb,
  version     integer NOT NULL DEFAULT 1,
  active      boolean NOT NULL DEFAULT false,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.repom_flows ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_repom_flows_active
  ON public.repom_flows (active) WHERE active = true;

COMMENT ON TABLE public.repom_flows IS
  'Repom: definições de fluxo conversacional de cadastro (editor visual). OFF por padrão.';
