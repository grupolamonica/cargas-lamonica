"""Guarda anti no-op do robo_coleta: prova que um ciclo SEM mudança não escreve nada e
que o estado final da tabela é idêntico ao do upsert cego (comportamento preservado).

Proxy de egresso/escrita: contagem de UPSERTs e de linhas upsertadas no cliente fake.
"""

import pytest

from fake_supabase import FakeSupabase, TabelaSpec
from nestle import robo_coleta
from nestle.change_guard import reset_upsert_mirrors

OFERTAS = TabelaSpec(
    pk="codprogcoleta",
    numeric_cols=("totalcarga", "totalnumvol", "totalpeso", "totalvol", "totalnumpalete"),
    text_cols=(
        "codprogcoleta", "codembarque", "codcarga", "grupos_id", "descrstatprogcoleta",
        "senhaagendamento", "numciot", "tipo",
    ),
)


def _programacao(cod, status="PENDENTE", **over):
    """Payload cru do Galileo (como listarProgramacoes devolve)."""
    base = {
        "codprogcoleta": cod,
        "codembarque": over.pop("codembarque", f"E{cod}"),
        "codcarga": f"C{cod}",
        "grupos_id": f"B{cod}",
        "descrstatprogcoleta": status,
        "descrtpoper": "COLETA",
        "empembar_nome": "NESTLE",
        "empembar_nomeciduf": "CARAGUATATUBA/SP",
        "tpveic_nome": "CARRETA",
        "tpcarga_descr": "PALETIZADA",
        "empdest_nome": "CD RIO",
        "empdest_nomeciduf": "RIO DE JANEIRO/RJ",
        "empdest_nomecid": "RIO DE JANEIRO",
        "empdest_uf": "RJ",
        "emporig_nomecid": "CARAGUATATUBA",
        "emporig_uf": "SP",
        "emporig_nomeciduf": "CARAGUATATUBA/SP",
        "senhaagendamento": "1234",
        "numciot": "",
        "dtahrincl": "01/07/2026 08:00:00",
        "dtahrprevatual": "02/07/2026 06:00:00",
        "dtahrpreventrega": "03/07/2026 18:00:00",
        "dtahraceite": "",
        "dtahrrecusa": "",
        "dtahrcancelado": "",
        "dtaremessa": "",
        "dtahragendamento": "",
        "dtahrlimiteaceite": "01/07/2026 20:00:00",
        "totalcarga": "1",
        "totalnumvol": "10",
        "totalpeso": "26000",
        "totalvol": "80",
        "totalnumpalete": "26",
        "leilao": "f",
        "broadcast": "f",
        "pode_aceitar": "t",
        "pode_recusar": "t",
        "pode_cancelar": "f",
        "pode_alterar_data": "t",
        "pode_alterar_data_entrega": "t",
    }
    base.update(over)
    return base


@pytest.fixture(autouse=True)
def _ambiente(monkeypatch):
    reset_upsert_mirrors()
    monkeypatch.delenv("NESTLE_UPSERT_GUARD_ENABLED", raising=False)
    monkeypatch.setenv("NESTLE_OFERTAS_SNAPSHOT_TTL_SEC", "3600")
    yield
    reset_upsert_mirrors()


@pytest.fixture
def db():
    return FakeSupabase({"nestle_ofertas": OFERTAS})


def _ligar(monkeypatch, db, programacoes):
    """Injeta o cliente fake e a resposta do Galileo em robo_coleta."""
    monkeypatch.setattr(robo_coleta, "get_client", lambda: db)
    monkeypatch.setattr(robo_coleta, "registrar_log", lambda *a, **k: None)
    monkeypatch.setattr(robo_coleta, "listar_programacoes", lambda **_k: list(programacoes["atual"]))


def test_primeiro_ciclo_grava_tudo_e_segundo_ciclo_nao_grava_nada(monkeypatch, db):
    progs = {"atual": [_programacao(f"P{i}") for i in range(250)]}
    _ligar(monkeypatch, db, progs)

    robo_coleta.executar()
    gravadas_c1 = db.linhas_upsertadas("nestle_ofertas")
    assert gravadas_c1 == 250
    assert len(db.store["nestle_ofertas"]) == 250

    db.zerar_calls()
    robo_coleta.executar()
    # ── a medida que importa: ciclo idêntico ⇒ ZERO linhas reescritas ──
    assert db.linhas_upsertadas("nestle_ofertas") == 0
    assert db.upserts("nestle_ofertas") == []
    # e nem o snapshot roda de novo dentro do TTL
    assert db.selects("nestle_ofertas") == [{"table": "nestle_ofertas", "op": "select", "cols": "codprogcoleta", "rows": 0, "range": None}]


