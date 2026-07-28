"""Unit tests para backend/cnh_recorte.py.

Cobre o fallback de recorte frente/verso da CNH usado quando a Infosimples
NAO recorta (e-CNH digital em PDF, ou fallback Vision):
  - PDF 2+ paginas   -> pag.1 = frente, pag.2 = verso (distintos);
  - PDF 1 pagina     -> documento inteiro nos DOIS slots (frente == verso);
  - imagem (nao-PDF) -> a propria imagem nos dois slots;
  - base64 invalido  -> None (caller nao injeta nada);
e a injecao no envelope (garantir_recortes_no_envelope): no-op se a Infosimples
ja recortou, senao injeta cnh_frente + cnh_verso com origem=fallback_render.
"""

from __future__ import annotations

import base64

import pytest

from backend import cnh_recorte


# ─── Fixtures de arquivo (base64) ───────────────────────────────────────────


def _pdf_base64(n_paginas: int) -> str:
    """Gera um PDF real de N paginas (via fitz) e devolve em base64."""
    fitz = pytest.importorskip("fitz")
    doc = fitz.open()
    for i in range(n_paginas):
        page = doc.new_page()
        # Texto distinto por pagina -> paginas rasterizadas ficam diferentes.
        page.insert_text((72, 72), f"PAGINA {i + 1} - lado da CNH")
    data = doc.tobytes()
    doc.close()
    return base64.b64encode(data).decode("ascii")


def _imagem_base64() -> str:
    """Bytes arbitrarios (nao-PDF) representando uma imagem ja pronta."""
    return base64.b64encode(b"\xff\xd8\xff\xe0nao-e-um-pdf-e-uma-imagem").decode("ascii")


# ─── gerar_recortes_cnh_fallback ────────────────────────────────────────────


def test_pdf_duas_paginas_gera_frente_e_verso_distintos():
    pytest.importorskip("fitz")
    frente, verso = cnh_recorte.gerar_recortes_cnh_fallback(_pdf_base64(2))
    assert frente and verso
    assert frente != verso  # p1 (frente) e p2 (verso) sao paginas diferentes
    # Saida e JPEG base64 valido.
    assert base64.b64decode(frente)[:2] == b"\xff\xd8"
    assert base64.b64decode(verso)[:2] == b"\xff\xd8"


def test_pdf_uma_pagina_usa_documento_inteiro_nos_dois_slots():
    pytest.importorskip("fitz")
    frente, verso = cnh_recorte.gerar_recortes_cnh_fallback(_pdf_base64(1))
    assert frente and verso
    assert frente == verso  # e-CNH 1 pagina: mesmo doc nos dois lados


def test_imagem_nao_pdf_usa_a_propria_imagem_nos_dois_slots():
    img = _imagem_base64()
    frente, verso = cnh_recorte.gerar_recortes_cnh_fallback(img)
    assert frente == verso == img


def test_data_uri_tem_prefixo_removido():
    img = _imagem_base64()
    frente, verso = cnh_recorte.gerar_recortes_cnh_fallback(f"data:image/jpeg;base64,{img}")
    assert frente == verso == img  # sem o prefixo "data:...,"


def test_base64_invalido_retorna_none():
    # "AB" tem padding invalido -> b64decode levanta -> retorna None.
    assert cnh_recorte.gerar_recortes_cnh_fallback("AB") is None


# ─── garantir_recortes_no_envelope ──────────────────────────────────────────


def _tem(data: list, tipo: str) -> bool:
    return any(e.get("tipo") == tipo and e.get("image_base64") for e in data)


def test_no_op_quando_infosimples_ja_recortou():
    envelope = {
        "data": [
            {"tipo": "cnh_frente", "image_base64": "AAAA"},
            {"tipo": "cnh_verso", "image_base64": "BBBB"},
        ]
    }
    antes = [dict(e) for e in envelope["data"]]
    cnh_recorte.garantir_recortes_no_envelope(envelope, _imagem_base64())
    assert envelope["data"] == antes  # nada mudou


def test_injeta_frente_e_verso_quando_faltam():
    img = _imagem_base64()
    envelope: dict = {"data": []}
    cnh_recorte.garantir_recortes_no_envelope(envelope, img)
    data = envelope["data"]
    assert _tem(data, "cnh_frente")
    assert _tem(data, "cnh_verso")
    injetados = [e for e in data if e.get("origem") == "fallback_render"]
    assert len(injetados) == 2
    assert all(e["image_base64"] == img for e in injetados)


def test_completa_apenas_o_verso_faltante():
    img = _imagem_base64()
    envelope = {"data": [{"tipo": "cnh_frente", "image_base64": "JA-EXISTE"}]}
    cnh_recorte.garantir_recortes_no_envelope(envelope, img)
    data = envelope["data"]
    frentes = [e for e in data if e.get("tipo") == "cnh_frente"]
    versos = [e for e in data if e.get("tipo") == "cnh_verso"]
    assert len(frentes) == 1  # frente existente preservada, nao duplicada
    assert frentes[0]["image_base64"] == "JA-EXISTE"
    assert len(versos) == 1
    assert versos[0]["origem"] == "fallback_render"


def test_cria_lista_data_quando_ausente():
    img = _imagem_base64()
    envelope: dict = {}  # sem chave "data"
    cnh_recorte.garantir_recortes_no_envelope(envelope, img)
    assert _tem(envelope.get("data", []), "cnh_frente")
    assert _tem(envelope.get("data", []), "cnh_verso")


def test_envelope_nao_dict_nao_quebra():
    # Nao deve levantar excecao.
    cnh_recorte.garantir_recortes_no_envelope(None, _imagem_base64())  # type: ignore[arg-type]
    cnh_recorte.garantir_recortes_no_envelope([], _imagem_base64())  # type: ignore[arg-type]


def test_base64_invalido_nao_injeta_nada():
    envelope: dict = {"data": []}
    cnh_recorte.garantir_recortes_no_envelope(envelope, "AB")
    assert envelope["data"] == []  # gerar_* devolveu None -> nada injetado
