"""Normalização de imagem para o OCR (DC-306).

A Infosimples (imagens/ocr) e o GPT-4o Vision só aceitam imagens decodificáveis
em JPG/PNG (e PDF, tratado à parte no fluxo). Fotos **HEIC/HEIF** do iPhone
(padrão da câmera) chegavam CRUS na Infosimples → código 701 "imagem base64
inválida", que aparece pro operador/motorista como **"Link inválido"** (DC-306).
O `fileToBase64` do frontend não transcodifica HEIC, então o arquivo passava
direto.

Este módulo converte a imagem para **JPEG** quando ela não está num formato
aceito (HEIC/HEIF/WebP/BMP/TIFF/…), respeitando a orientação EXIF e limitando o
tamanho. PDF e JPG/PNG passam direto (sem re-encode). É **fail-open**: qualquer
erro devolve o base64 original — o fluxo segue e a mensagem humanizada do
frontend ainda cobre o caso.
"""

from __future__ import annotations

import base64 as _b64
import io
import logging

log = logging.getLogger(__name__)

# Longest side do JPEG de saída — mantém o arquivo dentro do limite da Infosimples.
_MAX_DIM = 2200
_JPEG_QUALITY = 85
# Formatos que a Infosimples/Vision aceitam direto — não re-encodamos.
_PASSTHROUGH = {"JPEG", "PNG"}

try:
    from PIL import Image, ImageOps
    _PIL_OK = True
except Exception:  # pragma: no cover
    _PIL_OK = False

# Registra o opener de HEIC/HEIF no Pillow (iPhone). Sem pillow-heif, HEIC não
# abre e cai no fail-open (comportamento de hoje) — por isso é dependência.
try:
    import pillow_heif  # type: ignore[import-untyped]
    pillow_heif.register_heif_opener()
    _HEIF_OK = True
except Exception:  # pragma: no cover
    _HEIF_OK = False


def normalizar_para_ocr(imagem_base64: str) -> str:
    """Devolve base64 (sem prefixo `data:`) de uma imagem em formato aceito pelo
    OCR. PDF e JPEG/PNG passam direto; HEIC/HEIF/WebP/outros viram JPEG.

    Fail-open: entrada vazia, sem Pillow, PDF, base64 inválido ou erro de decode
    → devolve o `imagem_base64` recebido inalterado.
    """
    if not imagem_base64 or not _PIL_OK:
        return imagem_base64

    raw = imagem_base64
    if raw.startswith("data:"):
        _, _, raw = raw.partition(",")

    try:
        data = _b64.b64decode(raw, validate=False)
    except Exception:
        return imagem_base64

    if data[:4] == b"%PDF":
        return imagem_base64  # PDF é tratado no fluxo do OCR (extrai página/rasteriza)

    try:
        img = Image.open(io.BytesIO(data))
        fmt = (img.format or "").upper()
        if fmt in _PASSTHROUGH:
            return raw  # já é JPG/PNG — devolve sem o prefixo data:

        # HEIC/HEIF/WEBP/BMP/TIFF/… → JPEG (respeita orientação EXIF + limita tamanho).
        img = ImageOps.exif_transpose(img)
        rgb = img.convert("RGB")
        if max(rgb.size) > _MAX_DIM:
            rgb.thumbnail((_MAX_DIM, _MAX_DIM))
        buf = io.BytesIO()
        rgb.save(buf, format="JPEG", quality=_JPEG_QUALITY, optimize=True)
        out = _b64.b64encode(buf.getvalue()).decode("ascii")
        log.info("[image-normalize] %s -> JPEG (%d bytes)", fmt or "?", buf.tell())
        return out
    except Exception as exc:
        log.warning("[image-normalize] falhou (%s) — devolvendo original", exc)
        return imagem_base64