def test_so_a_linha_alterada_volta_ao_banco(monkeypatch, db):
    progs = {"atual": [_programacao(f"P{i}") for i in range(5)]}
    _ligar(monkeypatch, db, progs)
    robo_coleta.executar()

    # Nestlé remarca a doca de coleta de UMA programação.
    progs["atual"] = [_programacao(f"P{i}") for i in range(5)]
    progs["atual"][3]["dtahrprevatual"] = "05/07/2026 09:30:00"
    db.zerar_calls()
    robo_coleta.executar()

    ups = db.upserts("nestle_ofertas")
    assert len(ups) == 1
    assert ups[0]["rows"] == 1
    assert ups[0]["keys"] == ["P3"]
    assert db.store["nestle_ofertas"]["P3"]["dtahrprevatual"] == "2026-07-05T09:30:00"


def test_estado_final_identico_ao_upsert_cego(monkeypatch, db):
    """3 ciclos com mutações: a tabela resultante da guarda == a do upsert cego."""
    ciclos = [
        [_programacao("A"), _programacao("B"), _programacao("C")],
        [_programacao("A", status="ACEITA"), _programacao("B"), _programacao("C", totalpeso="27000")],
        [_programacao("A", status="ACEITA"), _programacao("B", codembarque="E-NOVO"), _programacao("D")],
    ]
    progs = {"atual": []}
    _ligar(monkeypatch, db, progs)
    for c in ciclos:
        progs["atual"] = c
        robo_coleta.executar()
    com_guarda = db.store["nestle_ofertas"]

    # Referência: mesmo pipeline, guarda desligada (kill-switch) = upsert cego.
    monkeypatch.setenv("NESTLE_UPSERT_GUARD_ENABLED", "false")
    reset_upsert_mirrors()
    cego = FakeSupabase({"nestle_ofertas": OFERTAS})
    progs2 = {"atual": []}
    _ligar(monkeypatch, cego, progs2)
    for c in ciclos:
        progs2["atual"] = c
        robo_coleta.executar()

    assert com_guarda == cego.store["nestle_ofertas"]
    # …e a guarda escreveu muito menos linhas que o cego (9 = 3 ciclos × 3 linhas).
    assert cego.escritas["nestle_ofertas"] == 9
    # 7 = A,B,C (novas) + A(status) + C(peso) + B(codembarque) + D(nova)
    assert db.escritas["nestle_ofertas"] == 7


def test_kill_switch_reproduz_comportamento_original(monkeypatch, db):
    monkeypatch.setenv("NESTLE_UPSERT_GUARD_ENABLED", "false")
    progs = {"atual": [_programacao(f"P{i}") for i in range(3)]}
    _ligar(monkeypatch, db, progs)
    robo_coleta.executar()
    db.zerar_calls()
    robo_coleta.executar()
    assert db.linhas_upsertadas("nestle_ofertas") == 3  # reescreve tudo, como antes
    assert db.selects("nestle_ofertas") == [  # e não tira snapshot nenhum
        {"table": "nestle_ofertas", "op": "select", "cols": "codprogcoleta", "rows": 0, "range": None}
    ]


def test_lote_que_falha_e_reenviado_no_ciclo_seguinte(monkeypatch, db):
    progs = {"atual": [_programacao(f"P{i}") for i in range(3)]}
    _ligar(monkeypatch, db, progs)

    def explode(tabela, rows):
        raise RuntimeError("timeout do pooler")

    db.on_upsert = explode
    robo_coleta.executar()
    assert db.store["nestle_ofertas"] == {}

    db.on_upsert = None
    db.zerar_calls()
    robo_coleta.executar()
    assert db.linhas_upsertadas("nestle_ofertas") == 3  # não confiou no lote perdido
    assert len(db.store["nestle_ofertas"]) == 3


def test_numerico_int_do_postgrest_nao_reescreve(monkeypatch, db):
    """PostgREST devolve `numeric` integral como int; o coletor manda float. Sem
    canonização isso reescreveria TODA linha com numérico a cada ciclo."""
    progs = {"atual": [_programacao("P1")]}
    _ligar(monkeypatch, db, progs)
    robo_coleta.executar()

    # força um snapshot novo (o espelho passa a vir do banco, não da própria escrita)
    monkeypatch.setenv("NESTLE_OFERTAS_SNAPSHOT_TTL_SEC", "0")
    reset_upsert_mirrors()
    db.zerar_calls()
    robo_coleta.executar()
    assert [c["cols"] for c in db.selects("nestle_ofertas")].count("codprogcoleta") == 1  # o de finalizados
    assert len(db.selects("nestle_ofertas")) == 2  # finalizados + snapshot
    assert db.linhas_upsertadas("nestle_ofertas") == 0


def test_ttl_zero_re_tira_snapshot_todo_ciclo(monkeypatch, db):
    monkeypatch.setenv("NESTLE_OFERTAS_SNAPSHOT_TTL_SEC", "0")
    progs = {"atual": [_programacao("P1")]}
    _ligar(monkeypatch, db, progs)
    robo_coleta.executar()
    db.zerar_calls()
    robo_coleta.executar()
    snapshots = [c for c in db.selects("nestle_ofertas") if c["range"] is not None]
    assert len(snapshots) == 1
    assert db.linhas_upsertadas("nestle_ofertas") == 0


