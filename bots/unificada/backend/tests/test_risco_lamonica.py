"""Testes do gerador data-driven do Gerenciador de Risco (risco_lamonica_pdf).

Gera o PDF a partir do NOSSO cadastro (dados), sem AngelLira. Valida que o
arquivo sai, é um PDF, e cobre motorista + cavalo + carretas.
"""
import sys
from pathlib import Path

import pytest

pytest.importorskip("reportlab")

_BACKEND = Path(__file__).resolve().parent.parent  # tests/ -> backend/
sys.path.insert(0, str(_BACKEND))

from unificada_robo.risco_lamonica_pdf import gerar_risco_lamonica  # noqa: E402

DADOS = {
    "protocolo": "2026-00023",
    "motorista": {
        "nome": "GILBERTO DE CARVALHO SILVA JUNIOR", "cpf": "01353210693",
        "data_nascimento": "22/12/1978", "rg": "MG10638065", "rg_uf": "MG",
        "nome_pai": "GILBERTO DE CARVALHO SILVA", "nome_mae": "ELIZABETH LOPES CARVALHO",
        "telefone_primario": "33988052885",
        "cnh": {"registro": "00602354760", "categoria": "AE",
                "codigo_seguranca": "96496665193", "validade": "2033-05-30"},
    },
    "cavalo": {"placa": "CUC9B05", "marca": "VW", "modelo": "19.320", "ano_fabricacao": 2010,
               "ano": 2010, "uf_emplacamento": "MG", "renavam": "00306091810",
               "chassi": "9534J8270AR042894", "antt": "046445458", "ultimo_licenciamento": "14/02/2026"},
    "carretas": [{"placa": "TDZ4J93", "marca": "SR", "modelo": "SRFB 3E", "ano_fabricacao": 2025,
                  "ano": 2025, "uf_emplacamento": "MG", "renavam": "01428344877",
                  "chassi": "9A9FB3154S9FF2726", "ultimo_licenciamento": "15/02/2026"}],
}


def test_gera_pdf_completo(tmp_path):
    out = tmp_path / "risco.pdf"
    res = gerar_risco_lamonica(DADOS, out)
    assert res["ok"] is True
    assert out.exists() and out.stat().st_size > 1000
    assert out.read_bytes()[:4] == b"%PDF"
    assert set(res["components"]) == {"motorista", "cavalo", "carreta_1"}


def test_so_motorista(tmp_path):
    out = tmp_path / "so_mot.pdf"
    res = gerar_risco_lamonica({"motorista": DADOS["motorista"]}, out)
    assert res["ok"] is True
    assert list(res["components"]) == ["motorista"]


def test_dados_vazios_nao_gera(tmp_path):
    res = gerar_risco_lamonica({}, tmp_path / "vazio.pdf")
    assert res["ok"] is False
    assert not (tmp_path / "vazio.pdf").exists() or (tmp_path / "vazio.pdf").stat().st_size == 0


def test_tipo_motorista_default_agregado(tmp_path):
    # Sem `tipo` no cadastro → default "Motorista Agregado" (decisão de produto).
    from unificada_robo.risco_lamonica_pdf import MOTORISTA_TIPO_DEFAULT
    assert "Agregado" in MOTORISTA_TIPO_DEFAULT
    res = gerar_risco_lamonica({"motorista": {"nome": "X", "cpf": "01353210693"}}, tmp_path / "t.pdf")
    assert res["ok"] is True
