"""Cliente Supabase/PostgREST fake para os testes do coletor Nestlé.

Emula o que o coletor usa de verdade e o que importa para a guarda anti no-op:
  - `table(t).select(cols)[.in_/.eq/.neq][.order()][.range(a,b)].execute()`
  - `table(t).upsert(rows, on_conflict=..., ignore_duplicates=False).execute()`
  - `table(t).insert(row).execute()`
  - teto de 1000 linhas quando o select NÃO pagina (comportamento real do PostgREST);
  - upsert = `ON CONFLICT DO UPDATE` só das chaves enviadas (colunas ausentes do
    payload sobrevivem — ex.: `idcargas`, `created_at`);
  - tipagem de volta como o PostgREST devolve: `numeric` integral volta como int,
    coluna `text` volta como string.

Toda execução entra em `client.calls`, que é o proxy de egresso usado nas asserções
(quantos SELECTs, quantos UPSERTs, quantas linhas).
"""

from __future__ import annotations

TETO_POSTGREST = 1000


class TabelaSpec:
    def __init__(self, pk: str, numeric_cols=(), text_cols=()):
        self.pk = pk
        self.numeric_cols = set(numeric_cols)
        self.text_cols = set(text_cols)


class FakeQuery:
    def __init__(self, client: "FakeSupabase", tabela: str):
        self._c = client
        self._t = tabela
        self._op = None
        self._cols = "*"
        self._payload = None
        self._filtros = []
        self._order = None
        self._range = None

    # ── leitura ──
    def select(self, cols="*", **_k):
        self._op = "select"
        self._cols = cols
        return self

    def order(self, col, desc=False, **_k):
        self._order = (col, desc)
        return self

    def range(self, ini, fim):
        self._range = (ini, fim)
        return self

    def in_(self, col, vals):
        self._filtros.append(("in", col, list(vals)))
        return self

    def eq(self, col, val):
        self._filtros.append(("eq", col, val))
        return self

    def neq(self, col, val):
        self._filtros.append(("neq", col, val))
        return self

    # ── escrita ──
    def upsert(self, rows, on_conflict=None, ignore_duplicates=False, **_k):
        self._op = "upsert"
        self._payload = list(rows)
        self._on_conflict = on_conflict
        return self

    def insert(self, row, **_k):
        self._op = "insert"
        self._payload = [row] if isinstance(row, dict) else list(row)
        return self

    # ── execução ──
    def execute(self):
        if self._op == "select":
            return self._exec_select()
        if self._op == "upsert":
            return self._exec_upsert()
        if self._op == "insert":
            return self._exec_insert()
        raise AssertionError(f"operação não suportada: {self._op}")

    def _exec_select(self):
        spec = self._c.spec(self._t)
        linhas = list(self._c.store.setdefault(self._t, {}).values())
        for tipo, col, val in self._filtros:
            if tipo == "in":
                linhas = [r for r in linhas if r.get(col) in val]
            elif tipo == "eq":
                linhas = [r for r in linhas if r.get(col) == val]
            elif tipo == "neq":
                # PostgREST serializa neq(col, None) como `col=neq.None`: NULL some
                # (NULL <> 'None' → NULL) e o literal 'None' também.
                alvo = "None" if val is None else val
                linhas = [r for r in linhas if r.get(col) is not None and r.get(col) != alvo]
        if self._order:
            col, desc = self._order
            linhas.sort(key=lambda r: (r.get(col) is None, r.get(col)), reverse=desc)
        if self._range:
            ini, fim = self._range
            linhas = linhas[ini:fim + 1]
        else:
            linhas = linhas[:TETO_POSTGREST]  # teto default do PostgREST
        cols = None if self._cols in ("*", None) else [c.strip() for c in self._cols.split(",")]
        dados = [self._projetar(r, cols, spec) for r in linhas]
        self._c.calls.append({"table": self._t, "op": "select", "cols": self._cols, "rows": len(dados), "range": self._range})
        return FakeResponse(dados)

    def _projetar(self, row, cols, spec):
        alvo = cols if cols else list(row)
        out = {}
        for c in alvo:
            v = row.get(c)
            if v is not None and c in spec.numeric_cols:
                f = float(v)
                v = int(f) if f.is_integer() else f  # PostgREST devolve numeric integral como int
            elif v is not None and c in spec.text_cols:
                v = str(v)
            out[c] = v
        return out

    def _exec_upsert(self):
        spec = self._c.spec(self._t)
        chaves = [r.get(spec.pk) for r in self._payload]
        if len(set(chaves)) != len(chaves):
            raise RuntimeError("21000: ON CONFLICT DO UPDATE command cannot affect row a second time")
        self._c.calls.append({"table": self._t, "op": "upsert", "rows": len(self._payload), "keys": list(chaves)})
        if self._c.on_upsert:
            self._c.on_upsert(self._t, self._payload)  # pode levantar (falha injetada)
        store = self._c.store.setdefault(self._t, {})
        for r in self._payload:
            k = str(r[spec.pk])
            atual = dict(store.get(k, {}))
            atual.update(r)  # DO UPDATE só das colunas enviadas
            for c in spec.text_cols:
                if atual.get(c) is not None:
                    atual[c] = str(atual[c])
            for c in spec.numeric_cols:
                if atual.get(c) is not None:
                    atual[c] = float(atual[c])
            store[k] = atual
            self._c.escritas[self._t] = self._c.escritas.get(self._t, 0) + 1
        return FakeResponse(None)

    def _exec_insert(self):
        self._c.calls.append({"table": self._t, "op": "insert", "rows": len(self._payload)})
        self._c.store.setdefault(self._t, {})
        return FakeResponse(None)


class FakeResponse:
    def __init__(self, data):
        self.data = data


class FakeSupabase:
    def __init__(self, specs: dict[str, TabelaSpec]):
        self._specs = specs
        self.store: dict[str, dict] = {t: {} for t in specs}
        self.calls: list[dict] = []
        self.escritas: dict[str, int] = {}
        self.on_upsert = None

    def spec(self, tabela) -> TabelaSpec:
        if tabela not in self._specs:
            self._specs[tabela] = TabelaSpec(pk="id")
        return self._specs[tabela]

    def table(self, tabela: str) -> FakeQuery:
        return FakeQuery(self, tabela)

    # ── helpers de asserção ──
    def zerar_calls(self):
        self.calls = []
        self.escritas = {}

    def selects(self, tabela=None):
        return [c for c in self.calls if c["op"] == "select" and (tabela is None or c["table"] == tabela)]

    def upserts(self, tabela=None):
        return [c for c in self.calls if c["op"] == "upsert" and (tabela is None or c["table"] == tabela)]

    def linhas_upsertadas(self, tabela=None):
        return sum(c["rows"] for c in self.upserts(tabela))
