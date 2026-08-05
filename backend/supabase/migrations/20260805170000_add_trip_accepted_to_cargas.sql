-- Marcador de ACEITE da viagem na carga lançada.
--
-- "Aceita" (SPX acceptance_status=1, ou Nestlé na aba Aceito) é hoje um estado AO
-- VIVO do sidecar: não existe em lugar nenhum do banco. O `accepted` que a
-- Programação manda no lançamento governava SÓ o write-back da linha-casca na
-- planilha (`launch-cargo-from-trip.js`) e era descartado logo em seguida — o
-- INSERT em `public.cargas` acontece antes dele, incondicionalmente.
--
-- Consequência medida em 05/08/2026: 94 cargas lançadas visíveis no Monitor (93%
-- de tudo que a fonte SISTEMA entrega) e 72 delas nunca aceitas por ninguém — o
-- operador pedia que a lançada não-aceita saísse da tela e o read model não tinha
-- como distinguir "ninguém aceitou" de "aceita, esperando motorista". As duas
-- precisam de tratamento OPOSTO: a primeira sai do Monitor, a segunda é frete
-- comprometido com a agência e TEM de continuar visível.
--
-- Escrito em dois pontos: no lançamento (`launch-cargo-from-trip.js`, quando
-- `accepted`) e no aceite posterior (`accept-aspx-trips.js`, que cobre o caso
-- DC-201 "lançou spot não-aceito, aceitou depois"). Nunca é LIMPO: relançar uma
-- viagem já aceita não pode desfazer o aceite.
--
-- Backfill conservador: carga lançada cujo LH já existe como linha da planilha
-- (`sheet_lh`) só pode ter chegado lá pela linha-casca, que por sua vez só é
-- escrita quando a viagem está aceita. É o único sinal retroativo confiável —
-- em 05/08/2026 ele casa 0 das 94 lançadas visíveis, confirmando que nenhuma
-- delas havia sido aceita. As demais ficam NULL (= aceite desconhecido) e são
-- protegidas pelas guardas do read model (motorista, status operacional, ciclo
-- ≠ OPEN, lead vivo na fila).
--
-- Aditiva: sem DEFAULT, sem NOT NULL, sem índice.

ALTER TABLE public.cargas
  ADD COLUMN IF NOT EXISTS trip_accepted_at timestamptz;

COMMENT ON COLUMN public.cargas.trip_accepted_at IS
  'Quando a VIAGEM desta carga lançada foi aceita (SPX acceptance_status=1 / Nestlé aba Aceito). NULL = nunca aceita ou aceite desconhecido. Não é reserva de motorista — para isso ver reserved_* / load_public_leads.';

UPDATE public.cargas c
   SET trip_accepted_at = COALESCE(c.updated_at, c.created_at, now())
 WHERE c.trip_accepted_at IS NULL
   AND c.lh_manual IS NOT NULL
   AND c.sheet_lh IS NULL
   AND EXISTS (SELECT 1 FROM public.cargas t WHERE t.sheet_lh = c.lh_manual);
