"""Smoke de importação: o entry point do container tem de subir (nenhum erro de
módulo/nome no boot). Espelha o smoke import que o CI já faz em bots/angelira e
bots/unificada."""

import inspect


def test_importa_run_coleta():
    import run_coleta

    assert callable(run_coleta.main)
    assert run_coleta.INTERVAL >= 15


def test_run_coleta_passa_o_handoff_para_os_embarques():
    """Contrato entre as duas etapas: coletar_ofertas devolve o conjunto e
    atualizar_embarques aceita como kwarg (senão o handoff quebra em runtime)."""
    import run_coleta

    assert "ofertas_codembarques" in inspect.signature(run_coleta.atualizar_embarques).parameters
    fonte = inspect.getsource(run_coleta.main)
    assert "ofertas_codembarques = coletar_ofertas()" in fonte
    assert "atualizar_embarques(ofertas_codembarques=ofertas_codembarques)" in fonte
