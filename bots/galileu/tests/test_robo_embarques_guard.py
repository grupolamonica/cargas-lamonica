"""robo_embarques: guarda anti no-op do upsert + fim da varredura da nestle_ofertas.

Prova (a) que um ciclo sem mudança no Galileo não reescreve linha nenhuma apesar de
`atualizado_em` ser `now()` a cada ciclo, e (b) que o conjunto de pendentes é o MESMO
quando servido pelo espelho das ofertas (sem varrer a tabela) e quando calculado pela
varredura antiga.
"""

import pytest

from fake_supabase import FakeSupabase, TabelaSpec
from nestle import robo_coleta, robo_embarques
from nestle.change_guard import reset_upsert_mirrors
from test_robo_coleta_guard import OFERTAS, _programacao

EMBARQUES = TabelaSpec(
    pk="codembarque",
    numeric_cols=("totnumvol", "totpeso", "totvol"),
    text_cols=("codembarque", "codstatembarque", "codmot1", "codveic", "veic_id", "idcargas"),
)


def _detalhe(cod, status="EM VIAGEM", motorista="JOAO DA SILVA", placa="ABC1D23", fim=None):
    return {
        "embarque": {
            "codstatembarque": 2,
            "descrstatembarque": status,
            "dtahrstatembarque": "02/07/2026 08:00:00",
            "descrtpoper": "COLETA",
            "temocorrencia": "f",
            "codmot1": 991,
            "mot1_nome": motorista,
            "codveic": 55,
            "veic_id": 55,
            "placacarreta": placa,
            "totnumvol": "10",
            "totpeso": "26000",
            "totvol": "80",
        },
        "operacoes": [
            {"cidade": "CARAGUATATUBA", "dtahrprevini": "02/07/2026 06:00:00", "dtahrchegadaoperacao": "02/07/2026 05:50:00", "dtahrfimoperacao": "02/07/2026 07:10:00"},
            {"cidade": "RIO DE JANEIRO", "dtahrprevini": "03/07/2026 18:00:00", "dtahrchegadaoperacao": "", "dtahrfimoperacao": fim or ""},
        ],
    }


@pytest.fixture(autouse=True)
def _ambiente(monkeypatch):
    reset_upsert_mirrors()
    monkeypatch.delenv("NESTLE_UPSERT_GUARD_ENABLED", raising=False)
    monkeypatch.setenv("NESTLE_OFERTAS_SNAPSHOT_TTL_SEC", "3600")
    monkeypatch.setenv("NESTLE_EMBARQUES_SNAPSHOT_TTL_SEC", "3600")
    yield
    reset_upsert_mirrors()


@pytest.fixture
def db():
    return FakeSupabase({"nestle_ofertas": OFERTAS, "nestle_embarques": EMBARQUES})


def _ligar(monkeypatch, db, detalhes):
    monkeypatch.setattr(robo_embarques, "get_client", lambda: db)
    monkeypatch.setattr(robo_embarques, "registrar_log", lambda *a, **k: None)
    monkeypatch.setattr(robo_embarques, "get_token", lambda: "tok")
    monkeypatch.setattr(robo_embarques, "buscar_detalhe", lambda cod: detalhes["atual"][cod])


def test_ciclo_sem_mudanca_nao_reescreve_apesar_do_atualizado_em(monkeypatch, db):
    db.store["nestle_ofertas"] = {f"P{i}": {"codprogcoleta": f"P{i}", "codembarque": f"E{i}"} for i in range(4)}
    detalhes = {"atual": {f"E{i}": _detalhe(f"E{i}") for i in range(4)}}
    _ligar(monkeypatch, db, detalhes)

    robo_embarques.executar()
    assert db.linhas_upsertadas("nestle_embarques") == 4
    antes = dict(db.store["nestle_embarques"]["E0"])

    db.zerar_calls()
    robo_embarques.executar()
    # `atualizado_em` é now() a cada ciclo — se entrasse na comparação, a guarda seria
    # no-op. Nada mudou de verdade ⇒ zero reescritas.
    assert db.linhas_upsertadas("nestle_embarques") == 0
    assert db.store["nestle_embarques"]["E0"] == antes


