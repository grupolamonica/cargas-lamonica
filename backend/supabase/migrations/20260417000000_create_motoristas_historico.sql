-- Tabela de motoristas validados pelo Angellira (import histórico).
-- Chave natural: CPF normalizado (só dígitos).
-- Inclui resultado do lookup ASPX (planilha Shopee) feito pelo mesmo fluxo da candidatura.

CREATE TABLE public.motoristas_historico (
  cpf              TEXT PRIMARY KEY,           -- CPF normalizado, só dígitos
  nome             TEXT NOT NULL,
  cnh              TEXT,
  cnh_validade     DATE,
  cnh_categoria    TEXT,
  cnh_security     TEXT,                       -- código de segurança da CNH digital
  rg               TEXT,
  telefone         TEXT,
  nascimento       DATE,
  driver_kind      TEXT,                       -- AGR | AUT | FUN | OUT
  estado           TEXT,
  cidade           TEXT,
  angellira_query_id   INTEGER,
  angellira_sent_date  TIMESTAMPTZ,
  angellira_limit_date TIMESTAMPTZ,
  raw_json         JSONB,                      -- registro completo do Angellira
  aspx_found       BOOLEAN NOT NULL DEFAULT FALSE,
  aspx_display_name TEXT,                      -- nome retornado pela planilha ASPX
  aspx_matched_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_motoristas_historico_nome
  ON public.motoristas_historico (nome);

CREATE INDEX idx_motoristas_historico_aspx
  ON public.motoristas_historico (aspx_found)
  WHERE aspx_found = TRUE;

CREATE INDEX idx_motoristas_historico_driver_kind
  ON public.motoristas_historico (driver_kind);
