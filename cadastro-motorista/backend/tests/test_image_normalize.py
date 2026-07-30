"""Testes da normalização de imagem pro OCR (DC-306).

PDF e JPG/PNG passam direto; HEIC/HEIF/BMP/... viram JPEG; erro → fail-open.
"""
import base64
import io

import pytest

pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

from backend import image_normalize  # noqa: E402


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _img_b64(fmt: str, size=(64, 48), color=(200, 120, 40)) -> str:
    img = Image.new("RGB", size, color)
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return _b64(buf.getvalue())


def _is_jpeg(b64: str) -> bool:
    return base64.b64decode(b64)[:2] == b"\xff\xd8"


def test_jpeg_passa_direto():
    b = _img_b64("JPEG")
    assert image_normalize.normalizar_para_ocr(b) == b


def test_png_passa_direto():
    b = _img_b64("PNG")
    assert image_normalize.normalizar_para_ocr(b) == b


def test_pdf_passa_direto():
    b = _b64(b"%PDF-1.4 conteudo de pdf")
    assert image_normalize.normalizar_para_ocr(b) == b


def test_bmp_vira_jpeg():
    b = _img_b64("BMP")
    out = image_normalize.normalizar_para_ocr(b)
    assert out != b
    assert _is_jpeg(out)


def test_data_uri_prefixo_removido():
    raw = _img_b64("JPEG")
    out = image_normalize.normalizar_para_ocr(f"data:image/jpeg;base64,{raw}")
    assert out == raw  # passthrough JPEG devolve sem o prefixo data:


def test_base64_lixo_fail_open():
    lixo = "isto-nao-e-uma-imagem-valida"
    assert image_normalize.normalizar_para_ocr(lixo) == lixo


def test_vazio_fail_open():
    assert image_normalize.normalizar_para_ocr("") == ""


def test_imagem_grande_reduz_dimensao():
    # 3000px → deve cair para <= _MAX_DIM (2200) na saída JPEG.
    b = _img_b64("BMP", size=(3000, 1000))
    out = image_normalize.normalizar_para_ocr(b)
    img = Image.open(io.BytesIO(base64.b64decode(out)))
    assert max(img.size) <= image_normalize._MAX_DIM


def test_heic_vira_jpeg():
    pytest.importorskip("pillow_heif")
    img = Image.new("RGB", (64, 48), (10, 180, 90))
    buf = io.BytesIO()
    try:
        img.save(buf, format="HEIF")
    except Exception:
        pytest.skip("encode HEIF indisponível neste ambiente")
    out = image_normalize.normalizar_para_ocr(_b64(buf.getvalue()))
    assert _is_jpeg(out)