def test_linha_que_mudou_e_regravada_com_atualizado_em_fresco(monkeypatch, db):
    db.store["nestle_ofertas"] = {"P1": {"codprogcoleta": "P1", "codembarque": "E1"}, "P2": {"codprogcoleta": "P2", "codembarque": "E2"}}
    detalhes = {"atual": {"E1": _detalhe("E1"), "E2": _detalhe("E2")}}
    _ligar(monkeypatch, db, detalhes)
    robo_embarques.executar()
    stamp_antes = db.store["nestle_embarques"]["E1"]["atualizado_em"]

    detalhes["atual"]["E1"] = _detalhe("E1", motorista="MARIA DE SOUZA")
    db.zerar_calls()
    robo_embarques.executar()
    ups = db.upserts("nestle_embarques")
    assert len(ups) == 1 and ups[0]["keys"] == ["E1"]
    assert db.store["nestle_embarques"]["E1"]["mot1_nome"] == "MARIA DE SOUZA"
    assert db.store["nestle_embarques"]["E1"]["atualizado_em"] != stamp_antes
    assert db.store["nestle_embarques"]["E2"]["mot1_nome"] == "JOAO DA SILVA"


def test_idcargas_sobrevive_ao_upsert_guardado(monkeypatch, db):
    """`idcargas` não está no payload do robô: o DO UPDATE do PostgREST só toca as
    chaves enviadas. A guarda não pode mudar isso."""
    db.store["nestle_ofertas"] = {"P1": {"codprogcoleta": "P1", "codembarque": "E1"}}
    db.store["nestle_embarques"] = {"E1": {"codembarque": "E1", "idcargas": "CARGA-77"}}
    detalhes = {"atual": {"E1": _detalhe("E1")}}
    _ligar(monkeypatch, db, detalhes)
    robo_embarques.executar()
    assert db.store["nestle_embarques"]["E1"]["idcargas"] == "CARGA-77"
    assert db.store["nestle_embarques"]["E1"]["mot1_nome"] == "JOAO DA SILVA"


def test_pendentes_do_espelho_nao_varre_nestle_ofertas(monkeypatch, db):
    db.store["nestle_ofertas"] = {f"P{i}": {"codprogcoleta": f"P{i}", "codembarque": f"E{i}"} for i in range(3)}
    db.store["nestle_embarques"] = {"E2": {"codembarque": "E2", "descrstatembarque": "FINALIZADO"}}
    detalhes = {"atual": {f"E{i}": _detalhe(f"E{i}") for i in range(3)}}
    _ligar(monkeypatch, db, detalhes)

    varrendo = robo_embarques._codembarques_pendentes(db)
    selects_varredura = len(db.selects("nestle_ofertas"))

    db.zerar_calls()
    do_espelho = robo_embarques._codembarques_pendentes(db, {"E0", "E1", "E2"})

    assert do_espelho == varrendo == ["E0", "E1"]  # mesmo conjunto, FINALIZADO fora
    assert selects_varredura == 1
    assert db.selects("nestle_ofertas") == []  # varredura eliminada


def test_pendentes_pagina_e_ordena_no_fallback(monkeypatch, db):
    db.store["nestle_ofertas"] = {f"P{i:05d}": {"codprogcoleta": f"P{i:05d}", "codembarque": f"E{i:05d}"} for i in range(2300)}
    _ligar(monkeypatch, db, {"atual": {}})
    pend = robo_embarques._codembarques_pendentes(db)
    assert len(pend) == 2300  # não trunca no teto de 1000
    ofertas_selects = db.selects("nestle_ofertas")
    assert len(ofertas_selects) == 3
    assert [c["range"] for c in ofertas_selects] == [(0, 999), (1000, 1999), (2000, 2999)]


def test_handoff_coleta_para_embarques_preserva_o_conjunto(monkeypatch, db):
    """Integração das duas etapas: o conjunto entregue por robo_coleta é o mesmo que a
    varredura devolveria — inclusive para ofertas em status final (que robo_coleta PULA
    no upsert, e que por isso NÃO podem ser derivadas de `rows`)."""
    monkeypatch.setattr(robo_coleta, "get_client", lambda: db)
    monkeypatch.setattr(robo_coleta, "registrar_log", lambda *a, **k: None)
    progs = [
        _programacao("P1", codembarque="E1"),
        _programacao("P2", status="EMBARQUE EMITIDO", codembarque="E2"),
        _programacao("P3", codembarque=""),
    ]
    monkeypatch.setattr(robo_coleta, "listar_programacoes", lambda **_k: list(progs))

    robo_coleta.executar()          # ciclo 1: semeia (P2 entra: ainda não estava no banco)
    entregue = robo_coleta.executar()  # ciclo 2: P2 já é "finalizado" e é pulada no upsert

    _ligar(monkeypatch, db, {"atual": {}})
    varrendo = robo_embarques._codembarques_pendentes(db)
    assert entregue == {"E1", "E2"}
    assert robo_embarques._codembarques_pendentes(db, entregue) == varrendo == ["E1", "E2"]


