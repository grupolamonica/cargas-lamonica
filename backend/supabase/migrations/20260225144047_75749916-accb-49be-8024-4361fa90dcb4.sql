
-- Tabela de clientes
CREATE TABLE public.clientes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  nome TEXT NOT NULL,
  peso TEXT,
  tipo_veiculo TEXT,
  valor_frete TEXT,
  rastreamento TEXT,
  forma_pagamento TEXT,
  antt TEXT,
  observacoes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Tabela de cargas
CREATE TABLE public.cargas (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_id UUID REFERENCES public.clientes(id) ON DELETE SET NULL,
  data DATE NOT NULL,
  horario TIME NOT NULL,
  origem TEXT NOT NULL,
  destino TEXT NOT NULL,
  perfil TEXT NOT NULL DEFAULT 'CARRETA',
  valor NUMERIC,
  status TEXT NOT NULL DEFAULT 'rascunho',
  is_template BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cargas ENABLE ROW LEVEL SECURITY;

-- Clientes: authenticated users can CRUD
CREATE POLICY "Authenticated users can view clientes" ON public.clientes FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert clientes" ON public.clientes FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update clientes" ON public.clientes FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete clientes" ON public.clientes FOR DELETE TO authenticated USING (true);

-- Cargas: authenticated users can CRUD
CREATE POLICY "Authenticated users can view cargas" ON public.cargas FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert cargas" ON public.cargas FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update cargas" ON public.cargas FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete cargas" ON public.cargas FOR DELETE TO authenticated USING (true);

-- Cargas ativas são públicas para motoristas (anon)
CREATE POLICY "Anyone can view active cargas" ON public.cargas FOR SELECT TO anon USING (status = 'ativa' AND is_template = false);

-- Clientes visíveis para anon quando vinculados a cargas ativas
CREATE POLICY "Anyone can view clientes of active cargas" ON public.clientes FOR SELECT TO anon USING (
  EXISTS (SELECT 1 FROM public.cargas WHERE cargas.cliente_id = clientes.id AND cargas.status = 'ativa' AND cargas.is_template = false)
);

-- Enable realtime for cargas
ALTER PUBLICATION supabase_realtime ADD TABLE public.cargas;
