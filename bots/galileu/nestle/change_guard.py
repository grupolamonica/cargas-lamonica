"""Guarda anti no-op para os upserts do coletor Nestlé (perf: escrita/egresso).

PROBLEMA. O loop do `galileu-bot` roda a cada `NESTLE_COLETA_INTERVAL_SEC` (120s em
produção) e reescrevia TODA linha não-final de `nestle_ofertas` e TODA linha do lote de
`nestle_embarques` a cada ciclo, sem comparar conteúdo. `ON CONFLICT DO UPDATE` sem
`WHERE` grava uma nova versão de heap + atualiza todos os índices + gera WAL mesmo
quando a linha é byte-idêntica → dead tuples, bloat, autovacuum e CPU no Postgres, além
do payload de ida e do echo de volta (PostgREST responde `return=representation`).

SOLUÇÃO. Mesmo guard "Anti no-op" que o sync da planilha já usa no backend
(`backend/src/application/google-sheets/google-sheet-loads.js` — "só reescreve quando
algo MUDOU"), aqui do lado do cliente porque o coletor fala só PostgREST (não há
psycopg no sidecar, então não há como escrever `WHERE ... IS DISTINCT FROM EXCLUDED`).

Mantemos em processo um espelho `{chave: digest}` do que o banco contém. Só entra no
upsert a linha nova ou cuja digest mudou. O espelho é alimentado por duas fontes, as
duas confiáveis:
  1. um SNAPSHOT (`SELECT` das colunas comparadas, paginado e ordenado) tirado no
     cold start e re-tirado quando o espelho passa de `ttl_env` segundos;
  2. as próprias gravações do coletor, registradas SÓ depois do upsert responder OK.

O coletor é o ÚNICO escritor destas tabelas (o backend apenas lê — `get-programacao.js`
e `launch-cargo-from-trip.js`), então o espelho é um modelo fiel do estado da tabela e o
estado final gravado é idêntico ao do upsert cego.

FAIL-SAFE (na dúvida, grava):
  - lote que falha é retirado do espelho → volta a ser enviado no ciclo seguinte;
  - snapshot que estoura exceção NÃO é cacheado (o espelho anterior é preservado e o
    snapshot é tentado de novo no próximo ciclo);
  - espelho vazio ⇒ grava tudo (comportamento original);
  - `NESTLE_UPSERT_GUARD_ENABLED=false` desliga a guarda inteira (kill-switch).

Divergência só é possível se alguém editar as tabelas à mão no banco; nesse caso o
próximo snapshot (≤ TTL) reconcilia.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time

# Teto de linhas por resposta do PostgREST/Supabase (memory: postgrest_1000_row_cap).
_PAGINA = 1000

_ESPELHOS: list["UpsertMirror"] = []


def _canon_texto(v):
    """Colunas `text`: compara o valor CRU (o payload do coletor já vem `.strip()`ado).
    Não normalizamos o lado do banco — se o banco tem ' X ' e o coletor manda 'X', a
    diferença deve gerar UMA reescrita (converge), não ser mascarada."""
    if v is None:
        return None
    return v if isinstance(v, str) else str(v)


def _canon_numerico(v):
    """Colunas `numeric`: o PostgREST devolve `1234` (int) para o que o coletor mandou
    como `1234.0` (float). Sem canonizar, TODA linha com numérico pareceria mudada."""
    if v is None or v == "":
        return None
    try:
        return repr(float(v))
    except (TypeError, ValueError):
        return None


def _canon_bool(v):
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("t", "true", "1", "s", "sim", "y", "yes"):
        return True
    if s in ("f", "false", "0", "n", "nao", "não", "no"):
        return False
    return None


def _guarda_habilitada() -> bool:
    """Kill-switch de produção. Desligada ⇒ comportamento original (grava tudo)."""
    raw = (os.getenv("NESTLE_UPSERT_GUARD_ENABLED") or "").strip().lower()
    return raw not in ("0", "false", "off", "no", "nao", "não")


class UpsertMirror:
    """Espelho `{chave: digest}` de uma tabela, para filtrar upserts no-op.

    `colunas_*` devem ser EXATAMENTE as colunas que o mapeador do robô escreve —
    nem mais, nem menos:
      - coluna escrita e fora da comparação ⇒ mudança nela nunca é gravada (campo
        congela na tela);
      - coluna comparada e não escrita (ex.: `created_at`, `atualizado_em`) ⇒ o
        espelho nunca casa e a guarda vira no-op.
    `colunas_projetadas` são valores guardados junto da digest para reuso entre etapas
    (ver `robo_coleta.codembarques_conhecidos`).
    """

    def __init__(
        self,
        *,
        tabela: str,
        chave: str,
        colunas_texto=(),
        colunas_numericas=(),
        colunas_bool=(),
        colunas_projetadas=(),
        ttl_env: str,
        ttl_default_sec: int = 3600,
    ):
        self.tabela = tabela
        self.chave = chave
        self._canonizadores = {}
        for c in colunas_texto:
            self._canonizadores[c] = _canon_texto
        for c in colunas_numericas:
            self._canonizadores[c] = _canon_numerico
        for c in colunas_bool:
            self._canonizadores[c] = _canon_bool
        self.colunas_comparadas = tuple(sorted(self._canonizadores))
        self.colunas_projetadas = tuple(colunas_projetadas)
        self._ttl_env = ttl_env
        self._ttl_default_sec = ttl_default_sec
        self._lock = threading.Lock()
        self._digests: dict[str, str] = {}
        self._projecao: dict[str, tuple] = {}
        self._semeado_em: float | None = None
        self.snapshots = 0  # contador p/ observabilidade e testes
        _ESPELHOS.append(self)

    # ── knobs ────────────────────────────────────────────────────────────────
    def ttl_sec(self) -> int:
        """TTL do snapshot. Override explícito vence (habilita teste); 0 = re-tira o
        snapshot todo ciclo (modo mais conservador)."""
        raw = os.getenv(self._ttl_env)
        if raw not in (None, ""):
            try:
                v = int(raw)
                if v >= 0:
                    return v
            except ValueError:
                pass
        return self._ttl_default_sec

    @property
    def habilitado(self) -> bool:
        return _guarda_habilitada()

    @property
    def semeado(self) -> bool:
        """True só depois de um snapshot completo. A projeção só é confiável nesse
        caso (senão ela cobriria apenas o que ESTE processo gravou)."""
        return self._semeado_em is not None

    def reset(self) -> None:
        with self._lock:
            self._digests = {}
            self._projecao = {}
            self._semeado_em = None
            self.snapshots = 0

    # ── digest ───────────────────────────────────────────────────────────────
    def digest(self, row: dict) -> str:
        canon = {c: fn(row.get(c)) for c, fn in self._canonizadores.items()}
        # sort_keys OBRIGATÓRIO: os mapeadores montam o dict iterando SETS
        # (CAMPOS_TEXT/TIMESTAMP/...), cuja ordem muda entre processos por causa da
        # randomização de hash de string. Sem isso a digest mudaria a cada restart.
        bruto = json.dumps(canon, sort_keys=True, ensure_ascii=False, default=str)
        return hashlib.sha256(bruto.encode("utf-8")).hexdigest()

    # ── snapshot ─────────────────────────────────────────────────────────────
    def sincronizar(self, db) -> bool:
        """Semeia/re-verifica o espelho contra o banco. Levanta a exceção do banco
        (o chamador loga); nesse caso o espelho anterior é preservado."""
        if not self.habilitado:
            return False
        ttl = self.ttl_sec()
        if self.semeado and ttl > 0 and (time.monotonic() - self._semeado_em) < ttl:
            return True
        digests, projecao = self._snapshot(db)
        with self._lock:
            self._digests = digests
            self._projecao = projecao
            self._semeado_em = time.monotonic()
            self.snapshots += 1
        return True

    def _snapshot(self, db) -> tuple[dict, dict]:
        colunas = ",".join(dict.fromkeys((self.chave, *self.colunas_comparadas, *self.colunas_projetadas)))
        digests: dict[str, str] = {}
        projecao: dict[str, tuple] = {}
        offset = 0
        while True:
            # .order(chave): paginação sem ORDER BY sobre tabela sendo escrita pode
            # pular/duplicar linhas entre páginas.
            res = (
                db.table(self.tabela)
                .select(colunas)
                .order(self.chave)
                .range(offset, offset + _PAGINA - 1)
                .execute()
            )
            bloco = getattr(res, "data", None) or []
            for r in bloco:
                k = r.get(self.chave)
                if k in (None, ""):
                    continue
                k = str(k)
                digests[k] = self.digest(r)
                if self.colunas_projetadas:
                    projecao[k] = tuple(r.get(c) for c in self.colunas_projetadas)
            if len(bloco) < _PAGINA:
                break
            offset += _PAGINA
        return digests, projecao

    # ── diff ─────────────────────────────────────────────────────────────────
    def selecionar_mudancas(self, rows: list[dict]) -> list[dict]:
        """Subconjunto de `rows` que precisa ir ao banco (nova ou conteúdo mudou)."""
        if not self.habilitado:
            return list(rows)
        mudou = []
        for r in rows:
            k = r.get(self.chave)
            if k in (None, ""):
                mudou.append(r)  # sem chave: não dá para comparar → grava
                continue
            if self._digests.get(str(k)) != self.digest(r):
                mudou.append(r)
        return mudou

    def confirmar(self, rows: list[dict]) -> None:
        """Registra no espelho o que o banco ACEITOU (chamar só após upsert OK)."""
        if not self.habilitado:
            return
        with self._lock:
            for r in rows:
                k = r.get(self.chave)
                if k in (None, ""):
                    continue
                k = str(k)
                self._digests[k] = self.digest(r)
                if self.colunas_projetadas:
                    self._projecao[k] = tuple(r.get(c) for c in self.colunas_projetadas)

    def descartar(self, rows: list[dict]) -> None:
        """Esquece linhas cujo upsert falhou → reenviadas no próximo ciclo."""
        with self._lock:
            for r in rows:
                k = r.get(self.chave)
                if k in (None, ""):
                    continue
                self._digests.pop(str(k), None)
                self._projecao.pop(str(k), None)

    # ── projeção ─────────────────────────────────────────────────────────────
    def valores_projetados(self, coluna: str) -> set | None:
        """Valores não-vazios de `coluna` em todo o espelho, ou None se o espelho não
        foi semeado por snapshot (aí o conjunto NÃO cobriria a tabela inteira e quem
        depende dele precisa varrer o banco)."""
        if not self.habilitado or not self.semeado:
            return None
        i = self.colunas_projetadas.index(coluna)
        with self._lock:
            valores = [v[i] for v in self._projecao.values()]
        return {str(v).strip() for v in valores if v not in (None, "")}


def reset_upsert_mirrors() -> None:
    """Hook de teste: zera o estado de módulo de todos os espelhos."""
    for espelho in _ESPELHOS:
        espelho.reset()
