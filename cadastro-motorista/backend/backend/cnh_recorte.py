"""Recorte frente/verso da CNH quando a Infosimples NAO recorta.

A Infosimples recorta a CNH FISICA fotografada (devolve entradas cnh_frente /
cnh_verso no envelope). Mas a e-CNH digital (PDF do govbr) e o fallback Vision
NAO recortam -> o rascunho no SPX ficava sem a imagem da CNH e a Shopee barrava
o cadastro. Estas funcoes GARANTEM que o envelope da CNH sempre tenha frente E
verso, gerando-os do proprio arquivo enviado quando faltarem.

Estrategia (robusta, nunca "quebra"):
  - PDF 2+ paginas -> pag.1 = frente, pag.2 = verso;
  - PDF 1 pagina   -> documento inteiro nos DOIS slots (a e-CNH traz os 2 lados
                      na mesma pagina; doc identico nos dois nao e "divergente");
  - imagem (nao-PDF) -> a propria imagem nos dois slots.

Refino futuro: o recorte fino por regiao (cartao x tabela de categorias) da
e-CNH de 1 pagina precisa ser calibrado com uma amostra real de PDF.

Usado por ocr_cnh() em main.py, apos o ocr_router.
"""

from __future__ import annotations

import base64 as _b64
import logging

log = logging.getLogger(__name__)


def gerar_recortes_cnh_fallback(imagem_base64: str) -> tuple[str, str] | None:
    """Gera (frente, verso) em base64 a partir do arquivo da CNH.

    Retorna None quando nao da pra gerar (base64 invalido / sem pymupdf / erro)
    — nesse caso o caller nao injeta nada.
    """
    raw = imagem_base64
    if raw.startswith("data:"):
        _, _, raw = raw.partition(",")
    try:
        data = _b64.b64decode(raw, validate=False)
    except Exception:
        return None
    if data[:4] != b"%PDF":
        return (raw, raw)  # ja e imagem: usa a propria nos dois lados
    try:
        import fitz  # type: ignore[import-untyped]  # pymupdf
    except ImportError:
        log.warning("pymupdf indisponivel — sem fallback de recorte CNH")
        return None
    try:
        doc = fitz.open(stream=data, filetype="pdf")
        n = doc.page_count

        def _render(i: int) -> str:
            pix = doc.load_page(i).get_pixmap(dpi=150)
            return _b64.b64encode(pix.tobytes("jpeg")).decode("ascii")

        if n >= 2:
            frente, verso = _render(0), _render(1)
        else:
            img = _render(0)
            frente = verso = img  # e-CNH 1 pagina: documento inteiro nos dois slots
        doc.close()
        return (frente, verso)
    except Exception as exc:
        log.warning("Falha ao gerar recorte CNH fallback: %s", exc)
        return None


def garantir_recortes_no_envelope(envelope: dict, imagem_base64: str) -> None:
    """Garante frente E verso em `envelope['data']` (tipo=cnh_frente/cnh_verso +
    image_base64). Se a Infosimples ja recortou os dois, NAO mexe. Senao gera via
    gerar_recortes_cnh_fallback e injeta — o frontend (cnhCropBase64) sobe os
    recortes pro Supabase e o SPX passa a receber frente+verso.
    """
    if not isinstance(envelope, dict):
        return
    data = envelope.get("data")
    if not isinstance(data, list):
        data = []
        envelope["data"] = data

    def _tem(tipo: str) -> bool:
        return any(
            isinstance(e, dict)
            and e.get("tipo") == tipo
            and isinstance(e.get("image_base64"), str)
            and e["image_base64"].strip()
            for e in data
        )

    if _tem("cnh_frente") and _tem("cnh_verso"):
        return  # Infosimples ja recortou os dois

    recortes = gerar_recortes_cnh_fallback(imagem_base64)
    if not recortes:
        return
    frente, verso = recortes
    if not _tem("cnh_frente") and frente:
        data.append({"tipo": "cnh_frente", "image_base64": frente, "origem": "fallback_render"})
    if not _tem("cnh_verso") and verso:
        data.append({"tipo": "cnh_verso", "image_base64": verso, "origem": "fallback_render"})