def test_colunas_comparadas_sao_as_escritas_menos_atualizado_em():
    """Trava o ACOPLAMENTO com `_mapear`: `atualizado_em` é a ÚNICA coluna escrita fora
    da comparação (é now() a cada ciclo). Qualquer outra fora congelaria na tela."""
    escritas = set(robo_embarques._mapear("E1", _detalhe("E1")))
    comparadas = set(robo_embarques._ESPELHO.colunas_comparadas)
    assert escritas - comparadas == {"atualizado_em"}
    assert comparadas - escritas == set()
    assert len(escritas) == 23
    assert "idcargas" not in escritas  # nunca enviado ⇒ preservado pelo DO UPDATE


def test_medicao_ciclo_estavel_zera_escrita_e_varredura(monkeypatch, db):
    """Medição reportável: pipeline completo (coleta + embarques), 300 ofertas / 300
    embarques, ciclo 2 idêntico ao ciclo 1."""
    monkeypatch.setattr(robo_coleta, "get_client", lambda: db)
    monkeypatch.setattr(robo_coleta, "registrar_log", lambda *a, **k: None)
    progs = [_programacao(f"P{i:04d}", codembarque=f"E{i:04d}") for i in range(300)]
    monkeypatch.setattr(robo_coleta, "listar_programacoes", lambda **_k: list(progs))
    detalhes = {"atual": {f"E{i:04d}": _detalhe(f"E{i:04d}") for i in range(300)}}
    _ligar(monkeypatch, db, detalhes)

    def ciclo():
        cods = robo_coleta.executar()
        robo_embarques.executar(ofertas_codembarques=cods)

    ciclo()
    c1 = {
        "linhas_upsertadas": db.linhas_upsertadas(),
        "selects": len(db.selects()),
        "upserts": len(db.upserts()),
    }
    db.zerar_calls()
    ciclo()
    c2 = {
        "linhas_upsertadas": db.linhas_upsertadas(),
        "selects": len(db.selects()),
        "upserts": len(db.upserts()),
    }
    print(f"\n[MEDIÇÃO] ciclo 1 = {c1}\n[MEDIÇÃO] ciclo 2 = {c2}")
    assert c1 == {"linhas_upsertadas": 600, "selects": 4, "upserts": 9}
    # ciclo estável: nenhuma linha reescrita, nenhum snapshot, nenhuma varredura de
    # nestle_ofertas — só o select de `finalizados` e o de embarques FINALIZADOS.
    assert c2 == {"linhas_upsertadas": 0, "selects": 2, "upserts": 0}
    assert db.selects("nestle_ofertas")[0]["cols"] == "codprogcoleta"
    assert len(db.selects("nestle_embarques")) == 1


def test_kill_switch_volta_a_reescrever_tudo(monkeypatch, db):
    monkeypatch.setenv("NESTLE_UPSERT_GUARD_ENABLED", "false")
    db.store["nestle_ofertas"] = {"P1": {"codprogcoleta": "P1", "codembarque": "E1"}}
    detalhes = {"atual": {"E1": _detalhe("E1")}}
    _ligar(monkeypatch, db, detalhes)
    robo_embarques.executar()
    db.zerar_calls()
    robo_embarques.executar()
    assert db.linhas_upsertadas("nestle_embarques") == 1
    assert [c for c in db.selects("nestle_embarques") if c["range"] == (0, 999) and "mot1_nome" in c["cols"]] == []


def test_lote_falhado_reenviado_no_ciclo_seguinte(monkeypatch, db):
    db.store["nestle_ofertas"] = {"P1": {"codprogcoleta": "P1", "codembarque": "E1"}}
    detalhes = {"atual": {"E1": _detalhe("E1")}}
    _ligar(monkeypatch, db, detalhes)

    def explode(tabela, rows):
        if tabela == "nestle_embarques":
            raise RuntimeError("timeout do pooler")

    db.on_upsert = explode
    robo_embarques.executar()
    assert db.store["nestle_embarques"] == {}

    db.on_upsert = None
    db.zerar_calls()
    robo_embarques.executar()
    assert db.linhas_upsertadas("nestle_embarques") == 1
    assert db.store["nestle_embarques"]["E1"]["mot1_nome"] == "JOAO DA SILVA"