def test_snapshot_pagina_acima_do_teto_de_1000(monkeypatch, db):
    """Se o snapshot truncasse no teto do PostgREST, toda linha além da 1000ª pareceria
    nova e seria reescrita a cada ciclo (o bug que a guarda existe para matar)."""
    monkeypatch.setenv("NESTLE_OFERTAS_SNAPSHOT_TTL_SEC", "0")
    progs = {"atual": [_programacao(f"P{i:05d}") for i in range(2300)]}
    _ligar(monkeypatch, db, progs)
    robo_coleta.executar()
    assert db.linhas_upsertadas("nestle_ofertas") == 2300

    db.zerar_calls()
    robo_coleta.executar()
    paginas = [c["range"] for c in db.selects("nestle_ofertas") if c["range"] is not None]
    assert paginas == [(0, 999), (1000, 1999), (2000, 2999)]
    assert db.linhas_upsertadas("nestle_ofertas") == 0
    assert len(robo_coleta.codembarques_conhecidos()) == 2300


def test_snapshot_reconcilia_divergencia_no_banco(monkeypatch, db):
    """Edição manual no banco: o próximo snapshot detecta e a linha é regravada."""
    monkeypatch.setenv("NESTLE_OFERTAS_SNAPSHOT_TTL_SEC", "0")
    progs = {"atual": [_programacao("P1")]}
    _ligar(monkeypatch, db, progs)
    robo_coleta.executar()

    db.store["nestle_ofertas"]["P1"]["empdest_nome"] = "MEXIDO A MAO"
    db.zerar_calls()
    robo_coleta.executar()
    assert db.linhas_upsertadas("nestle_ofertas") == 1
    assert db.store["nestle_ofertas"]["P1"]["empdest_nome"] == "CD RIO"


def test_falha_no_snapshot_nao_impede_gravacao(monkeypatch, db):
    """Sem espelho utilizável a guarda grava tudo (fail-safe = comportamento original)."""
    progs = {"atual": [_programacao("P1")]}
    _ligar(monkeypatch, db, progs)

    original = db.table

    def table_quebrado(nome):
        q = original(nome)
        if nome == "nestle_ofertas":
            orig_exec = q.execute

            def exec_(*a, **k):
                if q._range is not None:  # só o snapshot
                    raise RuntimeError("500 do PostgREST")
                return orig_exec(*a, **k)

            q.execute = exec_
        return q

    monkeypatch.setattr(db, "table", table_quebrado)
    robo_coleta.executar()
    assert db.linhas_upsertadas("nestle_ofertas") == 1
    assert robo_coleta.codembarques_conhecidos() is None  # espelho não semeado


def test_finalizados_continua_sem_paginacao(monkeypatch, db):
    """Regressão: paginar o select de `finalizados` congelaria 'EMBARQUE EMITIDO', que é
    status VIVO na Programação. O select tem de continuar sem .range()."""
    progs = {"atual": [_programacao("P1")]}
    _ligar(monkeypatch, db, progs)
    robo_coleta.executar()
    finalizados = [c for c in db.selects("nestle_ofertas") if c["cols"] == "codprogcoleta"]
    assert len(finalizados) == 1
    assert finalizados[0]["range"] is None


def test_colunas_comparadas_sao_exatamente_as_que_mapear_escreve():
    """Trava o ACOPLAMENTO: coluna escrita e não comparada congelaria na tela; coluna
    comparada e não escrita zeraria o efeito da guarda."""
    escritas = set(robo_coleta._mapear(_programacao("P1")))
    assert set(robo_coleta._ESPELHO.colunas_comparadas) == escritas
    assert len(escritas) == 41
    assert "created_at" not in escritas and "atualizado_em" not in escritas


def test_oferta_em_status_final_nao_e_pulada_pelo_espelho(monkeypatch, db):
    """'EMBARQUE EMITIDO' dentro do teto de 1000 continua sendo pulada pelo filtro
    original de `finalizados` (comportamento preservado) — a guarda não muda isso."""
    progs = {"atual": [_programacao("P1", status="EMBARQUE EMITIDO")]}
    _ligar(monkeypatch, db, progs)
    robo_coleta.executar()  # linha nova: entra
    assert db.store["nestle_ofertas"]["P1"]["descrstatprogcoleta"] == "EMBARQUE EMITIDO"

    progs["atual"][0]["dtahrprevatual"] = "09/07/2026 07:00:00"
    db.zerar_calls()
    robo_coleta.executar()
    assert db.linhas_upsertadas("nestle_ofertas") == 0  # pulada pelo filtro de finalizados
